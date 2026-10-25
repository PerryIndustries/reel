// DMs: Perry's messages, fan replies scheduled as writer dm jobs, fan openers, the dmWritten hook.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempEnv, removeTempDir, startTestEngine, getJson, postJson } from './helpers.js';
import { loadConfig } from '../lib/config.js';
import { openDb } from '../lib/db.js';
import * as dms from '../lib/dms.js';

const H = 3600_000;
const D = 24 * H;
const T = new Date(2026, 9, 20, 12, 0, 0).getTime();

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

function makeCtx(t, seed = 1) {
  const env = tempEnv();
  const cfg = loadConfig(env);
  const db = openDb(cfg.dbPath);
  const ctx = { cfg, db, log: () => {}, state: {}, ticks: [], hooks: { gone: [], dmWritten: [] }, rand: seeded(seed) };
  t.after(() => { try { db.close(); } catch { /* closed */ } removeTempDir(env.REEL_DATA); });
  return ctx;
}

function addOwn(ctx, id, settings = {}) {
  ctx.db.prepare('INSERT INTO accounts(id, own, handle, name, bio, pfp, settings, created_at, followers, quiet, seed) VALUES (?,1,?,?,?,?,?,?,?,0,?)')
    .run(id, 'h_' + id, id, '', '', JSON.stringify(settings), T - 30 * D, 2400, 12345);
}

const dmJobs = (ctx, ref) => ctx.db.prepare("SELECT * FROM writer_jobs WHERE kind = 'dm' AND ref = ? AND status = 'todo'").all(ref)
  .map((j) => ({ ...j, payload: JSON.parse(j.payload) }));

test('POST dm stores the message and schedules exactly one fan reply inside the v39 delay window', async (t) => {
  const eng = await startTestEngine();
  t.after(() => eng.stop());
  const own = (await getJson(`${eng.base}/reel/api/accounts`)).body.find((a) => a.own);
  const before = Date.now();
  const res = await postJson(`${eng.base}/reel/api/dm`, { acct: own.id, fan: 'f5', text: 'hey you' });
  const after = Date.now();
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true });
  const ref = `${own.id}|f5`;
  const mine = eng.ctx.db.prepare('SELECT from_me, text FROM dms WHERE convo = ?').all(ref);
  assert.deepEqual(mine.map((m) => ({ ...m })), [{ from_me: 1, text: 'hey you' }]);
  const jobs = dmJobs(eng.ctx, ref);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].payload.who, 'fan');
  // v39 replyDelay(fast): 15 s - 3 min (75%), 3 - 23 min (20%), 1 - 5 h (5%)
  assert.ok(jobs[0].payload.at >= before + 15_000 && jobs[0].payload.at <= after + 5 * H, `reply at +${(jobs[0].payload.at - before) / 1000}s`);
  const thread = await getJson(`${eng.base}/reel/api/dm/${encodeURIComponent(own.id)}/f5`);
  assert.equal(thread.status, 200);
  assert.deepEqual(thread.body.messages.map((m) => [m.from, m.text]), [['me', 'hey you']]);
});

test('POST dm rejects an unknown account', async (t) => {
  const eng = await startTestEngine();
  t.after(() => eng.stop());
  const res = await postJson(`${eng.base}/reel/api/dm`, { acct: 'nope', fan: 'f5', text: 'hi' });
  assert.equal(res.status, 404);
});

test('fan openers start chats on own accounts, once per opener', (t) => {
  const ctx = makeCtx(t);
  addOwn(ctx, 'a1');
  dms.fanOpeners(ctx, T);              // first look: sets the cursor, nothing backfilled
  assert.equal(ctx.db.prepare('SELECT COUNT(*) n FROM convos').get().n, 0, 'nothing backfilled');
  dms.fanOpeners(ctx, T + D);
  const convos = ctx.db.prepare("SELECT id FROM convos WHERE acct = 'a1'").all();
  assert.ok(convos.length >= 2, `a day of openers, got ${convos.length}`);
  const jobs = ctx.db.prepare("SELECT COUNT(*) n FROM writer_jobs WHERE kind = 'dm' AND status = 'todo'").get().n;
  assert.equal(jobs, convos.length);
  dms.fanOpeners(ctx, T + D);
  assert.equal(ctx.db.prepare("SELECT COUNT(*) n FROM writer_jobs WHERE kind = 'dm'").get().n, jobs);
});

test('after Perry typed in a chat the account does not auto-reply, and a written owner turn gets a fan reply', (t) => {
  const ctx = makeCtx(t);
  addOwn(ctx, 'a1', { dmAuto: 'lots' });
  dms.start(ctx);
  dms.meSend(ctx, 'a1', 'f9', 'hi there', T);
  const ref = 'a1|f9';
  ctx.db.prepare('DELETE FROM writer_jobs').run();
  // the writer wrote the fan's reply
  ctx.db.prepare('INSERT INTO dms(convo, from_me, text, at, seen) VALUES (?, 0, ?, ?, 0)').run(ref, 'omg hi', T + 60_000);
  for (const fn of ctx.hooks.dmWritten) fn(ctx, { convo: ref, who: 'fan', ats: [T + 60_000], now: T + 60_000 });
  assert.equal(dmJobs(ctx, ref).length, 0, 'Perry is in this chat: no auto reply');
  // an owner turn written in another (auto) chat gets a fan answer most of the time
  let answered = 0;
  for (let i = 0; i < 20; i++) {
    const r2 = `a1|f${100 + i}`;
    ctx.db.prepare('INSERT INTO convos(id, acct, fan, fan_handle, fan_pfp, state, next_at, unread) VALUES (?,?,?,?,?,?,?,0)').run(r2, 'a1', `f${100 + i}`, 'x', '', '{}', null);
    for (const fn of ctx.hooks.dmWritten) fn(ctx, { convo: r2, who: 'me', ats: [T], now: T });
    const j = dmJobs(ctx, r2);
    if (j.length) { answered++; assert.equal(j[0].payload.who, 'fan'); assert.ok(j[0].payload.at >= T + 30_000 && j[0].payload.at <= T + 7 * H); }
  }
  assert.ok(answered >= 15, `answered ${answered}/20`);
});

test('GET dm marks the fan messages seen, clears unread and hides turns not yet due', async (t) => {
  const eng = await startTestEngine();
  t.after(() => eng.stop());
  const own = (await getJson(`${eng.base}/reel/api/accounts`)).body.find((a) => a.own);
  const ref = `${own.id}|f7`;
  const now = Date.now();
  eng.ctx.db.prepare('INSERT INTO convos(id, acct, fan, fan_handle, fan_pfp, state, next_at, unread) VALUES (?,?,?,?,?,?,NULL,2)').run(ref, own.id, 'f7', 'zed', '', '{}');
  const ins = eng.ctx.db.prepare('INSERT INTO dms(convo, from_me, text, at, seen) VALUES (?, 0, ?, ?, 0)');
  ins.run(ref, 'one', now - 5000); ins.run(ref, 'two', now - 4000); ins.run(ref, 'later', now + 3600_000);
  const list = (await getJson(`${eng.base}/reel/api/dms`)).body;
  assert.equal(list.length, 1);
  assert.deepEqual([list[0].unread, list[0].last.text, list[0].last.from, list[0].fan.handle], [2, 'two', 'fan', 'zed']);
  const th = (await getJson(`${eng.base}/reel/api/dm/${own.id}/f7`)).body;
  assert.deepEqual(th.messages.map((m) => [m.text, m.seen]), [['one', true], ['two', true]]);
  assert.equal((await getJson(`${eng.base}/reel/api/dms`)).body[0].unread, 0);
  assert.equal(eng.ctx.db.prepare('SELECT unread FROM convos WHERE id = ?').get(ref).unread, 1, 'the hidden turn stays unread');
});

test('a written fan turn in an account-started chat gets an owner turn; a written owner turn gets a fan reply', (t) => {
  const ctx = makeCtx(t);
  addOwn(ctx, 'a1', { dmAuto: 'lots' });
  dms.start(ctx);
  const ref = 'a1|f3';
  ctx.db.prepare('INSERT INTO convos(id, acct, fan, fan_handle, fan_pfp, state, next_at, unread) VALUES (?,?,?,?,?,?,NULL,0)').run(ref, 'a1', 'f3', 'x', '', JSON.stringify({ autoStart: T }));
  ctx.db.prepare('INSERT INTO dms(convo, from_me, text, at, seen) VALUES (?, 0, ?, ?, 0)').run(ref, 'hey', T);
  for (const fn of ctx.hooks.dmWritten) fn(ctx, { convo: ref, who: 'fan', ats: [T], now: T });
  const j = dmJobs(ctx, ref);
  assert.equal(j.length, 1);
  assert.equal(j[0].payload.who, 'me');
  assert.ok(j[0].payload.at >= T + 2 * 60_000 && j[0].payload.at <= T + 3.5 * H);
});

test('due() re-enqueues a turn whose job is gone, and autoStart picks up a recent unanswered chat', (t) => {
  const ctx = makeCtx(t, 7);
  addOwn(ctx, 'a1', { dmAuto: 'lots' });
  const ref = 'a1|f4';
  ctx.db.prepare('INSERT INTO convos(id, acct, fan, fan_handle, fan_pfp, state, next_at, unread) VALUES (?,?,?,?,?,?,?,0)')
    .run(ref, 'a1', 'f4', 'x', '', JSON.stringify({ next: { who: 'fan', at: T + 5000, kind: 'open' } }), T + 5000);
  dms.due(ctx, T);
  assert.equal(dmJobs(ctx, ref).length, 1);
  dms.due(ctx, T);
  assert.equal(dmJobs(ctx, ref).length, 1, 'no duplicate');
  // an unanswered fan message gets picked up by the account sooner or later
  const r2 = 'a1|f6';
  ctx.db.prepare('INSERT INTO convos(id, acct, fan, fan_handle, fan_pfp, state, next_at, unread) VALUES (?,?,?,?,?,?,NULL,1)').run(r2, 'a1', 'f6', 'y', '', '{}');
  ctx.db.prepare('INSERT INTO dms(convo, from_me, text, at, seen) VALUES (?, 0, ?, ?, 0)').run(r2, 'hi', T - 60_000);
  for (let i = 0; i < 40 && !dmJobs(ctx, r2).length; i++) dms.due(ctx, T);
  assert.equal(dmJobs(ctx, r2)[0].payload.who, 'me');
});

test('dm reads and due skip conversations of a deleted account', (t) => {
  const ctx = makeCtx(t);
  addOwn(ctx, 'a1');
  dms.meSend(ctx, 'a1', 'f2', 'yo', T);
  ctx.db.prepare('DELETE FROM accounts WHERE id = ?').run('a1');
  ctx.db.prepare('DELETE FROM writer_jobs').run();
  dms.due(ctx, T + D);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) n FROM writer_jobs').get().n, 0);
});
