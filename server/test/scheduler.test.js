// Scheduler: planning the queue, quiet hours, carousels, takedown and the gone hook.
// Every test runs on its own temp data dir with a seeded ctx.rand and fixed times.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempEnv, removeTempDir } from './helpers.js';
import { loadConfig } from '../lib/config.js';
import { openDb, setSetting } from '../lib/db.js';
import * as sched from '../lib/scheduler.js';

const H = 3600_000;
const D = 24 * H;
// local noon, so quiet hours (local time) are exercised the same on any machine
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

function addAcct(ctx, id, own, settings = {}, followers = 2400) {
  ctx.db.prepare('INSERT INTO accounts(id, own, handle, name, bio, pfp, settings, created_at, followers, quiet, seed) VALUES (?,?,?,?,?,?,?,?,?,0,?)')
    .run(id, own ? 1 : 0, 'h_' + id, id, '', '', JSON.stringify({ multi: 'off', ...settings }), T - 30 * D, followers, id.length * 7919 + id.charCodeAt(0));
}

function addItem(ctx, key, acct, { kind = 'photo', folder = 'f' } = {}) {
  ctx.db.prepare('INSERT INTO items(key, path, folder, kind, acct, derived, gone, added_at) VALUES (?,?,?,?,?,1,0,?)')
    .run(key, `${folder}/${key}`, folder, kind, acct, T - D);
}

function addPost(ctx, { id, acct, items, status = 'live', upAt = T - 30 * D, dueAt = null, kind = 'post', liked = 0, saved = 0, pinned = 0 }) {
  ctx.db.prepare(`INSERT INTO posts(id, acct, items, kind, caption, status, due_at, up_at, liked, saved, pinned, seed, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, acct, JSON.stringify(items), kind, 'cap', status, dueAt ?? upAt, status === 'queued' ? null : upAt, liked, saved, pinned, 42, T - 40 * D);
}

const statusOf = (ctx, id) => ctx.db.prepare('SELECT status FROM posts WHERE id = ?').get(id)?.status ?? null;
const liveCount = (ctx, acct) => ctx.db.prepare("SELECT COUNT(*) n FROM posts WHERE acct = ? AND status = 'live' AND kind <> 'story'").get(acct).n;

test('own accounts never get a due_at between 00:00 and 09:00 local over a simulated week', (t) => {
  const ctx = makeCtx(t, 3);
  setSetting(ctx.db, 'postsPerDay', 50);
  addAcct(ctx, 'a1', true);
  addAcct(ctx, 'n1', false);
  for (let i = 0; i < 400; i++) addItem(ctx, `o${i}`, 'a1');
  for (let i = 0; i < 100; i++) addItem(ctx, `x${i}`, 'n1');
  for (let now = T; now < T + 7 * D; now += H) sched.tick(ctx, now);
  const own = ctx.db.prepare("SELECT due_at FROM posts WHERE acct = 'a1'").all();
  assert.ok(own.length > 100, `expected a week of own posts, got ${own.length}`);
  const night = own.filter((p) => new Date(p.due_at).getHours() < 9);
  assert.deepEqual(night.map((p) => new Date(p.due_at).toString()), []);
});

test('each account keeps at least 9 live posts after takedown', (t) => {
  const ctx = makeCtx(t);
  addAcct(ctx, 'a1', true);
  for (let i = 0; i < 20; i++) { addItem(ctx, `k${i}`, 'a1'); addPost(ctx, { id: `p${i}`, acct: 'a1', items: [`k${i}`], upAt: T - 30 * D + i * H }); }
  sched.takedown(ctx, T);
  assert.equal(liveCount(ctx, 'a1'), 9);
});

test('liked, saved and pinned posts never come down', (t) => {
  const ctx = makeCtx(t);
  addAcct(ctx, 'a1', true);
  for (let i = 0; i < 20; i++) {
    addItem(ctx, `k${i}`, 'a1');
    // the three oldest are the ones kept, so a takedown that ignores the flags takes them first
    addPost(ctx, { id: `p${i}`, acct: 'a1', items: [`k${i}`], upAt: T - 30 * D + i * H, liked: i === 0 ? 1 : 0, saved: i === 1 ? 1 : 0, pinned: i === 2 ? 1 : 0 });
  }
  for (let round = 0; round < 3; round++) sched.takedown(ctx, T + round * D);
  assert.deepEqual(['p0', 'p1', 'p2'].map((id) => statusOf(ctx, id)), ['live', 'live', 'live']);
  assert.equal(liveCount(ctx, 'a1'), 9);
});

test('a gone item takes its live posts down and deletes its queued posts', (t) => {
  const ctx = makeCtx(t);
  addAcct(ctx, 'a1', true);
  for (const k of ['X', 'Y', 'Z']) addItem(ctx, k, 'a1');
  addPost(ctx, { id: 'live-x', acct: 'a1', items: ['X', 'Y'], upAt: T - H });
  addPost(ctx, { id: 'queued-x', acct: 'a1', items: ['X'], status: 'queued', dueAt: T + H });
  addPost(ctx, { id: 'live-z', acct: 'a1', items: ['Z'], upAt: T - H });
  addPost(ctx, { id: 'queued-z', acct: 'a1', items: ['Z'], status: 'queued', dueAt: T + H });
  sched.start(ctx);
  assert.equal(ctx.hooks.gone.length, 1);
  ctx.db.prepare("UPDATE items SET gone = 1, gone_at = ? WHERE key = 'X'").run(T);
  ctx.hooks.gone[0](['X'], T);
  assert.deepEqual(['live-x', 'queued-x', 'live-z', 'queued-z'].map((id) => statusOf(ctx, id)), ['down', null, 'live', 'queued']);
});

test('tick twice at the same now creates no duplicate posts', (t) => {
  const ctx = makeCtx(t, 5);
  addAcct(ctx, 'a1', true);
  addAcct(ctx, 'n1', false, { multi: 'some' });
  for (let i = 0; i < 30; i++) { addItem(ctx, `o${i}`, 'a1'); addItem(ctx, `x${i}`, 'n1'); }
  sched.tick(ctx, T);
  const first = ctx.db.prepare('SELECT COUNT(*) n FROM posts').get().n;
  sched.tick(ctx, T);
  const second = ctx.db.prepare('SELECT COUNT(*) n FROM posts').get().n;
  assert.ok(first > 0, 'the first tick planned posts');
  assert.equal(second, first);
});

test('carousels group only same-folder photos and videos always post alone', (t) => {
  const ctx = makeCtx(t, 9);
  setSetting(ctx.db, 'postsPerDay', 400);
  addAcct(ctx, 'n1', false, { multi: 'lots' });
  for (let i = 0; i < 30; i++) { addItem(ctx, `A${i}`, 'n1', { folder: 'A' }); addItem(ctx, `B${i}`, 'n1', { folder: 'B' }); }
  for (let i = 0; i < 6; i++) addItem(ctx, `V${i}`, 'n1', { kind: 'video', folder: 'A' });
  sched.planPosts(ctx, T);
  const items = new Map(ctx.db.prepare('SELECT key, folder, kind FROM items').all().map((i) => [i.key, i]));
  const posts = ctx.db.prepare("SELECT kind, items FROM posts WHERE kind <> 'story'").all().map((p) => ({ kind: p.kind, items: JSON.parse(p.items).map((k) => items.get(k)) }));
  const carousels = posts.filter((p) => p.items.length > 1);
  assert.ok(carousels.length >= 3, `expected carousels, got ${carousels.length}`);
  for (const c of carousels) {
    assert.equal(new Set(c.items.map((i) => i.folder)).size, 1, `mixed folders: ${c.items.map((i) => i.key)}`);
    assert.ok(c.items.every((i) => i.kind === 'photo'), 'carousel holds only photos');
    assert.ok(c.items.length <= 6);
  }
  const vids = posts.filter((p) => p.items.some((i) => i.kind === 'video'));
  assert.ok(vids.length >= 1);
  for (const v of vids) { assert.equal(v.items.length, 1); assert.equal(v.kind, 'reel'); }
});

test('lifeOf is fixed per post and stays inside the v50 ranges', () => {
  const lives = Array.from({ length: 2000 }, (_, i) => sched.lifeOf({ id: `p${i}`, seed: i * 2654435761 }));
  assert.equal(sched.lifeOf({ id: 'p7', seed: 7 * 2654435761 }), lives[7]);
  const short = lives.filter((l) => l >= 0.5 * H && l <= 8 * H).length / lives.length;
  const mid = lives.filter((l) => l >= 12 * H && l <= 72 * H).length / lives.length;
  const long = lives.filter((l) => l >= 3 * D && l <= 8 * D).length / lives.length;
  assert.ok(Math.abs(short - 0.15) < 0.04, `short ${short}`);
  assert.ok(Math.abs(mid - 0.45) < 0.05, `mid ${mid}`);
  assert.ok(Math.abs(long - 0.40) < 0.05, `long ${long}`);
  assert.ok(lives.every((l) => (l >= 0.5 * H && l <= 8 * H) || (l >= 12 * H && l <= 72 * H) || (l >= 3 * D && l <= 8 * D)));
});

const jobs = (ctx, kind) => ctx.db.prepare("SELECT ref FROM writer_jobs WHERE kind = ? AND status = 'todo'").all(kind).map((j) => j.ref);

test('isOwnQuiet is true from 00:00 to 08:59 local and nextSlot honours it for own accounts only', () => {
  const at = (h, m = 0) => new Date(2026, 9, 21, h, m).getTime();
  assert.equal(sched.isOwnQuiet(at(0)), true);
  assert.equal(sched.isOwnQuiet(at(8, 59)), true);
  assert.equal(sched.isOwnQuiet(at(9)), false);
  assert.equal(sched.isOwnQuiet(at(23, 59)), false);
  const own = { id: 'a', own: 1, seed: 11 };
  const other = { id: 'b', own: 0, seed: 11 };
  let sawNight = false;
  for (let k = 0; k < 200; k++) {
    const after = at(20) + k * 7 * 60_000;
    const t = sched.nextSlot(null, own, after, 6 * H);
    assert.ok(t > after);
    assert.equal(sched.isOwnQuiet(t), false);
    if (sched.isOwnQuiet(sched.nextSlot(null, other, after, 6 * H))) sawNight = true;
  }
  assert.ok(sawNight, 'other accounts do post at night');
});

test('publish makes the post live at its due time with targets, the fallback caption and a rewrite job', (t) => {
  const ctx = makeCtx(t);
  addAcct(ctx, 'a1', true, { own: { captions: ['fallback line'], comments: [], stories: ['story line'] } });
  addItem(ctx, 'k1', 'a1');
  addPost(ctx, { id: 'q1', acct: 'a1', items: ['k1'], status: 'queued', dueAt: T - 10 * 60_000 });
  ctx.db.prepare("UPDATE posts SET caption = '' WHERE id = 'q1'").run();
  const p = sched.publish(ctx, 'q1', T);
  assert.equal(p.status, 'live');
  assert.equal(p.up_at, T - 10 * 60_000);
  assert.equal(p.caption, 'fallback line');
  const targets = JSON.parse(p.targets);
  assert.ok(targets.likes > 0 && targets.comments >= 3);
  assert.deepEqual(jobs(ctx, 'rewrite'), ['q1']);
  assert.equal(sched.publish(ctx, 'q1', T), null, 'a live post is not published twice');
});

test('publish keeps a caption the writer already wrote and queues comments instead of a rewrite', (t) => {
  const ctx = makeCtx(t);
  addAcct(ctx, 'a1', true);
  addItem(ctx, 'k1', 'a1');
  addPost(ctx, { id: 'q1', acct: 'a1', items: ['k1'], status: 'queued', dueAt: T - 1000 });
  assert.equal(sched.publish(ctx, 'q1', T).caption, 'cap');
  assert.deepEqual(jobs(ctx, 'rewrite'), []);
  assert.deepEqual(jobs(ctx, 'comments'), ['q1']);
});

test('publishDue publishes what is due, skips the future and posts of deleted accounts', (t) => {
  const ctx = makeCtx(t);
  addAcct(ctx, 'a1', true);
  addItem(ctx, 'k1', 'a1'); addItem(ctx, 'k2', 'a1'); addItem(ctx, 'k3', 'gone-acct');
  addPost(ctx, { id: 'due', acct: 'a1', items: ['k1'], status: 'queued', dueAt: T - H });
  addPost(ctx, { id: 'later', acct: 'a1', items: ['k2'], status: 'queued', dueAt: T + H });
  addPost(ctx, { id: 'orphan', acct: 'gone-acct', items: ['k3'], status: 'queued', dueAt: T - H });
  assert.equal(sched.publishDue(ctx, T), 1);
  assert.deepEqual(['due', 'later', 'orphan'].map((id) => statusOf(ctx, id)), ['live', 'queued', 'queued']);
});

test('planPosts queues a caption job for posts due within 2 hours only', (t) => {
  const ctx = makeCtx(t, 2);
  setSetting(ctx.db, 'postsPerDay', 100);
  addAcct(ctx, 'n1', false);
  for (let i = 0; i < 40; i++) addItem(ctx, `x${i}`, 'n1');
  sched.planPosts(ctx, T);
  const queued = ctx.db.prepare("SELECT id, due_at FROM posts WHERE status = 'queued' AND caption = ''").all();
  const soon = queued.filter((p) => p.due_at <= T + 2 * H).map((p) => p.id).sort();
  assert.ok(soon.length > 0 && soon.length < queued.length);
  assert.deepEqual(jobs(ctx, 'caption').sort(), soon);
});

test('the queue reaches 48 hours ahead', (t) => {
  const ctx = makeCtx(t, 2);
  setSetting(ctx.db, 'postsPerDay', 100);
  addAcct(ctx, 'n1', false);
  for (let i = 0; i < 400; i++) addItem(ctx, `x${i}`, 'n1');
  sched.planPosts(ctx, T);
  const last = ctx.db.prepare("SELECT MAX(due_at) m FROM posts WHERE status = 'queued'").get().m;
  assert.ok(last >= T + 48 * H, `queue ends ${(last - T) / H} h ahead`);
});

test('a new account opens with a profile of older posts and none of its photos is posted twice', (t) => {
  const ctx = makeCtx(t, 4);
  addAcct(ctx, 'a1', true);
  for (let i = 0; i < 40; i++) addItem(ctx, `o${i}`, 'a1');
  sched.tick(ctx, T);
  assert.equal(liveCount(ctx, 'a1'), 9);
  const used = ctx.db.prepare("SELECT j.value v FROM posts p, json_each(p.items) j WHERE p.kind <> 'story'").all().map((r) => r.v);
  assert.equal(new Set(used).size, used.length);
});

test('stories: about a day is scheduled per account from its live posts, in the day hours for own accounts', (t) => {
  const ctx = makeCtx(t, 6);
  addAcct(ctx, 'a1', true, { storiesPerDay: 3 });
  for (let i = 0; i < 12; i++) { addItem(ctx, `k${i}`, 'a1'); addPost(ctx, { id: `p${i}`, acct: 'a1', items: [`k${i}`], upAt: T - (i + 1) * H }); }
  assert.ok(sched.planStories(ctx, T) >= 2);
  const st = ctx.db.prepare("SELECT * FROM posts WHERE kind = 'story'").all();
  assert.ok(st.every((s) => s.status === 'queued' && s.due_at < T + D + D / 3 && !sched.isOwnQuiet(s.due_at)));
  assert.equal(new Set(st.map((s) => s.items)).size, st.length, 'each story shows a different photo');
  assert.deepEqual(jobs(ctx, 'story').sort(), st.map((s) => s.id).sort());
  assert.equal(sched.planStories(ctx, T), 0, 'planning again adds nothing');
});

test('an expired story becomes a highlight about 45% of the time and is otherwise taken down', (t) => {
  const ctx = makeCtx(t);
  addAcct(ctx, 'a1', true);
  addItem(ctx, 'k', 'a1');
  for (let i = 0; i < 400; i++) addPost(ctx, { id: `s${i}`, acct: 'a1', items: ['k'], kind: 'story', upAt: T - 25 * H });
  addPost(ctx, { id: 'fresh', acct: 'a1', items: ['k'], kind: 'story', upAt: T - H });
  sched.expireStories(ctx, T);
  const hl = ctx.db.prepare('SELECT COUNT(*) n FROM posts WHERE highlight = 1').get().n;
  const down = ctx.db.prepare("SELECT COUNT(*) n FROM posts WHERE status = 'down'").get().n;
  assert.equal(hl + down, 400);
  assert.ok(Math.abs(hl / 400 - 0.45) < 0.08, `highlight rate ${hl / 400}`);
  assert.equal(statusOf(ctx, 'fresh'), 'live');
  sched.expireStories(ctx, T);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) n FROM posts WHERE highlight = 1').get().n, hl, 'decided once');
  sched.expireStories(ctx, T + 4 * D);
  assert.equal(ctx.db.prepare("SELECT COUNT(*) n FROM posts WHERE status = 'down'").get().n, 0, 'down stories are deleted after 3 days');
});

test('a taken-down post returns its photos to the pool and they go up again as a new post, sometimes on another account', (t) => {
  const ctx = makeCtx(t, 8);
  addAcct(ctx, 'a1', true);
  addAcct(ctx, 'n1', false);
  for (let i = 0; i < 200; i++) { addItem(ctx, `k${i}`, 'a1'); addPost(ctx, { id: `p${i}`, acct: 'a1', items: [`k${i}`], upAt: T - 30 * D }); }
  sched.takedown(ctx, T);
  const downKeys = ctx.db.prepare("SELECT items FROM posts WHERE status = 'down'").all().map((p) => JSON.parse(p.items)[0]);
  assert.equal(downKeys.length, 191);
  const moved = downKeys.filter((k) => ctx.db.prepare('SELECT acct FROM items WHERE key = ?').get(k).acct === 'n1').length;
  assert.ok(moved > 191 * 0.2 && moved < 191 * 0.4, `about 30% move, got ${moved}`);
  sched.planPosts(ctx, T);
  const again = ctx.db.prepare("SELECT * FROM posts WHERE status = 'queued' AND kind <> 'story'").all();
  assert.ok(again.length > 0);
  assert.ok(again.every((p) => p.cycled === 1 && !/^p\d+$/.test(p.id)));
});

test('a gone item also removes queued stories and their pending writer jobs, and a carousel holding it goes down', (t) => {
  const ctx = makeCtx(t);
  addAcct(ctx, 'a1', true);
  for (const k of ['X', 'Y']) addItem(ctx, k, 'a1');
  addPost(ctx, { id: 'car', acct: 'a1', items: ['Y', 'X'], upAt: T - H });
  addPost(ctx, { id: 'qs', acct: 'a1', items: ['X'], status: 'queued', dueAt: T + H, kind: 'story' });
  ctx.db.prepare("INSERT INTO writer_jobs(kind, ref, prio, due_at, status, tries, created_at) VALUES ('story','qs',2,0,'todo',0,0)").run();
  assert.equal(sched.onGone(ctx, ['X'], T), 2);
  assert.equal(statusOf(ctx, 'car'), 'down');
  assert.equal(statusOf(ctx, 'qs'), null);
  assert.deepEqual(jobs(ctx, 'story'), []);
});
