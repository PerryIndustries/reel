import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startTestEngine, getJson, waitFor } from './helpers.js';

async function engine(t) {
  const e = await startTestEngine();
  t.after(() => e.stop());
  return e;
}

test('startEngine on port 0 reports the real port', async (t) => {
  const e = await engine(t);
  const port = Number(new URL(e.base).port);
  assert.ok(port > 0 && port !== 11436);
});

test('GET /reel/api/status on a fresh engine returns ok and zero counts', async (t) => {
  const e = await engine(t);
  const { status, body } = await getJson(`${e.base}/reel/api/status`);
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(typeof body.version, 'string');
  assert.ok(body.version.length > 0);
  assert.deepEqual(
    { items: body.items, postable: body.postable, pending: body.pending, gone: body.gone },
    { items: 0, postable: 0, pending: 0, gone: 0 },
  );
  assert.deepEqual(body.mirror, { at: null, ok: null, msg: 'never' });
  assert.deepEqual(body.writer, { queue: 0, ollama: null });
  assert.deepEqual(body.accounts, { own: 0, other: 0 });
  assert.equal(typeof body.disk.freeGB, 'number');
  assert.ok(body.disk.freeGB > 0);
});

test('status counts items, postable, pending and gone', async (t) => {
  const e = await engine(t);
  const ins = e.ctx.db.prepare('INSERT INTO items(key, kind, derived, err, gone) VALUES (?, ?, ?, ?, ?)');
  ins.run('d1', 'photo', 1, null, 0);
  ins.run('d2', 'video', 1, null, 0);
  ins.run('p1', 'photo', 0, null, 0);
  ins.run('g1', 'photo', 1, null, 1);
  const { body } = await getJson(`${e.base}/reel/api/status`);
  assert.deepEqual(
    { items: body.items, postable: body.postable, pending: body.pending, gone: body.gone },
    { items: 3, postable: 2, pending: 1, gone: 1 },
  );
});

test('status: a derived item with an err is not postable', async (t) => {
  const e = await engine(t);
  e.ctx.db.prepare("INSERT INTO items(key, kind, derived, err) VALUES ('v1', 'video', 1, 'split')").run();
  const { body } = await getJson(`${e.base}/reel/api/status`);
  assert.equal(body.items, 1);
  assert.equal(body.postable, 0);
  assert.equal(body.pending, 0);
});

test('status reports writer queue, ollama, mirror state and account counts', async (t) => {
  const e = await engine(t);
  const db = e.ctx.db;
  db.prepare("INSERT INTO writer_jobs(kind, ref, status) VALUES ('caption', 'a', 'todo'), ('caption', 'b', 'todo'), ('caption', 'c', 'done')").run();
  db.prepare("INSERT INTO accounts(id, own) VALUES ('o1', 1), ('x1', 0), ('x2', 0)").run();
  e.ctx.state.ollamaUp = true;
  e.ctx.state.mirror = { at: 5, ok: false, msg: 'rclone missing' };
  const { body } = await getJson(`${e.base}/reel/api/status`);
  assert.deepEqual(body.writer, { queue: 2, ollama: true });
  assert.deepEqual(body.accounts, { own: 1, other: 2 });
  assert.deepEqual(body.mirror, { at: 5, ok: false, msg: 'rclone missing' });
});

test('unknown /reel/api/x answers 404 JSON', async (t) => {
  const e = await engine(t);
  const { status, headers, body } = await getJson(`${e.base}/reel/api/x`);
  assert.equal(status, 404);
  assert.match(headers.get('content-type'), /application\/json/);
  assert.equal(typeof body.error, 'string');
});

test('a throwing handler answers 500 JSON and the engine keeps serving', async (t) => {
  const e = await engine(t);
  e.ctx.router.add('GET', '/reel/api/boom', () => { throw new Error('kaboom'); });
  const r = await getJson(`${e.base}/reel/api/boom`);
  assert.equal(r.status, 500);
  assert.deepEqual(r.body, { error: 'kaboom' });
  const again = await getJson(`${e.base}/reel/api/status`);
  assert.equal(again.status, 200);
  const logText = fs.readFileSync(path.join(e.dataDir, 'logs', 'engine.log'), 'utf8');
  assert.match(logText, /kaboom/);
});

test('router passes path params, query and parsed JSON body', async (t) => {
  const e = await engine(t);
  e.ctx.router.add('PUT', '/reel/api/acct/:id', (req, res, params, query, body) => ({ params, query, body }));
  const res = await fetch(`${e.base}/reel/api/acct/a%201?stream=home`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'x' }),
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { params: { id: 'a 1' }, query: { stream: 'home' }, body: { name: 'x' } });
});

test('invalid JSON body answers 400', async (t) => {
  const e = await engine(t);
  e.ctx.router.add('POST', '/reel/api/echo', (req, res, p, q, body) => body);
  const res = await fetch(`${e.base}/reel/api/echo`, { method: 'POST', body: '{nope' });
  assert.equal(res.status, 400);
  assert.equal(typeof (await res.json()).error, 'string');
});

test('a registered tick runs and an erroring tick does not stop other ticks', async (t) => {
  const e = await engine(t);
  let good = 0;
  let bad = 0;
  e.ctx.ticks.push({ name: 'bad', everyMs: 15, fn: () => { bad++; throw new Error('tick-fail'); } });
  e.ctx.ticks.push({ name: 'good', everyMs: 15, fn: () => { good++; } });
  await waitFor(() => good >= 3 && bad >= 2);
  assert.ok(good >= 3, `good ran ${good} times`);
  assert.ok(bad >= 2, `bad ran ${bad} times`);
  const logText = fs.readFileSync(path.join(e.dataDir, 'logs', 'engine.log'), 'utf8');
  assert.match(logText, /tick-fail/);
});

test('a slow async tick never overlaps itself', async (t) => {
  const e = await engine(t);
  let running = 0;
  let maxRunning = 0;
  let runs = 0;
  e.ctx.ticks.push({
    name: 'slow', everyMs: 1, fn: async () => {
      running++; runs++; maxRunning = Math.max(maxRunning, running);
      await new Promise((r) => setTimeout(r, 40));
      running--;
    },
  });
  await waitFor(() => runs >= 3);
  assert.ok(runs >= 3);
  assert.equal(maxRunning, 1);
});
