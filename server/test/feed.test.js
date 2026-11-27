// Feed streams: weighting, paging, spacing, publishing queued picks, scopes.
// Own ctx per test (no engine, no router), seeded ctx.rand and fixed times.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempEnv, removeTempDir } from './helpers.js';
import { loadConfig } from '../lib/config.js';
import { openDb } from '../lib/db.js';
import { weight, newStream, page, PAGE_SIZE, isNew } from '../lib/feed.js';

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

function addItem(ctx, key, acct, { kind = 'photo', up = 0, down = 0, seenAt = null, folder = 'f' } = {}) {
  ctx.db.prepare('INSERT INTO items(key, path, folder, kind, acct, derived, gone, added_at, up, down, seen_at) VALUES (?,?,?,?,?,1,0,?,?,?,?)')
    .run(key, `${folder}/${key}`, folder, kind, acct, T - D, up, down, seenAt);
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

test('a thumbs-down counts in a stream that was already open', (t) => {
  const ctx = makeCtx(t, 12);
  for (let a = 0; a < 30; a++) {
    addAcct(ctx, `a${a}`);
    addItem(ctx, `k${a}`, `a${a}`);
    addPost(ctx, { id: `p${a}`, acct: `a${a}`, key: `k${a}` });
  }
  let hits = 0;
  for (let s = 0; s < 60; s++) {
    ctx.db.prepare('UPDATE items SET down = 0').run();
    const id = newStream(ctx, 'explore', T);
    ctx.db.prepare("UPDATE items SET down = 3 WHERE key = 'k1'").run();
    hits += page(ctx, id, null, T).cards.filter((c) => c.id === 'p1').length;
  }
  assert.equal(hits, 0);
});

test('a card thumbed down is left out when the stream is read again from the start', (t) => {
  const ctx = makeCtx(t, 13);
  for (let a = 0; a < 12; a++) {
    addAcct(ctx, `a${a}`);
    addItem(ctx, `k${a}`, `a${a}`);
    addPost(ctx, { id: `p${a}`, acct: `a${a}`, key: `k${a}` });
  }
  const id = newStream(ctx, 'home', T);
  const first = page(ctx, id, null, T).cards;
  const gone = first[0].id;
  ctx.db.prepare('UPDATE items SET down = 1 WHERE key = ?').run(gone.replace('p', 'k'));
  const again = page(ctx, id, null, T).cards.map((c) => c.id);
  assert.ok(!again.includes(gone));
  assert.ok(again.includes(first[1].id));
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

test('a file in no post still comes up on home and reels, and goes up as a live post when picked', (t) => {
  const ctx = makeCtx(t, 21);
  addAcct(ctx, 'a0');
  addItem(ctx, 'posted', 'a0'); addPost(ctx, { id: 'pp', acct: 'a0', key: 'posted' });
  addItem(ctx, 'loose1', 'a0');
  addItem(ctx, 'loosev', 'a0', { kind: 'video' });
  ctx.db.prepare("INSERT INTO items(key, path, folder, kind, acct, derived, gone, added_at) VALUES ('st', 'stories/st', 'stories', 'photo', 'a0', 1, 0, ?)").run(T);
  const cards = drain(ctx, 'home');
  assert.equal(cards.length, 3, 'the posted file and both loose ones, never the stories-folder one');
  const live = ctx.db.prepare("SELECT kind, items FROM posts WHERE status = 'live' ORDER BY items").all();
  assert.deepEqual(live.map((p) => JSON.parse(p.items)[0]).sort(), ['loose1', 'loosev', 'posted']);
  assert.equal(live.find((p) => p.items.includes('loosev')).kind, 'reel');
  // once posted they are ordinary posts: a second stream shows each once, no duplicates
  assert.equal(drain(ctx, 'home').length, 3);
  const ctx2 = makeCtx(t, 22);
  addAcct(ctx2, 'a0');
  addItem(ctx2, 'p1', 'a0'); addItem(ctx2, 'v1', 'a0', { kind: 'video' });
  assert.deepEqual(drain(ctx2, 'reels').map((c) => c.kind), ['reel']);
});

// ---- folder spacing: never two cards in a row from the same top-level Drive folder ----

const FOLDERS = ['Assda', 'File', 'Hentai', 'new'];
const folderOf = (ctx, card) => ctx.db.prepare('SELECT folder FROM items WHERE key = ?').get(card.media[0].item).folder;

// 4 accounts x folders; folder counts are uneven (Hentai/new heavy) so a random draw would often repeat them.
function seedFolders(ctx, { kind = 'photo', postKind = 'post', counts = [3, 4, 12, 10] } = {}) {
  for (let a = 0; a < 4; a++) addAcct(ctx, `a${a}`);
  let n = 0;
  FOLDERS.forEach((folder, f) => {
    for (let i = 0; i < counts[f]; i++, n++) {
      const acct = `a${n % 4}`;
      addItem(ctx, `${folder}_${i}`, acct, { folder, kind });
      addPost(ctx, { id: `p_${folder}_${i}`, acct, key: `${folder}_${i}`, kind: postKind });
    }
  });
  return n;
}

for (const [scope, kind, postKind] of [['home', 'photo', 'post'], ['explore', 'photo', 'post'], ['reels', 'video', 'reel']]) {
  test(`a ${scope} stream never shows the same folder twice in a row while another folder has cards`, (t) => {
    const ctx = makeCtx(t, 31);
    const total = seedFolders(ctx, { kind, postKind });
    const cards = drain(ctx, scope);
    assert.equal(cards.length, total, 'every card is delivered');
    const f = cards.map((c) => folderOf(ctx, c));
    // Hentai + new hold 22 of 29 cards, the other folders 7: the rest is one-folder leftovers where a repeat is unavoidable.
    const unavoidableFrom = f.findIndex((_, i) => f.slice(i).every((x) => x === f[i]));
    for (let i = 1; i < (unavoidableFrom < 0 ? f.length : unavoidableFrom); i++) assert.notEqual(f[i], f[i - 1], `${f[i]} twice at ${i - 1},${i}: ${f.join()}`);
  });
}

test('when only one folder is left the stream still delivers every remaining card', (t) => {
  const ctx = makeCtx(t, 32);
  addAcct(ctx, 'a0');
  addAcct(ctx, 'a1');
  for (let i = 0; i < 9; i++) { addItem(ctx, `h${i}`, `a${i % 2}`, { folder: 'Hentai' }); addPost(ctx, { id: `h${i}`, acct: `a${i % 2}`, key: `h${i}` }); }
  assert.equal(drain(ctx, 'home').length, 9);
  assert.equal(drain(ctx, 'explore').length, 9);
  addItem(ctx, 'v0', 'a0', { folder: 'File' });
  addPost(ctx, { id: 'v0', acct: 'a0', key: 'v0' });
  const f = drain(ctx, 'home').map((c) => folderOf(ctx, c));
  assert.equal(f.length, 10);
  for (let i = 1; i < f.length; i++) if (f[i] === f[i - 1]) assert.ok(f.slice(i).every((x) => x === 'Hentai'), 'a repeat before the lone File card ran out');
});

test('folder spacing and the 3-card account spacing hold together', (t) => {
  const ctx = makeCtx(t, 33);
  for (let a = 0; a < 6; a++) addAcct(ctx, `a${a}`);
  const folders = ['Assda', 'File', 'Hentai'];
  for (let i = 0; i < 90; i++) {
    const acct = `a${i % 6}`;
    addItem(ctx, `k${i}`, acct, { folder: folders[Math.floor(i / 6) % 3] });
    addPost(ctx, { id: `p${i}`, acct, key: `k${i}` });
  }
  const cards = drain(ctx, 'home');
  assert.equal(cards.length, 90);
  const f = cards.map((c) => folderOf(ctx, c));
  cards.forEach((c, i) => {
    if (i >= 70) return; // tail leftovers
    if (i) assert.notEqual(f[i], f[i - 1], `folder repeat at ${i}`);
    for (let j = Math.max(0, i - 3); j < i; j++) assert.notEqual(cards[j].acct.id, c.acct.id, `account ${c.acct.id} at ${j} and ${i}`);
  });
});

test('a stream continued after cards were already emitted respects the last emitted folder', (t) => {
  for (let seed = 1; seed <= 20; seed++) {
    const ctx = makeCtx(t, seed);
    seedFolders(ctx);
    const id = newStream(ctx, 'home', T);
    // as if restored: three Hentai cards were already dealt, one Hentai/new/Assda/File candidate remains each
    const s = ctx.feedStreams.get(id);
    const dealt = s.pool.filter((c) => c.folder === 'Hentai').slice(0, 3);
    for (const c of dealt) { s.pool.splice(s.pool.indexOf(c), 1); s.emitted.push(c.id); s.recent.push(c.acct); }
    const cards = page(ctx, id, '3', T).cards;
    assert.ok(cards.length > 0);
    assert.notEqual(folderOf(ctx, cards[0]), 'Hentai', `seed ${seed}: continued into the folder that was last emitted`);
  }
});

test('a profile grid stays chronological and ignores folders', (t) => {
  const ctx = makeCtx(t, 34);
  addAcct(ctx, 'a0');
  for (let i = 0; i < 6; i++) { addItem(ctx, `k${i}`, 'a0', { folder: 'Hentai' }); addPost(ctx, { id: `p${i}`, acct: 'a0', key: `k${i}`, upAt: T - (i + 1) * H }); }
  assert.deepEqual(drain(ctx, 'acct:a0').map((c) => c.id), ['p0', 'p1', 'p2', 'p3', 'p4', 'p5']);
});

// ---- new uploads first (REEL-3) ---------------------------------------------------------------------------
// Old files: added a month ago and seen 4 days ago. New files: added an hour ago, never seen.
const firstKey = (c) => c.media[0].item;
function addOld(ctx, key, acct, { kind = 'photo', postKind = 'post', folder = 'f' } = {}) {
  ctx.db.prepare('INSERT INTO items(key, path, folder, kind, acct, derived, gone, added_at, up, down, seen_at) VALUES (?,?,?,?,?,1,0,?,0,0,?)')
    .run(key, `${folder}/${key}`, folder, kind, acct, T - 30 * D, T - 4 * D);
  addPost(ctx, { id: `p_${key}`, acct, key, kind: postKind });
}
function addNew(ctx, key, acct, { kind = 'photo', postKind = 'post', folder = 'f', post = true, addedAt = T - H } = {}) {
  ctx.db.prepare('INSERT INTO items(key, path, folder, kind, acct, derived, gone, added_at, up, down, seen_at) VALUES (?,?,?,?,?,1,0,?,0,0,NULL)')
    .run(key, `${folder}/${key}`, folder, kind, acct, addedAt);
  if (post) addPost(ctx, { id: `p_${key}`, acct, key, kind: postKind, status: 'queued', dueAt: T + 5 * H });
}
function oldAndNew(ctx, { postKind = 'post', kind = 'photo' } = {}) {
  for (let a = 0; a < 6; a++) {
    addAcct(ctx, `a${a}`);
    for (let i = 0; i < 10; i++) addOld(ctx, `old${a}_${i}`, `a${a}`, { kind, postKind });
    addNew(ctx, `new${a}`, `a${a}`, { kind, postKind });
  }
}
const firstPage = (ctx, scope, now = T) => page(ctx, newStream(ctx, scope, now), null, now).cards;

// fails if new files get the plain novelty weight (then 6 of 66 equal-ish candidates would rarely lead), per scope
for (const [scope, postKind, kind] of [['home', 'post', 'photo'], ['reels', 'reel', 'video'], ['explore', 'post', 'photo']]) {
  test(`new uploads: the never-seen files added this week lead a new ${scope} stream`, (t) => {
    const ctx = makeCtx(t, 31);
    oldAndNew(ctx, { postKind, kind });
    const cards = firstPage(ctx, scope);
    assert.deepEqual(cards.slice(0, 6).map(firstKey).sort(), ['new0', 'new1', 'new2', 'new3', 'new4', 'new5']);
    assert.ok(cards.slice(6).every((c) => firstKey(c).startsWith('old')), 'then the old ones');
  });
}

// fails if any clause of isNew is dropped: the 7-day window, never seen, never thumbed down, no added time
test('isNew: never seen, never thumbed down and added within 7 days', () => {
  assert.equal(isNew({ seen_at: null, down: 0, added_at: T - 6 * D }, T), true);
  assert.equal(isNew({ seen_at: null, down: 0, added_at: T - 8 * D }, T), false, 'older than the window');
  assert.equal(isNew({ seen_at: T - H, down: 0, added_at: T - H }, T), false, 'seen');
  assert.equal(isNew({ seen_at: null, down: 1, added_at: T - H }, T), false, 'thumbed down');
  assert.equal(isNew({ seen_at: null, down: 0, added_at: null }, T), false, 'no added time');
});

// fails if new files skip the account spacing (one account's batch of new files would come back to back)
test('new uploads: one account with a batch of new files still never shows twice within 3 cards', (t) => {
  const ctx = makeCtx(t, 32);
  for (let a = 0; a < 5; a++) { addAcct(ctx, `a${a}`); for (let i = 0; i < 8; i++) addOld(ctx, `old${a}_${i}`, `a${a}`); }
  for (let i = 0; i < 5; i++) addNew(ctx, `new${i}`, 'a0');
  const id = newStream(ctx, 'home', T);
  const cards = [...page(ctx, id, null, T).cards, ...page(ctx, id, '8', T).cards, ...page(ctx, id, '16', T).cards];
  const accts = cards.map((c) => c.acct.id);
  for (let i = 1; i < accts.length; i++) for (let k = 1; k <= 3 && i - k >= 0; k++) assert.notEqual(accts[i], accts[i - k], `card ${i}`);
  assert.deepEqual(cards.filter((c) => firstKey(c).startsWith('new')).map((c, j) => cards.indexOf(c)), [0, 4, 8, 12, 16], 'each new file as soon as spacing allows');
});

// fails if new files skip the folder rule (two cards in a row from the folder holding the batch)
test('new uploads: a batch in one folder alternates with other folders', (t) => {
  const ctx = makeCtx(t, 33);
  for (let a = 0; a < 6; a++) { addAcct(ctx, `a${a}`); for (let i = 0; i < 6; i++) addOld(ctx, `old${a}_${i}`, `a${a}`, { folder: 'other' }); }
  for (let a = 0; a < 6; a++) addNew(ctx, `new${a}`, `a${a}`, { folder: 'batch' });
  const cards = firstPage(ctx, 'home');
  const kinds = cards.map((c) => (firstKey(c).startsWith('new') ? 'N' : 'o')).join('');
  assert.equal(kinds, 'NoNoNoNo');
});

// fails if the stream keeps its built-time copy of seen_at (a file seen since would still lead)
test('new uploads: a file seen after the stream was built is no longer dealt first', (t) => {
  const ctx = makeCtx(t, 34);
  oldAndNew(ctx);
  const id = newStream(ctx, 'home', T);
  ctx.db.prepare("UPDATE items SET seen_at = ? WHERE key IN ('new0','new1','new2')").run(T);
  const cards = page(ctx, id, null, T).cards;
  assert.deepEqual(cards.slice(0, 3).map(firstKey).sort(), ['new3', 'new4', 'new5']);
  assert.ok(!cards.some((c) => ['new0', 'new1', 'new2'].includes(firstKey(c))), 'the seen ones fall back to their low weight');
});

// fails if files that arrive after a stream was built never join it (an app kept open would never get them)
test('new uploads: files that arrive while a stream is open join it, loose or queued', (t) => {
  const ctx = makeCtx(t, 35);
  for (let a = 0; a < 6; a++) { addAcct(ctx, `a${a}`); for (let i = 0; i < 10; i++) addOld(ctx, `old${a}_${i}`, `a${a}`); }
  const id = newStream(ctx, 'home', T);
  assert.ok(page(ctx, id, null, T).cards.every((c) => firstKey(c).startsWith('old')));
  addNew(ctx, 'late_loose', 'a1', { post: false, addedAt: T + 60_000 });
  addNew(ctx, 'late_queued', 'a2', { addedAt: T + 60_000 });
  const next = page(ctx, id, '8', T + 2 * 60_000).cards;
  const keys = next.map(firstKey);
  assert.ok(keys.includes('late_loose') && keys.includes('late_queued'), `both arrivals on the next page: ${keys}`);
  assert.equal(keys.filter((k) => k.startsWith('late')).length, 2);
  assert.equal(ctx.db.prepare("SELECT status FROM posts WHERE id = 'p_late_queued'").get().status, 'live', 'a queued pick is published');
});

// fails if a loose pick that the scheduler queued meanwhile is dropped (postNow refuses a file already in a post)
test('new uploads: a loose file queued after the stream was built is dealt as that post', (t) => {
  const ctx = makeCtx(t, 36);
  for (let a = 0; a < 6; a++) { addAcct(ctx, `a${a}`); for (let i = 0; i < 6; i++) addOld(ctx, `old${a}_${i}`, `a${a}`); }
  addNew(ctx, 'fresh', 'a3', { post: false });
  const id = newStream(ctx, 'home', T);
  addPost(ctx, { id: 'q_fresh', acct: 'a3', key: 'fresh', status: 'queued', dueAt: T + 3 * H });
  const cards = page(ctx, id, null, T).cards;
  assert.equal(cards[0].id, 'q_fresh');
  assert.equal(ctx.db.prepare("SELECT status FROM posts WHERE id = 'q_fresh'").get().status, 'live');
  assert.equal(ctx.db.prepare("SELECT COUNT(*) n FROM posts p, json_each(p.items) j WHERE j.value = 'fresh'").get().n, 1, 'no second post for it');
});
