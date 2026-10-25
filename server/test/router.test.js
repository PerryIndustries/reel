import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestEngine, getJson, postJson } from './helpers.js';

test('a handler that returns undefined owns the response: nothing else is written', async (t) => {
  const e = await startTestEngine();
  t.after(() => e.stop());
  e.ctx.router.add('GET', '/reel/api/late', (req, res) => {
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('mine');
    }, 50);
  });
  const r = await fetch(`${e.base}/reel/api/late`);
  assert.equal(r.status, 200);
  assert.equal(await r.text(), 'mine');
});

test('a returned promise value is awaited and sent as 200 JSON', async (t) => {
  const e = await startTestEngine();
  t.after(() => e.stop());
  e.ctx.router.add('GET', '/reel/api/p', async () => ({ v: 1 }));
  const r = await getJson(`${e.base}/reel/api/p`);
  assert.deepEqual([r.status, r.body], [200, { v: 1 }]);
});

test('a body over 10 MB gets a 413 JSON reply', async (t) => {
  const e = await startTestEngine();
  t.after(() => e.stop());
  e.ctx.router.add('POST', '/reel/api/big', () => ({ ok: true }));
  const r = await postJson(`${e.base}/reel/api/big`, { pad: 'x'.repeat(11 * 1024 * 1024) });
  assert.equal(r.status, 413);
  assert.equal(r.body.error, 'body too large');
});
