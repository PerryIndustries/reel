import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, getSetting, setSetting } from '../lib/db.js';
import { rng, start as startAccounts } from '../lib/accounts.js';
import { importPhone } from '../lib/importer.js';
import { startTestEngine, postJson, getJson } from './helpers.js';

const NOW = Date.UTC(2026, 9, 25, 12);

function unit(seed = 1) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-imp-'));
  const db = openDb(path.join(dir, 'reel.db'));
  const ctx = { db, rand: rng(seed), log: () => {}, ticks: [] };
  return { ctx, db, done() { db.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

function addItem(db, key, driveId) {
  db.prepare('INSERT INTO items(key, drive_id, kind, derived, gone) VALUES (?,?,?,1,0)').run(key, driveId, 'photo');
}

// Shapes copied from the old app: S.accounts (DEFAULT_ACCOUNT + per-account fields), S.settings,
// misc kv (taste {key:{up,down}}, postSeen {"f:"+key: ms}, convos {acctId:{fanIndex:{msgs,...}}}) and
// the kept flags of S.posts.
function phoneBody() {
  return {
    accounts: [
      { id: 'a_1', handle: 'mia.fit', name: 'Mia', bio: 'gym and coffee', link: '', avatar: 'url:pfp/r002.jpg', followers: 2400,
        following: 312, capDirection: 'short and teasing', comDirection: 'hype comments', storyDirection: 'one word',
        dmFanDirection: 'shy fans', dmMeDirection: 'cocky', myCaptions: 'line one\n\nline two\n', myComments: 'nice\nwow',
        myStoryTexts: 'gm', pronouns: 'she', heat: 'explicit', multi: 'lots', dmAuto: 'some' },
      { id: 'a_2', handle: 'zed', name: 'Zed', bio: '', avatar: 'd_somephoto', followers: 860, pronouns: 'he', heat: 'suggestive', multi: 'off' },
      { id: 'n_x', npc: true, handle: 'otherone', name: 'Other', followers: 9000, capDirection: 'npc direction' },
    ],
    settings: { seed: 7, dailyFresh: 25, clientId: 'abc', folderId: 'fld', ignored: [] },
    secret: { key: 'SECRET-KEY-123', url: 'https://x.ts.net' },
    media: { d_abc: 'BLOBBYTES' },
    misc: {
      taste: { d_f1: { up: 2, down: 0 }, d_f2: { up: 0, down: 1 }, 'pc:/x/y.jpg': { up: 1, down: 0 }, d_missing: { up: 1, down: 0 }, 'url:pfp/q.jpg': { up: 1, down: 0 } },
      postSeen: { 'f:d_f1': NOW - 1000, p_post1: NOW - 5, 'f:pcs:foo/bar.jpg': NOW, 'f:d_nope': NOW },
      convos: { a_1: { 3: { msgs: [{ text: 'hey you', at: NOW - 60000 }, { me: true, text: 'hi', at: NOW - 30000 }], note: 'likes lifting' } } },
      kept: [{ id: 'p_1', keys: ['d_f1'], liked: true }, { id: 'p_4', keys: ['d_f3'], saved: true }, { id: 'p_2', keys: ['d_f2'], saved: true }, { id: 'p_3', keys: ['d_gone'], pinned: true }],
    },
  };
}

function seed(db) {
  addItem(db, 'a/f1.jpg', 'f1');
  addItem(db, 'a/f2.jpg', 'f2');
  addItem(db, 'a/f3.jpg', 'f3');
}

test('import maps own accounts, directions and taste', () => {
  const u = unit();
  try {
    seed(u.db);
    const out = importPhone(u.ctx, phoneBody(), NOW);
    const own = u.db.prepare('SELECT * FROM accounts WHERE own = 1 ORDER BY created_at, handle').all();
    assert.equal(own.length, 2);
    const mia = own.find((a) => a.handle === 'mia.fit');
    assert.equal(mia.name, 'Mia');
    assert.equal(mia.bio, 'gym and coffee');
    assert.equal(mia.pfp, 'pfp/r002.jpg');
    assert.equal(mia.followers, 2400);
    const s = JSON.parse(mia.settings);
    assert.deepEqual(s.directions, { caption: 'short and teasing', comments: 'hype comments', story: 'one word', dmFan: 'shy fans', dmMe: 'cocky' });
    assert.deepEqual(s.own, { captions: ['line one', 'line two'], comments: ['nice', 'wow'], stories: ['gm'] });
    assert.equal(s.heat, 'explicit');
    assert.equal(s.multi, 'lots');
    assert.equal(own.find((a) => a.handle === 'zed').pfp, '', 'a non-pfp/ avatar is not carried');
    assert.equal(u.db.prepare('SELECT COUNT(*) n FROM accounts WHERE own = 0').get().n, 0, 'npc accounts are not imported');
    const it = (k) => u.db.prepare('SELECT up, down, seen_at FROM items WHERE key = ?').get(k);
    assert.equal(it('a/f1.jpg').up, 2, 'liked and rated: the taste count only, kept adds nothing');
    assert.equal(it('a/f2.jpg').down, 1);
    assert.equal(it('a/f2.jpg').up, 0, 'saved but already rated: kept adds nothing');
    assert.equal(it('a/f3.jpg').up, 1, 'saved with no taste entry gives up+1');
    assert.equal(it('a/f1.jpg').seen_at, NOW - 1000);
    assert.equal(getSetting(u.db, 'postsPerDay'), 25);
    assert.deepEqual(out, { accounts: 2, directions: 5, taste: 2, convos: 1, seen: 1, kept: 3, dropped: 6 });
    const dm = u.db.prepare('SELECT * FROM convos').get();
    assert.equal(dm.acct, own.find((a) => a.handle === 'mia.fit').id);
    assert.equal(u.db.prepare('SELECT COUNT(*) n FROM dms WHERE convo = ?').get(dm.id).n, 2);
  } finally { u.done(); }
});

test('secret and media in the body are ignored and never stored', () => {
  const u = unit();
  try {
    seed(u.db);
    importPhone(u.ctx, phoneBody(), NOW);
    const dump = JSON.stringify(['items', 'accounts', 'posts', 'comments', 'convos', 'dms', 'settings', 'activity', 'writer_jobs']
      .map((t) => u.db.prepare(`SELECT * FROM ${t}`).all()));
    for (const needle of ['SECRET-KEY-123', 'BLOBBYTES', 'x.ts.net', 'clientId', 'npc direction']) {
      assert.ok(!dump.includes(needle), `${needle} must not be stored`);
    }
  } finally { u.done(); }
});

test('importing twice keeps the same accounts, chats and counts', () => {
  const u = unit();
  try {
    seed(u.db);
    const a = importPhone(u.ctx, phoneBody(), NOW);
    const ids = u.db.prepare('SELECT id FROM accounts ORDER BY id').all().map((r) => r.id);
    const b = importPhone(u.ctx, phoneBody(), NOW + 1000);
    assert.deepEqual(u.db.prepare('SELECT id FROM accounts ORDER BY id').all().map((r) => r.id), ids);
    assert.equal(u.db.prepare('SELECT COUNT(*) n FROM accounts WHERE own = 1').get().n, 2);
    assert.equal(u.db.prepare('SELECT COUNT(*) n FROM convos').get().n, 1);
    assert.equal(u.db.prepare('SELECT COUNT(*) n FROM dms').get().n, 2);
    assert.equal(u.db.prepare("SELECT up FROM items WHERE key = 'a/f1.jpg'").get().up, 2, 'not added a second time');
    assert.deepEqual(b, a);
  } finally { u.done(); }
});

function makeDefault(u) {
  u.db.prepare("INSERT INTO accounts(id, own, handle, name, bio, pfp, settings, created_at, followers, quiet, seed) VALUES ('a_auto',1,'auto','','','','{}',1,0,0,1)").run();
  setSetting(u.db, 'defaultOwnId', 'a_auto');
}

function starterPosts(u) {
  for (let i = 0; i < 9; i++) {
    u.db.prepare("INSERT INTO posts(id, acct, items, kind, caption, status, due_at, created_at) VALUES (?, 'a_auto', '[]', 'post', 'c', ?, 1, 1)")
      .run(`p_s${i}`, i < 7 ? 'live' : 'down');
    u.db.prepare("INSERT INTO comments(post, author, text, at) VALUES (?, 'fan', 'hi', 1)").run(`p_s${i}`);
  }
  u.db.prepare("INSERT INTO convos(id, acct, fan, fan_handle, fan_pfp, state, next_at, unread) VALUES ('a_auto|f','a_auto','f','f','','{}',NULL,1)").run();
  u.db.prepare("INSERT INTO dms(convo, from_me, text, at, seen) VALUES ('a_auto|f',0,'opener',1,0)").run();
  u.db.prepare("UPDATE items SET acct = 'a_auto'").run();
}

test('the auto-made default account is adopted even with live starter posts: no extra own account, no starters', () => {
  const u = unit();
  try {
    seed(u.db);
    makeDefault(u);
    starterPosts(u);
    importPhone(u.ctx, phoneBody(), NOW);
    assert.equal(u.db.prepare('SELECT COUNT(*) n FROM accounts WHERE own = 1').get().n, 2, 'exactly the imported accounts');
    assert.equal(u.db.prepare("SELECT handle FROM accounts WHERE id = 'a_auto'").get().handle, 'mia.fit');
    assert.equal(u.db.prepare("SELECT COUNT(*) n FROM posts WHERE id LIKE 'p_s%'").get().n, 0);
    assert.equal(u.db.prepare("SELECT COUNT(*) n FROM comments WHERE post LIKE 'p_s%'").get().n, 0);
    assert.equal(u.db.prepare("SELECT COUNT(*) n FROM dms WHERE text = 'opener'").get().n, 0);
    assert.equal(u.db.prepare("SELECT COUNT(*) n FROM convos WHERE id = 'a_auto|f'").get().n, 0);
    assert.equal(getSetting(u.db, 'defaultOwnId', 'x'), null);
    assert.ok(getSetting(u.db, 'importedAt', null));
  } finally { u.done(); }
});

test('a re-import after adopting the default account stays idempotent', () => {
  const u = unit();
  try {
    seed(u.db);
    makeDefault(u);
    starterPosts(u);
    importPhone(u.ctx, phoneBody(), NOW);
    const ids = u.db.prepare('SELECT id FROM accounts ORDER BY id').all().map((r) => r.id);
    importPhone(u.ctx, phoneBody(), NOW + 1000);
    assert.deepEqual(u.db.prepare('SELECT id FROM accounts ORDER BY id').all().map((r) => r.id), ids);
    assert.equal(u.db.prepare('SELECT COUNT(*) n FROM accounts WHERE own = 1').get().n, 2);
  } finally { u.done(); }
});

test('a database from an older build (one own account, no settings) is backfilled on start and then adopted', () => {
  const u = unit();
  try {
    seed(u.db);
    u.db.prepare("INSERT INTO accounts(id, own, handle, name, bio, pfp, settings, created_at, followers, quiet, seed) VALUES ('a_old',1,'old','','','','{}',1,0,0,1)").run();
    startAccounts(u.ctx);
    assert.equal(getSetting(u.db, 'defaultOwnId', null), 'a_old');
    importPhone(u.ctx, phoneBody(), NOW);
    assert.equal(u.db.prepare('SELECT COUNT(*) n FROM accounts WHERE own = 1').get().n, 2);
    assert.equal(u.db.prepare("SELECT handle FROM accounts WHERE id = 'a_old'").get().handle, 'mia.fit');
  } finally { u.done(); }
});

test('unmatched taste keys are counted in dropped', () => {
  const u = unit();
  try {
    addItem(u.db, 'a/f1.jpg', 'f1');
    const out = importPhone(u.ctx, {
      accounts: [],
      misc: { taste: { d_f1: { up: 1, down: 0 }, d_zzz: { up: 1, down: 0 }, 'pc:a': { up: 1, down: 0 }, 'pcs:b': { up: 1, down: 0 }, 'url:c': { up: 1, down: 0 } } },
    }, NOW);
    assert.equal(out.taste, 1);
    assert.equal(out.dropped, 4);
  } finally { u.done(); }
});

test('POST /reel/api/import answers counts and accepts a phone export well over 10 MB', async () => {
  const eng = await startTestEngine();
  try {
    const r = await postJson(`${eng.base}/reel/api/import`, phoneBody());
    assert.equal(r.status, 200);
    assert.equal(r.body.accounts, 2);
    const list = await getJson(`${eng.base}/reel/api/accounts`);
    const own = list.body.filter((a) => a.own === true);
    assert.deepEqual(own.map((a) => a.handle).sort(), ['mia.fit', 'zed']);
    assert.equal(list.body.filter((a) => a.own === false).length, 6, 'the seeded npcs are untouched');
    assert.deepEqual(own.find((a) => a.handle === 'mia.fit').settings.directions.caption, 'short and teasing');
    // a real phone export (chats, seen marks) runs past the router's default 10 MB
    const big = await postJson(`${eng.base}/reel/api/import`, { ...phoneBody(), pad: 'x'.repeat(12 * 1024 * 1024) });
    assert.equal(big.status, 200);
    assert.equal(big.body.accounts, 2);
    // other routes keep the 10 MB default
    const other = await postJson(`${eng.base}/reel/api/seen`, { items: [], pad: 'x'.repeat(10.5 * 1024 * 1024) });
    assert.equal(other.status, 413);
  } finally { await eng.stop(); }
});

test('import answers CORS for the github.io copy of the old app (preflight + POST), nobody else', async () => {
  const eng = await startTestEngine();
  try {
    const gh = 'https://perryindustries.github.io';
    const pre = await fetch(`${eng.base}/reel/api/import`, { method: 'OPTIONS', headers: { Origin: gh, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' } });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get('access-control-allow-origin'), gh);
    assert.match(pre.headers.get('access-control-allow-headers') || '', /content-type/i);
    const r = await fetch(`${eng.base}/reel/api/import`, { method: 'POST', headers: { Origin: gh, 'Content-Type': 'application/json' }, body: JSON.stringify(phoneBody()) });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('access-control-allow-origin'), gh);
    const other = await fetch(`${eng.base}/reel/api/import`, { method: 'POST', headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' }, body: JSON.stringify(phoneBody()) });
    assert.equal(other.headers.get('access-control-allow-origin'), null);
  } finally { await eng.stop(); }
});
