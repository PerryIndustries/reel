// Feed streams: weighting, paging, spacing, publishing queued picks, scopes.
// Own ctx per test (no engine, no router), seeded ctx.rand and fixed times.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempEnv, removeTempDir } from './helpers.js';
import { loadConfig } from '../lib/config.js';
import { openDb } from '../lib/db.js';
import { weight, newStream, page, PAGE_SIZE } from '../lib/feed.js';

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

function addAcct(ctx, id, own = false) {
  ctx.db.prepare('INSERT INTO accounts(id, own, handle, name, bio, pfp, settings, created_at, followers, quiet, seed) VALUES (?,?,?,?,?,?,?,?,?,0,?)')
    .run(id, own ? 1 : 0, 'h_' + id, id, '', '', '{}', T - 30 * D, 2400, id.length * 7919 + id.charCodeAt(0));
}

function addItem(ctx, key, acct, { kind = 'photo', up = 0, down = 0, seenAt = null } = {}) {
  ctx.db.prepare('INSERT INTO items(key, path, folder, kind, acct, derived, gone, added_at, up, down, seen_at) VALUES (?,?,?,?,?,1,0,?,?,?,?)')
    .run(key, `f/${key}`, 'f', kind, acct, T - D, up, down, seenAt);
}

let seq = 0;
function addPost(ctx, { id, acct, key, status = 'live', kind = 'post', upAt = T - 5 * H, dueAt = null, pinned = 0 }) {
  ctx.db.prepare(`INSERT INTO posts(id, acct, items, kind, caption, status, due_at, up_at, liked, saved, pinned, seed, created_at)
    VALUES (?,?,?,?,?,?,?,?,0,0,?,?,?)`)
    .run(id, acct, JSON.stringify([key]), kind, 'cap', status, dueAt ?? upAt, status === 'queued' ? null : upAt, pinned, 1000 + seq++, T - 40 * D);
}

function seedGrid(ctx, accts, per, { kind = 'post' } = {}) {
  for (let a = 0; a < accts; a++) {
    addAcct(ctx, `a${a}`);
    for (let i = 0; i < per; i++) {
      addItem(ctx, `k${a}_${i}`, `a${a}`);
      addPost(ctx, { id: `p${a}_${i}`, acct: `a${a}`, key: `k${a}_${i}`, kind });
    }
  }
}

function drain(ctx, scope, now = T) {
  const id = newStream(ctx, scope, now);
  const cards = [];
  let cursor = null;
  for (let guard = 0; guard < 100; guard++) {
    const pg = page(ctx, id, cursor, now);
    assert.equal(pg.stream, id);
    assert.ok(pg.cards.length <= PAGE_SIZE);
    cards.push(...pg.cards);
    cursor = pg.cursor;
    if (cursor == null) return cards;
  }
  throw new Error('stream never ended');
}

test('weight: never seen is 1, recently seen is low, votes scale it', () => {
  assert.equal(weight({ seen_at: null, up: 0, down: 0 }, T), 1);
  assert.equal(weight({ seen_at: T, up: 0, down: 0 }, T), 0);
  const day = weight({ seen_at: T - D, up: 0, down: 0 }, T);
  assert.ok(Math.abs(day - (1 - Math.exp(-1 / 3))) < 1e-9);
  assert.ok(weight({ seen_at: T - D, up: 2, down: 0 }, T) > day * 3, 'voted up comes back sooner and counts more');
  assert.ok(Math.abs(weight({ seen_at: null, up: 3, down: 0 }, T) - 4 ** 0.7) < 1e-9);
  assert.ok(Math.abs(weight({ seen_at: null, up: 0, down: 2 }, T) - 0.0004) < 1e-9);
  assert.ok(weight({ seen_at: null, up: 0, down: 1 }, T) <= 0.02, 'one thumbs-down is at least 50x less likely than a neutral photo');
});

test('a home stream never repeats a card and never shows the same account within 3', (t) => {
  const ctx = makeCtx(t, 7);
  seedGrid(ctx, 6, 20);
  const cards = drain(ctx, 'home');
  assert.equal(cards.length, 120, 'every post is delivered, the stream does not end early');
  assert.equal(new Set(cards.map((c) => c.id)).size, cards.length, 'a card repeated');
  assert.equal(new Set(cards.map((c) => c.media[0].item)).size, cards.length, 'a first item repeated');
  cards.forEach((c, i) => {
    if (i >= 100) return; // the tail may be one account's leftovers, where spacing is impossible
    for (let j = Math.max(0, i - 3); j < i; j++) {
      assert.notEqual(cards[j].acct.id, c.acct.id, `account ${c.acct.id} at ${j} and ${i}`);
    }
  });
});

test('with two accounts every post is delivered and accounts alternate while both have posts', (t) => {
  const ctx = makeCtx(t, 13);
  addAcct(ctx, 'a0');
  addAcct(ctx, 'a1');
  for (let i = 0; i < 6; i++) { addItem(ctx, `x${i}`, 'a0'); addPost(ctx, { id: `x${i}`, acct: 'a0', key: `x${i}` }); }
  for (let i = 0; i < 4; i++) { addItem(ctx, `y${i}`, 'a1'); addPost(ctx, { id: `y${i}`, acct: 'a1', key: `y${i}` }); }
  const cards = drain(ctx, 'home');
  assert.equal(cards.length, 10);
  const ids = cards.map((c) => c.acct.id);
  for (let i = 1; i < 8; i++) assert.notEqual(ids[i], ids[i - 1], `repeat at ${i}: ${ids.join()}`);
  const one = makeCtx(t, 14);
  seedGrid(one, 1, 5);
  assert.equal(drain(one, 'explore').length, 5);
});

test('taste up raises an item\'s pick frequency in the first page and down lowers it', (t) => {
  const ctx = makeCtx(t, 11);
  for (let a = 0; a < 30; a++) {
    addAcct(ctx, `a${a}`);
    addItem(ctx, `k${a}`, `a${a}`, { up: a === 0 ? 3 : 0, down: a === 1 ? 2 : 0 });
    addPost(ctx, { id: `p${a}`, acct: `a${a}`, key: `k${a}` });
  }
  const hits = {};
  for (let s = 0; s < 200; s++) {
    const id = newStream(ctx, 'home', T);
    for (const c of page(ctx, id, null, T).cards) hits[c.id] = (hits[c.id] || 0) + 1;
  }
  const neutral = [];
  for (let a = 2; a < 30; a++) neutral.push(hits[`p${a}`] || 0);
  const avg = neutral.reduce((x, y) => x + y, 0) / neutral.length;
  assert.ok((hits.p0 || 0) > avg * 1.5, `up ${hits.p0} vs neutral ${avg}`);
  assert.ok((hits.p1 || 0) < avg * 0.5, `down ${hits.p1 || 0} vs neutral ${avg}`);
});

test('a queued post picked into a stream becomes live', (t) => {
  const ctx = makeCtx(t, 3);
  addAcct(ctx, 'a0');
  addItem(ctx, 'k0', 'a0');
  addPost(ctx, { id: 'q0', acct: 'a0', key: 'k0', status: 'queued', dueAt: T - 2 * H });
  const pg = page(ctx, newStream(ctx, 'home', T), null, T);
  assert.deepEqual(pg.cards.map((c) => c.id), ['q0']);
  const row = ctx.db.prepare('SELECT status, up_at FROM posts WHERE id = ?').get('q0');
  assert.equal(row.status, 'live');
  assert.equal(row.up_at, T - 2 * H);
  assert.equal(pg.cards[0].at, T - 2 * H);
});

test('a reels stream contains only reels', (t) => {
  const ctx = makeCtx(t, 5);
  seedGrid(ctx, 3, 4);
  for (let i = 0; i < 5; i++) {
    addItem(ctx, `v${i}`, 'a0', { kind: 'video' });
    addPost(ctx, { id: `r${i}`, acct: `a${i % 3}`, key: `v${i}`, kind: 'reel' });
  }
  const cards = drain(ctx, 'reels');
  assert.equal(cards.length, 5);
  assert.ok(cards.every((c) => c.kind === 'reel'));
});

test('stories never enter a stream, and posts of a deleted account are skipped', (t) => {
  const ctx = makeCtx(t, 9);
  seedGrid(ctx, 4, 3);
  addItem(ctx, 's0', 'a0');
  addPost(ctx, { id: 'story0', acct: 'a0', key: 's0', kind: 'story' });
  ctx.db.prepare('DELETE FROM accounts WHERE id = ?').run('a1');
  const cards = drain(ctx, 'explore');
  assert.ok(cards.length > 0);
  assert.ok(!cards.some((c) => c.id === 'story0'));
  assert.ok(!cards.some((c) => c.acct.id === 'a1'));
});

test('one card per first item: two posts of the same item show once', (t) => {
  const ctx = makeCtx(t, 2);
  addAcct(ctx, 'a0');
  addAcct(ctx, 'a1');
  addItem(ctx, 'k', 'a0');
  addPost(ctx, { id: 'p1', acct: 'a0', key: 'k' });
  addPost(ctx, { id: 'p2', acct: 'a1', key: 'k' });
  assert.equal(drain(ctx, 'home').length, 1);
});

test('a profile stream is that account newest first, pinned posts left to the pinned strip', (t) => {
  const ctx = makeCtx(t, 4);
  addAcct(ctx, 'a0');
  addAcct(ctx, 'a1');
  for (let i = 0; i < 12; i++) {
    addItem(ctx, `k${i}`, 'a0');
    addPost(ctx, { id: `p${i}`, acct: 'a0', key: `k${i}`, upAt: T - (i + 1) * H, pinned: i === 3 ? 1 : 0 });
  }
  addItem(ctx, 'o', 'a1');
  addPost(ctx, { id: 'other', acct: 'a1', key: 'o' });
  const cards = drain(ctx, 'acct:a0');
  assert.deepEqual(cards.map((c) => c.id), ['p0', 'p1', 'p2', 'p4', 'p5', 'p6', 'p7', 'p8', 'p9', 'p10', 'p11']);
});

test('a profile stream shows only live posts and never publishes the queue', (t) => {
  const ctx = makeCtx(t, 8);
  addAcct(ctx, 'a0');
  for (let i = 0; i < 3; i++) { addItem(ctx, `l${i}`, 'a0'); addPost(ctx, { id: `l${i}`, acct: 'a0', key: `l${i}`, upAt: T - (i + 1) * H }); }
  for (let i = 0; i < 2; i++) { addItem(ctx, `q${i}`, 'a0'); addPost(ctx, { id: `q${i}`, acct: 'a0', key: `q${i}`, status: 'queued', dueAt: T - H }); }
  assert.deepEqual(drain(ctx, 'acct:a0').map((c) => c.id), ['l0', 'l1', 'l2']);
  assert.equal(ctx.db.prepare("SELECT COUNT(*) n FROM posts WHERE status = 'queued'").get().n, 2);
});

test('a stream id only continues in its own scope', (t) => {
  const ctx = makeCtx(t, 10);
  seedGrid(ctx, 4, 3);
  const home = newStream(ctx, 'home', T);
  assert.ok(page(ctx, home, null, T, 'home'));
  assert.equal(page(ctx, home, null, T, 'reels'), null);
});

test('paging: a cursor re-read returns the same cards, an unknown stream is null, the end is null', (t) => {
  const ctx = makeCtx(t, 6);
  seedGrid(ctx, 6, 5);
  const id = newStream(ctx, 'home', T);
  const first = page(ctx, id, null, T);
  assert.equal(first.cards.length, PAGE_SIZE);
  assert.ok(first.cursor);
  const second = page(ctx, id, first.cursor, T);
  assert.deepEqual(page(ctx, id, first.cursor, T).cards.map((c) => c.id), second.cards.map((c) => c.id));
  assert.deepEqual(page(ctx, id, null, T).cards.map((c) => c.id), first.cards.map((c) => c.id));
  assert.equal(page(ctx, 'nope', null, T), null);
  const empty = makeCtx(t, 1);
  const pg = page(empty, newStream(empty, 'home', T), null, T);
  assert.deepEqual(pg, { stream: pg.stream, cursor: null, cards: [] });
});
