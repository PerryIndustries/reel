// Writer worker: Ollama jobs (describe, caption, comments, story, dm), fallbacks, filters, style reload.
// Ollama is a local stub http server; the real one (127.0.0.1:11434) is never called.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempEnv, removeTempDir } from './helpers.js';
import { loadConfig } from '../lib/config.js';
import { openDb } from '../lib/db.js';
import { makeLog } from '../lib/log.js';
import { derivedPaths } from '../lib/derive.js';
import * as writer from '../lib/writer.js';

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'writer-style.json');
const STYLE = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
const T = Date.UTC(2026, 9, 25, 15, 0, 0);
const H = 3600_000;

function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeCtx(t, ollama) {
  const env = tempEnv();
  env.REEL_STYLE = path.join(env.REEL_DATA, 'style.json');
  fs.copyFileSync(FIXTURE, env.REEL_STYLE);
  if (ollama) env.REEL_OLLAMA = ollama;
  const cfg = loadConfig(env);
  const db = openDb(cfg.dbPath);
  const ctx = { cfg, db, log: makeLog(cfg.logDir), state: {}, ticks: [], hooks: { gone: [] }, rand: seeded(7) };
  t.after(() => { try { db.close(); } catch { /* closed */ } removeTempDir(env.REEL_DATA); });
  return ctx;
}

// A stub Ollama: answers /api/tags and /api/chat; `reply(body)` gives the assistant text.
async function stubOllama(t, { reply = () => 'hi', delay = 0 } = {}) {
  const calls = [];
  const s = { calls, active: 0, maxActive: 0 };
  const server = http.createServer(async (req, res) => {
    s.active++;
    s.maxActive = Math.max(s.maxActive, s.active);
    let raw = '';
    for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : null;
    calls.push({ url: req.url, body });
    if (delay) await new Promise((r) => setTimeout(r, delay));
    s.active--;
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/tags') return res.end(JSON.stringify({ models: [{ name: 'rp' }] }));
    res.end(JSON.stringify({ model: body.model, message: { role: 'assistant', content: reply(body) }, done: true }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  s.url = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise((r) => { server.closeAllConnections(); server.close(r); }));
  return s;
}

// A base URL nothing listens on.
async function deadUrl() {
  const server = http.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  await new Promise((r) => server.close(r));
  return url;
}

const isVision = (body) => body.model === STYLE.visionModel;
const chatCalls = (s) => s.calls.filter((c) => c.url === '/api/chat');

function addAcct(ctx, id, settings = {}) {
  ctx.db.prepare('INSERT INTO accounts(id, own, handle, name, settings, created_at, followers, seed) VALUES (?, 1, ?, ?, ?, ?, 100, 1)')
    .run(id, `h_${id}`, `N ${id}`, JSON.stringify(settings), T);
  return ctx.db.prepare('SELECT * FROM accounts WHERE id = ?').get(id);
}

function addItem(ctx, key, { kind = 'photo', desc = null, file = true } = {}) {
  ctx.db.prepare('INSERT INTO items(key, kind, derived, gone, desc) VALUES (?, ?, 1, 0, ?)').run(key, kind, desc);
  if (file) {
    const p = derivedPaths(ctx, key);
    fs.mkdirSync(p.dir, { recursive: true });
    fs.writeFileSync(kind === 'video' ? p.poster : p.full, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  }
}

function addPost(ctx, id, acct, items, { kind = 'post', upAt = T, seed = 12345, status = 'live' } = {}) {
  ctx.db.prepare('INSERT INTO posts(id, acct, items, kind, status, due_at, up_at, seed, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, acct, JSON.stringify(items), kind, status, upAt, upAt, seed, T);
}

const job = (ctx, id) => ctx.db.prepare('SELECT * FROM writer_jobs WHERE id = ?').get(id);
const post = (ctx, id) => ctx.db.prepare('SELECT * FROM posts WHERE id = ?').get(id);

test('with Ollama down a job goes back to todo with tries 1, due in 5 min, and ollamaUp is false', async (t) => {
  const ctx = makeCtx(t, await deadUrl());
  addAcct(ctx, 'a1');
  addItem(ctx, 'i1', { desc: '' });
  addPost(ctx, 'p1', 'a1', ['i1']);
  const id = writer.enqueue(ctx, 'caption', 'p1', 1, T, null);
  await writer.runJob(ctx, job(ctx, id), T);
  const j = job(ctx, id);
  assert.equal(j.status, 'todo');
  assert.equal(j.tries, 1);
  assert.equal(j.due_at, T + 5 * 60_000);
  assert.equal(ctx.state.ollamaUp, false);
  assert.equal(post(ctx, 'p1').caption, null);
});

test('a job that keeps failing is marked failed on its 5th try', async (t) => {
  const ctx = makeCtx(t, await deadUrl());
  addAcct(ctx, 'a1');
  addItem(ctx, 'i1', { desc: '' });
  addPost(ctx, 'p1', 'a1', ['i1']);
  const id = writer.enqueue(ctx, 'caption', 'p1', 1, T, null);
  const statuses = [];
  for (let k = 0; k < 5; k++) {
    await writer.runJob(ctx, job(ctx, id), T + k * 10 * 60_000);
    statuses.push(job(ctx, id).status);
  }
  assert.deepEqual(statuses, ['todo', 'todo', 'todo', 'todo', 'failed']);
});

test('fallbackText(caption) returns a line from the style pool while Ollama is down', async (t) => {
  const ctx = makeCtx(t, await deadUrl());
  const a = addAcct(ctx, 'a1');
  for (let k = 0; k < 20; k++) {
    const line = writer.fallbackText(ctx, 'caption', a);
    assert.ok(STYLE.pool.captions.includes(line), `not a pool caption: ${line}`);
  }
  assert.ok(STYLE.pool.comments.includes(writer.fallbackText(ctx, 'comment', a)));
  assert.ok(STYLE.pool.stories.includes(writer.fallbackText(ctx, 'story', a)));
  assert.ok(STYLE.pool.dmOwner.includes(writer.fallbackText(ctx, 'dmOwner', a)));
});

test("an account's own lines replace the default pool in fallbackText", async (t) => {
  const ctx = makeCtx(t, await deadUrl());
  const mine = ['my own one ^^', 'second own line'];
  const a = addAcct(ctx, 'a1', { own: { captions: mine, comments: [], stories: [] } });
  const seen = new Set();
  for (let k = 0; k < 60; k++) seen.add(writer.fallbackText(ctx, 'caption', a));
  assert.deepEqual([...seen].sort(), [...mine].sort());
  // the account id works as well as the row
  assert.ok(mine.includes(writer.fallbackText(ctx, 'caption', 'a1')));
  // a part with no own lines still uses the pool
  assert.ok(STYLE.pool.comments.includes(writer.fallbackText(ctx, 'comment', a)));
});

test('two ticks while a request is in flight: the stub never sees more than 1 concurrent request', async (t) => {
  const s = await stubOllama(t, { delay: 150, reply: () => 'cozy ♡' });
  const ctx = makeCtx(t, s.url);
  addAcct(ctx, 'a1');
  addItem(ctx, 'i1', { desc: '' });
  addItem(ctx, 'i2', { desc: '' });
  addPost(ctx, 'p1', 'a1', ['i1']);
  addPost(ctx, 'p2', 'a1', ['i2']);
  writer.enqueue(ctx, 'caption', 'p1', 1, T, null);
  writer.enqueue(ctx, 'caption', 'p2', 1, T, null);
  await Promise.all([writer.tick(ctx, T), writer.tick(ctx, T)]);
  assert.equal(s.maxActive, 1);
  assert.equal(chatCalls(s).length, 1);
  await writer.tick(ctx, T);
  assert.equal(s.maxActive, 1);
  assert.equal(ctx.db.prepare("SELECT count(*) AS n FROM writer_jobs WHERE status = 'done'").get().n, 2);
});

test('jobs run by prio, then due_at', async (t) => {
  const s = await stubOllama(t, { reply: () => 'gm' });
  const ctx = makeCtx(t, s.url);
  addAcct(ctx, 'a1');
  for (const k of ['1', '2', '3']) { addItem(ctx, `i${k}`, { desc: '' }); addPost(ctx, `p${k}`, 'a1', [`i${k}`]); }
  writer.enqueue(ctx, 'story', 'p1', 3, T - 3 * H, null);
  writer.enqueue(ctx, 'caption', 'p2', 1, T - H, null);
  writer.enqueue(ctx, 'caption', 'p3', 1, T - 2 * H, null);
  const done = () => ctx.db.prepare("SELECT kind || ':' || ref AS r FROM writer_jobs WHERE status = 'done' ORDER BY id").all().map((r) => r.r);
  const order = [];
  for (let k = 0; k < 3; k++) {
    const before = new Set(done());
    await writer.tick(ctx, T);
    order.push(...done().filter((r) => !before.has(r)));
  }
  assert.deepEqual(order, ['caption:p3', 'caption:p2', 'story:p1']);
});

test('enqueue dedups on (kind, ref) while todo, keeping the lower prio and earlier due_at', async (t) => {
  const ctx = makeCtx(t, await deadUrl());
  const a = writer.enqueue(ctx, 'caption', 'p1', 5, T + H, null);
  const b = writer.enqueue(ctx, 'caption', 'p1', 1, T, null);
  assert.equal(a, b);
  const rows = ctx.db.prepare("SELECT * FROM writer_jobs WHERE kind = 'caption' AND ref = 'p1'").all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].prio, 1);
  assert.equal(rows[0].due_at, T);
});

test('a caption job writes posts.caption and the photo is described once per item', async (t) => {
  const s = await stubOllama(t, { reply: (b) => (isVision(b) ? 'A woman in a red dress on a balcony, smiling.' : 'red today ^^') });
  const ctx = makeCtx(t, s.url);
  addAcct(ctx, 'a1');
  addItem(ctx, 'dir#i1');
  addPost(ctx, 'p1', 'a1', ['dir#i1']);
  addPost(ctx, 'p2', 'a1', ['dir#i1'], { seed: 999 });
  await writer.runJob(ctx, job(ctx, writer.enqueue(ctx, 'caption', 'p1', 1, T, null)), T);
  assert.equal(post(ctx, 'p1').caption, 'red today ^^');
  assert.equal(ctx.db.prepare("SELECT desc FROM items WHERE key = 'dir#i1'").get().desc, 'A woman in a red dress on a balcony, smiling.');
  const vision1 = chatCalls(s).filter((c) => isVision(c.body));
  assert.equal(vision1.length, 1);
  assert.equal(vision1[0].body.messages.at(-1).images.length, 1);
  await writer.runJob(ctx, job(ctx, writer.enqueue(ctx, 'caption', 'p2', 1, T, null)), T);
  assert.equal(post(ctx, 'p2').caption, 'red today ^^');
  assert.equal(chatCalls(s).filter((c) => isVision(c.body)).length, 1);
  // the caption prompt carried the description and the hard content lines
  const capCall = chatCalls(s).filter((c) => !isVision(c.body)).at(-1).body;
  assert.match(capCall.messages[1].content, /red dress on a balcony/);
  assert.match(capCall.messages[0].content, /Everyone in it is an adult/);
  assert.equal(capCall.stream, false);
  assert.equal(capCall.keep_alive, '30m');
  assert.equal(capCall.options.num_ctx, 4096);
  assert.equal(capCall.model, 'rp');
});

test('a refused description is cached as empty and the caption is written blind', async (t) => {
  const s = await stubOllama(t, { reply: (b) => (isVision(b) ? "I'm sorry, I can't describe this image." : 'hehe') });
  const ctx = makeCtx(t, s.url);
  addAcct(ctx, 'a1');
  addItem(ctx, 'i1');
  addPost(ctx, 'p1', 'a1', ['i1']);
  await writer.runJob(ctx, job(ctx, writer.enqueue(ctx, 'caption', 'p1', 1, T, null)), T);
  assert.equal(ctx.db.prepare("SELECT desc FROM items WHERE key = 'i1'").get().desc, '');
  assert.equal(post(ctx, 'p1').caption, 'hehe');
  assert.match(chatCalls(s).at(-1).body.messages[1].content, /can't see the photo/);
});

test('a caption saying "As an AI" is dropped', async (t) => {
  const s = await stubOllama(t, { reply: () => 'As an AI, I cannot write that.' });
  const ctx = makeCtx(t, s.url);
  addAcct(ctx, 'a1');
  addItem(ctx, 'i1', { desc: '' });
  addPost(ctx, 'p1', 'a1', ['i1']);
  const id = writer.enqueue(ctx, 'caption', 'p1', 1, T, null);
  await writer.runJob(ctx, job(ctx, id), T);
  assert.equal(job(ctx, id).status, 'done');
  assert.equal(post(ctx, 'p1').caption, null);
});

test('a caption in a man\'s voice is dropped', async (t) => {
  const s = await stubOllama(t, { reply: () => 'show me your tits' });
  const ctx = makeCtx(t, s.url);
  addAcct(ctx, 'a1');
  addItem(ctx, 'i1', { desc: '' });
  addPost(ctx, 'p1', 'a1', ['i1']);
  await writer.runJob(ctx, job(ctx, writer.enqueue(ctx, 'caption', 'p1', 1, T, null)), T);
  assert.equal(post(ctx, 'p1').caption, null);
});

test('a refused comments reply leaves none of its lines, only pool comments', async (t) => {
  const s = await stubOllama(t, { reply: () => "I can't write explicit sexual content. I can help with:\n- Other creative writing projects that don't involve explicit sexual content\n- Flirty but tasteful compliments" });
  const ctx = makeCtx(t, s.url);
  addAcct(ctx, 'a1');
  addItem(ctx, 'i1', { desc: 'a mirror selfie' });
  addPost(ctx, 'p1', 'a1', ['i1'], { upAt: T - H });
  await writer.runJob(ctx, job(ctx, writer.enqueue(ctx, 'comments', 'p1', 2, T, null)), T);
  const texts = ctx.db.prepare("SELECT text FROM comments WHERE post = 'p1'").all().map((r) => r.text);
  assert.ok(texts.length > 0);
  for (const x of texts) assert.ok(STYLE.pool.comments.includes(x), `not a pool line: ${x}`);
});

test('refused: model refusals yes, real comments no', () => {
  assert.equal(writer.refused("I can't write explicit sexual content."), true);
  assert.equal(writer.refused('- Other creative writing projects'), true);
  assert.equal(writer.refused("I'm not able to help with that request"), true);
  assert.equal(writer.refused("Bro, I can't even form words right now"), false);
  assert.equal(writer.refused('sorry but you are unreal'), false);
});

test('wrongVoice: her lines in a comment and a man\'s lines in a caption', () => {
  assert.equal(writer.wrongVoice('my pussy is soaked', 'comments'), true);
  assert.equal(writer.wrongVoice('so pretty 😍', 'comments'), false);
  assert.equal(writer.wrongVoice('spread your legs', 'caption'), true);
  assert.equal(writer.wrongVoice('do u like it from the back', 'caption'), false);
  assert.equal(writer.wrongVoice('cute schoolgirl fit', 'caption'), true);
});

test('a comments job writes about perPost comments, half written and half pool, timed in the 48 h after up_at', async (t) => {
  const s = await stubOllama(t, { reply: () => 'so pretty 😍\nmarry me\nmy pussy is wet\nAs an AI I love this\nstop it rn\nhow is this real' });
  const ctx = makeCtx(t, s.url);
  addAcct(ctx, 'a1');
  addItem(ctx, 'i1', { desc: 'a mirror selfie' });
  const up = T - 10 * H;
  addPost(ctx, 'p1', 'a1', ['i1'], { upAt: up });
  ctx.db.prepare("UPDATE posts SET caption = 'fit check' WHERE id = 'p1'").run();
  await writer.runJob(ctx, job(ctx, writer.enqueue(ctx, 'comments', 'p1', 2, T, null)), T);
  const rows = ctx.db.prepare("SELECT * FROM comments WHERE post = 'p1'").all();
  assert.equal(rows.length, STYLE.comments.perPost);
  const texts = rows.map((r) => r.text);
  assert.ok(!texts.includes('my pussy is wet'));
  assert.ok(!texts.some((x) => /\bAI\b/.test(x)));
  const written = texts.filter((x) => ['so pretty 😍', 'marry me', 'stop it rn', 'how is this real'].includes(x));
  const pooled = texts.filter((x) => STYLE.pool.comments.includes(x));
  assert.equal(written.length, 4);
  assert.equal(pooled.length, 4);
  for (const r of rows) {
    assert.ok(r.at >= up && r.at <= up + 48 * H, `comment at ${r.at - up}`);
    assert.ok(r.author && typeof r.author === 'string');
    assert.equal(r.mine, 0);
  }
  // the first comments land minutes after the post went up, not after the job ran
  assert.ok(Math.min(...rows.map((r) => r.at)) <= up + 10 * 60_000);
  // deterministic from the post seed
  const again = makeCtx(t, s.url);
  addAcct(again, 'a1');
  addItem(again, 'i1', { desc: 'a mirror selfie' });
  addPost(again, 'p1', 'a1', ['i1'], { upAt: up });
  await writer.runJob(again, job(again, writer.enqueue(again, 'comments', 'p1', 2, T + 7 * H, null)), T + 7 * H);
  const times = (c) => c.db.prepare("SELECT at FROM comments WHERE post = 'p1' ORDER BY at").all().map((r) => r.at);
  assert.deepEqual(times(again), times(ctx));
});

test('a story job writes posts.story_text', async (t) => {
  const s = await stubOllama(t, { reply: () => 'bored, entertain me :3' });
  const ctx = makeCtx(t, s.url);
  addAcct(ctx, 'a1');
  addItem(ctx, 'i1', { desc: '' });
  addPost(ctx, 's1', 'a1', ['i1'], { kind: 'story' });
  await writer.runJob(ctx, job(ctx, writer.enqueue(ctx, 'story', 's1', 3, T, null)), T);
  assert.equal(post(ctx, 's1').story_text, 'bored, entertain me :3');
});

test('a dm job from the fan writes fan messages into the convo', async (t) => {
  const s = await stubOllama(t, { reply: () => JSON.stringify({ messages: ['@h_a1: hey cutie 👀', 'u up?'] }) });
  const ctx = makeCtx(t, s.url);
  addAcct(ctx, 'a1');
  ctx.db.prepare("INSERT INTO convos(id, acct, fan, fan_handle, fan_pfp, state, unread) VALUES ('a1|f7', 'a1', 'f7', 'kuro44', '', '{}', 0)").run();
  ctx.db.prepare("INSERT INTO dms(convo, from_me, text, at, seen) VALUES ('a1|f7', 1, 'hiii', ?, 1)").run(T - H);
  await writer.runJob(ctx, job(ctx, writer.enqueue(ctx, 'dm', 'a1|f7', 4, T, { who: 'fan', at: T })), T);
  const rows = ctx.db.prepare("SELECT * FROM dms WHERE convo = 'a1|f7' AND from_me = 0 ORDER BY at").all();
  assert.deepEqual(rows.map((r) => r.text), ['hey cutie 👀', 'u up?']);
  assert.equal(rows[0].at, T);
  assert.ok(rows[1].at > T);
  const sys = chatCalls(s).at(-1).body;
  assert.match(sys.messages[1].content, /@h_a1: hiii/);
  assert.ok(sys.format);
});

test('the style is reloaded only when its ver changes', async (t) => {
  const ctx = makeCtx(t, await deadUrl());
  const s1 = writer.loadStyle(ctx);
  writer.loadStyle(ctx);
  writer.loadStyle(ctx);
  assert.equal(ctx.state.styleLoads, 1);
  assert.equal(s1.caption.voice, STYLE.caption.voice);
  // same ver, other content: kept as it was
  fs.writeFileSync(ctx.cfg.stylePath, JSON.stringify({ ...STYLE, caption: { ...STYLE.caption, voice: 'CHANGED BUT SAME VER' } }));
  assert.equal(writer.loadStyle(ctx).caption.voice, STYLE.caption.voice);
  assert.equal(ctx.state.styleLoads, 1);
  fs.writeFileSync(ctx.cfg.stylePath, JSON.stringify({ ...STYLE, ver: 1000, caption: { ...STYLE.caption, voice: 'NEW VOICE' } }));
  assert.equal(writer.loadStyle(ctx).caption.voice, 'NEW VOICE');
  assert.equal(ctx.state.styleLoads, 2);
});

test('a new style ver queues a rewrite of every live post', async (t) => {
  const ctx = makeCtx(t, await deadUrl());
  addAcct(ctx, 'a1');
  addPost(ctx, 'p1', 'a1', ['i1'], { upAt: T - 2 * H });
  addPost(ctx, 'p2', 'a1', ['i2'], { upAt: T - H });
  addPost(ctx, 'q1', 'a1', ['i3'], { status: 'queued' });
  writer.loadStyle(ctx, T);
  assert.equal(ctx.db.prepare("SELECT count(*) AS n FROM writer_jobs WHERE kind = 'rewrite'").get().n, 0);
  fs.writeFileSync(ctx.cfg.stylePath, JSON.stringify({ ...STYLE, ver: 1000 }));
  writer.loadStyle(ctx, T);
  const jobs = ctx.db.prepare("SELECT ref, prio FROM writer_jobs WHERE kind = 'rewrite' AND status = 'todo' ORDER BY due_at").all();
  assert.deepEqual(jobs.map((j) => j.ref), ['p2', 'p1']);
  assert.ok(jobs.every((j) => j.prio === 5));
});

test('pingOllama sets ollamaUp from /api/tags', async (t) => {
  const s = await stubOllama(t);
  const ctx = makeCtx(t, s.url);
  assert.equal(await writer.pingOllama(ctx), true);
  assert.equal(ctx.state.ollamaUp, true);
  ctx.cfg.ollama = await deadUrl();
  assert.equal(await writer.pingOllama(ctx), false);
  assert.equal(ctx.state.ollamaUp, false);
});

test('a comments job with Ollama down leaves perPost pool comments and a todo rewrite job', async (t) => {
  const ctx = makeCtx(t, await deadUrl());
  addAcct(ctx, 'a1');
  addItem(ctx, 'i1', { desc: '' });
  const up = T - 2 * H;
  addPost(ctx, 'p1', 'a1', ['i1'], { upAt: up });
  const id = writer.enqueue(ctx, 'comments', 'p1', 2, T, null);
  await writer.runJob(ctx, job(ctx, id), T);
  assert.notEqual(job(ctx, id).status, 'failed');
  assert.equal(job(ctx, id).status, 'done');
  const rows = ctx.db.prepare("SELECT * FROM comments WHERE post = 'p1'").all();
  assert.equal(rows.length, STYLE.comments.perPost);
  assert.ok(rows.every((r) => STYLE.pool.comments.includes(r.text) && r.mine === 0 && r.author && r.at >= up && r.at <= up + 48 * H));
  assert.equal(new Set(rows.map((r) => r.text)).size, Math.min(rows.length, new Set(STYLE.pool.comments).size));
  const rw = ctx.db.prepare("SELECT * FROM writer_jobs WHERE kind = 'rewrite' AND ref = 'p1'").all();
  assert.equal(rw.length, 1);
  assert.equal(rw[0].status, 'todo');
  assert.equal(rw[0].prio, 5);
  // a second run does not pile on more comments
  await writer.runJob(ctx, job(ctx, writer.enqueue(ctx, 'comments', 'p1', 2, T, null)), T + 1);
  assert.equal(ctx.db.prepare("SELECT count(*) AS n FROM comments WHERE post = 'p1'").get().n, STYLE.comments.perPost);
});

test('a rewrite job with Ollama down on a post without comments also leaves pool comments and a later rewrite', async (t) => {
  const ctx = makeCtx(t, await deadUrl());
  addAcct(ctx, 'a1');
  addItem(ctx, 'i1', { desc: '' });
  addPost(ctx, 'p1', 'a1', ['i1'], { upAt: T - H });
  const id = writer.enqueue(ctx, 'rewrite', 'p1', 4, T, null);
  await writer.runJob(ctx, job(ctx, id), T);
  assert.equal(job(ctx, id).status, 'done');
  assert.equal(ctx.db.prepare("SELECT count(*) AS n FROM comments WHERE post = 'p1'").get().n, STYLE.comments.perPost);
  const rw = ctx.db.prepare("SELECT * FROM writer_jobs WHERE kind = 'rewrite' AND ref = 'p1' AND status = 'todo'").all();
  assert.equal(rw.length, 1);
});

test('fallback comments use the account own comment lines instead of the pool', async (t) => {
  const ctx = makeCtx(t, await deadUrl());
  const mine = ['own comment one', 'own comment two', 'own comment three'];
  addAcct(ctx, 'a1', { own: { captions: [], comments: mine, stories: [] } });
  addItem(ctx, 'i1', { desc: '' });
  addPost(ctx, 'p1', 'a1', ['i1']);
  await writer.runJob(ctx, job(ctx, writer.enqueue(ctx, 'comments', 'p1', 2, T, null)), T);
  const texts = ctx.db.prepare("SELECT text FROM comments WHERE post = 'p1'").all().map((r) => r.text);
  assert.equal(texts.length, STYLE.comments.perPost);
  assert.ok(texts.every((x) => mine.includes(x)), texts.join('|'));
  assert.deepEqual([...new Set(texts)].sort(), [...mine].sort());
});

test('the rewrite with Ollama up replaces fallback comments but keeps a mine=1 comment', async (t) => {
  const s = await stubOllama(t, { reply: () => 'so pretty 😍\nmarry me\nstop it rn\nhow is this real' });
  const ctx = makeCtx(t, s.url);
  addAcct(ctx, 'a1');
  addItem(ctx, 'i1', { desc: 'a selfie' });
  addPost(ctx, 'p1', 'a1', ['i1']);
  const fb = ['fallback list comment A', 'fallback list comment B'];
  const ins = ctx.db.prepare('INSERT INTO comments(post, author, author_pfp, text, at, owner_reply, mine) VALUES (?, ?, ?, ?, ?, ?, ?)');
  for (const x of fb) ins.run('p1', 'fan', '', x, T, 0, 0);
  ins.run('p1', 'me', '', 'my own comment', T, 0, 1);
  ins.run('p1', 'h_a1', '', 'thanks guys', T, 1, 0);
  await writer.runJob(ctx, job(ctx, writer.enqueue(ctx, 'rewrite', 'p1', 5, T, null)), T);
  const texts = ctx.db.prepare("SELECT text FROM comments WHERE post = 'p1'").all().map((r) => r.text);
  assert.ok(texts.includes('my own comment'));
  assert.ok(texts.includes('thanks guys'));
  assert.ok(!texts.some((x) => fb.includes(x)));
  assert.ok(texts.includes('marry me'));
});
