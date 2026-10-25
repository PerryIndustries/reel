import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../lib/db.js';
import {
  makeOther, makeOwn, otherTarget, grow, dealNew, dealWeights, quietCheck, summary, rng,
} from '../lib/accounts.js';
import { startTestEngine, getJson, postJson } from './helpers.js';

const DAY = 86400_000;
const HOUR = 3600_000;
const NOW = Date.UTC(2026, 9, 25, 12);

function unit(seed = 1) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-acct-'));
  const db = openDb(path.join(dir, 'reel.db'));
  const ctx = { db, rand: rng(seed), log: () => {}, ticks: [] };
  return { ctx, db, done() { db.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

function addItems(db, n, over = {}) {
  const ins = db.prepare('INSERT INTO items(key, kind, derived, err, gone, acct) VALUES (?,?,?,?,?,?)');
  for (let i = 0; i < n; i++) {
    ins.run(`${over.prefix ?? 'k'}${i}`, 'photo', over.derived ?? 1, over.err ?? null, over.gone ?? 0, null);
  }
}

function shares(db) {
  const rows = db.prepare('SELECT a.own own, COUNT(*) n FROM items i JOIN accounts a ON a.id = i.acct GROUP BY a.own').all();
  const total = rows.reduce((s, r) => s + r.n, 0);
  return { total, own: (rows.find((r) => r.own === 1)?.n ?? 0) / total };
}

test('every postable item gets exactly one acct after dealNew, non-postable items none', () => {
  const u = unit();
  try {
    makeOwn(u.ctx, {}, NOW);
    for (let i = 0; i < 6; i++) makeOther(u.ctx, 100 + i, NOW - 30 * DAY);
    addItems(u.db, 50);
    addItems(u.db, 5, { prefix: 'u', derived: 0 });
    addItems(u.db, 5, { prefix: 'e', err: 'split' });
    addItems(u.db, 5, { prefix: 'g', gone: 1 });
    dealNew(u.ctx, NOW);
    const ids = new Set(u.db.prepare('SELECT id FROM accounts').all().map((a) => a.id));
    const dealt = u.db.prepare('SELECT key, acct FROM items WHERE key LIKE ?').all('k%');
    assert.equal(dealt.length, 50);
    assert.ok(dealt.every((r) => ids.has(r.acct)));
    assert.equal(u.db.prepare('SELECT COUNT(*) n FROM items WHERE acct IS NOT NULL AND key NOT LIKE ?').get('k%').n, 0);
    const before = u.db.prepare('SELECT key, acct FROM items ORDER BY key').all();
    dealNew(u.ctx, NOW);
    assert.deepEqual(u.db.prepare('SELECT key, acct FROM items ORDER BY key').all(), before, 'dealt once, never reshuffled');
  } finally { u.done(); }
});

test('ownShare 0.4 over 1000 items gives own accounts 0.4 +/- 0.05', () => {
  const u = unit(7);
  try {
    makeOwn(u.ctx, {}, NOW);
    makeOwn(u.ctx, {}, NOW);
    for (let i = 0; i < 8; i++) makeOther(u.ctx, 200 + i, NOW - 30 * DAY);
    addItems(u.db, 1000);
    dealNew(u.ctx, NOW);
    const s = shares(u.db);
    assert.equal(s.total, 1000);
    assert.ok(Math.abs(s.own - 0.4) <= 0.05, `own share ${s.own}`);
  } finally { u.done(); }
});

test('an other account made within 7 days gets about twice the share of an older one', () => {
  const u = unit(11);
  try {
    makeOwn(u.ctx, {}, NOW);
    u.db.prepare("INSERT INTO settings(k, v) VALUES ('ownShare', '0')").run();
    const oldA = makeOther(u.ctx, 301, NOW - 30 * DAY);
    const newA = makeOther(u.ctx, 302, NOW - 2 * DAY);
    const w = Object.fromEntries(dealWeights(u.ctx, NOW).map((x) => [x.id, x.w]));
    assert.ok(Math.abs(w[newA.id] / w[oldA.id] - 2) < 1e-9);
    addItems(u.db, 3000);
    dealNew(u.ctx, NOW);
    const n = (id) => u.db.prepare('SELECT COUNT(*) n FROM items WHERE acct = ?').get(id).n;
    const ratio = n(newA.id) / n(oldA.id);
    assert.ok(ratio > 1.7 && ratio < 2.4, `ratio ${ratio}`);
    // at 7 days exactly the bonus is over
    const w8 = Object.fromEntries(dealWeights(u.ctx, NOW + 6 * DAY).map((x) => [x.id, x.w]));
    assert.ok(Math.abs(w8[newA.id] / w8[oldA.id] - 1) < 1e-9);
  } finally { u.done(); }
});

test('otherTarget grows with the pool and clamps at 6 and maxOthers', () => {
  const s = { itemsPerOther: 40, maxOthers: 80 };
  assert.equal(otherTarget(0, s), 6);
  assert.equal(otherTarget(100, s), 6);
  assert.equal(otherTarget(400, s), 10);
  assert.equal(otherTarget(401, s), 11);
  assert.equal(otherTarget(1_000_000, s), 80);
  assert.equal(otherTarget(1_000_000, { itemsPerOther: 40, maxOthers: 12 }), 12);
});

test('grow creates at most one account per window even far below target, and 6 at first start', () => {
  const u = unit(3);
  try {
    makeOwn(u.ctx, {}, NOW);
    addItems(u.db, 4000); // target 100 -> clamped 80
    const others = () => u.db.prepare('SELECT COUNT(*) n FROM accounts WHERE own = 0').get().n;
    assert.equal(grow(u.ctx, NOW), 6, 'first start tops up to 6');
    assert.equal(others(), 6);
    assert.equal(grow(u.ctx, NOW + 1000), 0, 'same window: nothing');
    assert.equal(others(), 6);
    const next = JSON.parse(u.db.prepare("SELECT v FROM settings WHERE k = 'nextGrowAt'").get().v);
    assert.ok(next >= NOW + 6 * HOUR && next <= NOW + 30 * HOUR, `window ${(next - NOW) / HOUR}h`);
    assert.equal(grow(u.ctx, NOW + 5 * HOUR), 0);
    assert.equal(grow(u.ctx, NOW + 31 * HOUR), 1, 'window over: exactly one');
    assert.equal(others(), 7);
    assert.equal(grow(u.ctx, NOW + 31 * HOUR), 0);
    assert.equal(others(), 7);
  } finally { u.done(); }
});

test('makeOther is deterministic from its seed and obeys the pfp rules', () => {
  const a = unit(1);
  const b = unit(2);
  try {
    const x = makeOther(a.ctx, 4242, NOW);
    const y = makeOther(b.ctx, 4242, NOW);
    for (const k of ['id', 'handle', 'name', 'bio', 'pfp', 'followers']) assert.equal(x[k], y[k], k);
    assert.equal(x.own, 0);
    assert.ok(x.followers >= 200 && x.followers <= 40000);
    assert.equal(x.created_at, NOW);
    assert.deepEqual(summary(x), { id: x.id, handle: x.handle, name: x.name, pfp: x.pfp, own: false });
    const idx = JSON.parse(fs.readFileSync(new URL('../../docs/pfp/index.json', import.meta.url), 'utf8'));
    const allowed = new Set(['', ...idx.anime, ...idx.photos.map((p) => 'pfp/' + p)]);
    for (let i = 0; i < 60; i++) assert.ok(allowed.has(makeOther(a.ctx, 9000 + i, NOW).pfp));
    const handles = a.db.prepare('SELECT handle FROM accounts').all().map((r) => r.handle);
    assert.equal(new Set(handles).size, handles.length, 'handles unique');
  } finally { a.done(); b.done(); }
});

test('quietCheck silences others with no items after 14 days', () => {
  const u = unit(5);
  try {
    makeOwn(u.ctx, {}, NOW);
    const fresh = makeOther(u.ctx, 1, NOW - 3 * DAY);
    const old = makeOther(u.ctx, 2, NOW - 20 * DAY);
    const busy = makeOther(u.ctx, 3, NOW - 20 * DAY);
    addItems(u.db, 1);
    u.db.prepare('UPDATE items SET acct = ?').run(busy.id);
    assert.equal(quietCheck(u.ctx, NOW), 1);
    const q = (id) => u.db.prepare('SELECT quiet FROM accounts WHERE id = ?').get(id).quiet;
    assert.deepEqual([q(fresh.id), q(old.id), q(busy.id)], [0, 1, 0]);
    assert.ok(!dealWeights(u.ctx, NOW).some((w) => w.id === old.id));
  } finally { u.done(); }
});

test('deleting an account re-deals its items to the remaining accounts and drops its queued posts', async () => {
  const eng = await startTestEngine();
  try {
    const { ctx } = eng;
    addItems(ctx.db, 200);
    const accts = (await getJson(`${eng.base}/reel/api/accounts`)).body;
    const victim = accts.find((a) => !a.own);
    ctx.db.prepare('UPDATE items SET acct = ? WHERE key IN (SELECT key FROM items LIMIT 30)').run(victim.id);
    ctx.db.prepare("INSERT INTO posts(id, acct, items, kind, status) VALUES ('p1', ?, '[]', 'post', 'queued')").run(victim.id);
    ctx.db.prepare("INSERT INTO posts(id, acct, items, kind, status) VALUES ('p2', ?, '[]', 'post', 'live')").run(victim.id);
    const res = await postJson(`${eng.base}/reel/api/acct/${victim.id}`, undefined, 'DELETE');
    assert.equal(res.status, 200);
    assert.equal(ctx.db.prepare('SELECT COUNT(*) n FROM accounts WHERE id = ?').get(victim.id).n, 0);
    assert.equal(ctx.db.prepare('SELECT COUNT(*) n FROM items WHERE acct = ?').get(victim.id).n, 0);
    assert.equal(ctx.db.prepare('SELECT COUNT(*) n FROM items WHERE acct IS NULL').get().n, 0, 'all re-dealt');
    assert.equal(ctx.db.prepare("SELECT COUNT(*) n FROM posts WHERE id = 'p1'").get().n, 0);
    assert.equal(ctx.db.prepare("SELECT COUNT(*) n FROM posts WHERE id = 'p2'").get().n, 1);
    assert.equal((await postJson(`${eng.base}/reel/api/acct/nope`, undefined, 'DELETE')).status, 404);
  } finally { await eng.stop(); }
});

test('POST acct refuses a 6th own account with 409; the last own account cannot be deleted', async () => {
  const eng = await startTestEngine();
  try {
    const list = async () => (await getJson(`${eng.base}/reel/api/accounts`)).body;
    assert.equal((await list()).filter((a) => a.own).length, 1, 'start makes one own account');
    for (let i = 0; i < 4; i++) {
      const r = await postJson(`${eng.base}/reel/api/acct`, { handle: `mine${i}`, followers: 1200 });
      assert.equal(r.status, 200);
      assert.equal(r.body.own, true);
      assert.equal(r.body.followers, 1200);
    }
    const six = await postJson(`${eng.base}/reel/api/acct`, { handle: 'mine5' });
    assert.equal(six.status, 409);
    assert.deepEqual(six.body, { error: '5 own accounts max' });
    const own = (await list()).filter((a) => a.own);
    assert.equal(own.length, 5);
    for (const a of own.slice(0, 4)) assert.equal((await postJson(`${eng.base}/reel/api/acct/${a.id}`, undefined, 'DELETE')).status, 200);
    assert.equal((await postJson(`${eng.base}/reel/api/acct/${own[4].id}`, undefined, 'DELETE')).status, 409);
  } finally { await eng.stop(); }
});

test('PUT acct merges fields and settings; PUT settings merges per key and validates', async () => {
  const eng = await startTestEngine();
  try {
    const own = (await getJson(`${eng.base}/reel/api/accounts`)).body.find((a) => a.own);
    const r = await postJson(`${eng.base}/reel/api/acct/${own.id}`, { bio: 'hi', settings: { directions: { caption: 'x' }, heat: 'explicit' } }, 'PUT');
    assert.equal(r.status, 200);
    assert.equal(r.body.bio, 'hi');
    assert.equal(r.body.handle, own.handle);
    assert.equal(r.body.settings.directions.caption, 'x');
    assert.equal(r.body.settings.directions.story, '');
    assert.equal(r.body.settings.heat, 'explicit');
    assert.equal(r.body.settings.pronouns, own.settings.pronouns);
    const other = (await getJson(`${eng.base}/reel/api/accounts`)).body.find((a) => !a.own);
    assert.equal((await postJson(`${eng.base}/reel/api/acct/${own.id}`, { handle: other.handle }, 'PUT')).status, 409);

    const s0 = (await getJson(`${eng.base}/reel/api/settings`)).body;
    assert.equal(s0.ownShare, 0.4);
    const s1 = await postJson(`${eng.base}/reel/api/settings`, { ownShare: 0.5, extraRoots: ['a:b'] }, 'PUT');
    assert.equal(s1.status, 200);
    assert.deepEqual(s1.body, { ...s0, ownShare: 0.5, extraRoots: ['a:b'] });
    assert.equal((await postJson(`${eng.base}/reel/api/settings`, { ownShare: 3 }, 'PUT')).status, 400);
  } finally { await eng.stop(); }
});
