import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startTestEngine, getJson, postJson, waitFor } from './helpers.js';
import { setSetting } from '../lib/db.js';
import { syncOnce, isMedia, kindOf, itemKey } from '../lib/library.js';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-rclone.js');
const DAY = 86400_000;

async function boot() {
  const t = await startTestEngine({ REEL_RCLONE: JSON.stringify([process.execPath, FAKE]) });
  const list = path.join(t.dataDir, 'list.json');
  const src = path.join(t.dataDir, 'fakesrc');
  fs.mkdirSync(src, { recursive: true });
  process.env.FAKE_RCLONE_LIST = list;
  process.env.FAKE_RCLONE_SRC = src;
  delete process.env.FAKE_RCLONE_FAIL;
  setSetting(t.ctx.db, 'drivePath', 'fake:root');
  const setList = (entries) => fs.writeFileSync(list, JSON.stringify(entries));
  return { t, setList, ctx: t.ctx, src };
}
const e = (p, md5, extra = {}) => ({
  Path: p, Name: path.posix.basename(p), Size: 10, ModTime: '2026-01-01T00:00:00Z',
  Hashes: md5 ? { md5 } : {}, ID: `id-${p}`, ...extra,
});
const rows = (ctx) => ctx.db.prepare('SELECT * FROM items ORDER BY key').all();

test('helpers classify media', () => {
  assert.equal(isMedia('A.JPG'), true);
  assert.equal(isMedia('a.txt'), false);
  assert.equal(kindOf('a.MOV'), 'video');
  assert.equal(kindOf('a.heic'), 'photo');
  assert.equal(kindOf('a.doc'), null);
});

test('listing inserts only media items with md5 keys and folders', async () => {
  const { t, setList, ctx } = await boot();
  try {
    setList([e('a/b/one.jpg', 'ABCDEF'), e('top.mp4', '123456'), e('notes.txt', 'ffff'), e('dup.png', 'abcdef')]);
    const r = await syncOnce(ctx, 1000);
    assert.equal(r.listed, 2);
    assert.equal(r.added, 2);
    const items = rows(ctx);
    assert.deepEqual(items.map((i) => i.key), ['123456', 'abcdef']);
    const one = items.find((i) => i.key === 'abcdef');
    assert.equal(one.path, '0/a/b/one.jpg');
    assert.equal(one.folder, 'a/b');
    assert.equal(one.kind, 'photo');
    assert.equal(one.drive_id, 'id-a/b/one.jpg');
    assert.equal(one.added_at, 1000);
    assert.equal(items.find((i) => i.key === '123456').folder, '');
    assert.equal(ctx.state.mirror.ok, true);
  } finally { await t.stop(); }
});

test('file without md5 gets a stable p: key across two syncs', async () => {
  const { t, setList, ctx } = await boot();
  try {
    setList([e('x/nohash.jpg', null)]);
    await syncOnce(ctx, 1000);
    setList([e('x/nohash.jpg', null, { ModTime: '2027-05-05T00:00:00Z' })]);
    const r = await syncOnce(ctx, 2000);
    const items = rows(ctx);
    assert.equal(items.length, 1);
    assert.match(items[0].key, /^p:[0-9a-f]{32}$/);
    assert.equal(r.added, 0);
    assert.equal(itemKey(e('x/nohash.jpg', null)), items[0].key);
  } finally { await t.stop(); }
});

test('removed file becomes gone, hook gets its key, reappearing file is un-gone', async () => {
  const { t, setList, ctx } = await boot();
  try {
    const calls = [];
    ctx.hooks.gone.push((keys, now) => calls.push([keys, now]));
    setList([e('a.jpg', 'aa'), e('b.mp4', 'bb')]);
    await syncOnce(ctx, 1000);
    ctx.db.prepare("INSERT INTO items(key, parent, kind, gone) VALUES ('bb#1', 'bb', 'video', 0)").run();
    setList([e('a.jpg', 'aa')]);
    const r = await syncOnce(ctx, 2000);
    assert.equal(r.gone, 1);
    assert.deepEqual(calls, [[['bb'], 2000]]);
    const bb = ctx.db.prepare("SELECT gone, gone_at FROM items WHERE key = 'bb'").get();
    assert.deepEqual({ ...bb }, { gone: 1, gone_at: 2000 });
    assert.equal(ctx.db.prepare("SELECT gone FROM items WHERE key = 'bb#1'").get().gone, 1);
    setList([e('a.jpg', 'aa'), e('b.mp4', 'bb')]);
    await syncOnce(ctx, 3000);
    const back = ctx.db.prepare("SELECT gone, gone_at FROM items WHERE key = 'bb'").get();
    assert.equal(back.gone, 0);
    assert.equal(back.gone_at, null);
    assert.equal(calls.length, 1);
  } finally { await t.stop(); }
});

test('rclone failure sets mirror.ok=false and does not throw', async () => {
  const { t, setList, ctx } = await boot();
  try {
    setList([e('a.jpg', 'aa')]);
    await syncOnce(ctx, 1000);
    process.env.FAKE_RCLONE_FAIL = '1';
    const r = await syncOnce(ctx, 2000);
    assert.equal(ctx.state.mirror.ok, false);
    assert.equal(ctx.state.mirror.msg, 'fake rclone: simulated failure');
    assert.equal(r.mirrored, false);
    assert.equal(ctx.db.prepare("SELECT gone FROM items WHERE key = 'aa'").get().gone, 0, 'a failed listing must not mark anything gone');
    delete process.env.FAKE_RCLONE_FAIL;
    fs.writeFileSync(process.env.FAKE_RCLONE_LIST, 'not json');
    await syncOnce(ctx, 3000);
    assert.equal(ctx.state.mirror.ok, false);
  } finally { delete process.env.FAKE_RCLONE_FAIL; await t.stop(); }
});

test('mirror copies files, and is skipped when free space is below the threshold', async () => {
  const { t, setList, ctx, src } = await boot();
  try {
    fs.writeFileSync(path.join(src, 'a.jpg'), 'x');
    setList([e('a.jpg', 'aa')]);
    const r1 = await syncOnce(ctx, 1000);
    assert.equal(r1.mirrored, true);
    assert.ok(fs.existsSync(path.join(ctx.cfg.sourceDir, '0', 'a.jpg')));
    fs.rmSync(path.join(ctx.cfg.sourceDir, '0'), { recursive: true });
    ctx.cfg.minFreeGB = 1e9;
    const r2 = await syncOnce(ctx, 2000);
    assert.equal(r2.mirrored, false);
    assert.equal(r2.msg, 'disk low');
    assert.equal(ctx.state.mirror.msg, 'disk low');
    assert.ok(!fs.existsSync(path.join(ctx.cfg.sourceDir, '0', 'a.jpg')));
    assert.equal(rows(ctx).length, 1, 'listing still happens');
  } finally { await t.stop(); }
});

test('empty drivePath records "no Drive folder set" and does nothing else', async () => {
  const { t, ctx } = await boot();
  try {
    setSetting(ctx.db, 'drivePath', '');
    await syncOnce(ctx, 1000);
    assert.deepEqual({ ...ctx.state.mirror }, { at: 1000, ok: false, msg: 'no Drive folder set' });
  } finally { await t.stop(); }
});

test('extraRoots use their own index; derivatives removed only when gone > 7 days', async () => {
  const { t, setList, ctx } = await boot();
  try {
    setSetting(ctx.db, 'extraRoots', ['fake:other']);
    setList([e('a.jpg', 'aa'), e('b.jpg', 'bb')]);
    await syncOnce(ctx, 0);
    assert.equal(ctx.db.prepare('SELECT count(*) n FROM items').get().n, 2, 'same md5 in both roots is one item');
    assert.equal(ctx.db.prepare("SELECT path FROM items WHERE key='aa'").get().path, '0/a.jpg');
    for (const k of ['aa', 'bb']) fs.mkdirSync(path.join(ctx.cfg.derivedDir, k), { recursive: true });
    setList([]);
    await syncOnce(ctx, 1 * DAY);
    assert.ok(fs.existsSync(path.join(ctx.cfg.derivedDir, 'aa')), 'just gone: keep');
    await syncOnce(ctx, 1 * DAY + 7 * DAY - 1);
    assert.ok(fs.existsSync(path.join(ctx.cfg.derivedDir, 'aa')), 'under 7 days: keep');
    await syncOnce(ctx, 1 * DAY + 7 * DAY + 1);
    assert.ok(!fs.existsSync(path.join(ctx.cfg.derivedDir, 'aa')));
    assert.ok(!fs.existsSync(path.join(ctx.cfg.derivedDir, 'bb')));
  } finally { await t.stop(); }
});

test('POST library/sync starts a sync; while one runs it answers running:true', async () => {
  const { t, setList, ctx } = await boot();
  try {
    setList([e('a.jpg', 'aa')]);
    const r = await postJson(`${t.base}/reel/api/library/sync`, {});
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.ok(await waitFor(() => ctx.state.mirror?.ok === true));
    assert.equal((await getJson(`${t.base}/reel/api/status`)).body.items, 1);
    ctx.cfg.rclone = [process.execPath, '-e', "setTimeout(()=>console.log('[]'),400)"];
    const first = await postJson(`${t.base}/reel/api/library/sync`, {});
    const second = await postJson(`${t.base}/reel/api/library/sync`, {});
    assert.equal(first.body.running, undefined);
    assert.deepEqual(second.body, { ok: true, running: true });
    assert.ok(await waitFor(() => !ctx.state.syncing, 4000, 20));
  } finally { await t.stop(); }
});

// ---- same-named Drive files (Drive allows many files with one name in a folder) ----
function dupSetup(ctx, dataDir, n = 2) {
  const files = path.join(dataDir, 'dupfiles');
  fs.mkdirSync(files, { recursive: true });
  const entries = [];
  for (let i = 1; i <= n; i++) {
    fs.writeFileSync(path.join(files, `c${i}.heic`), `content-${i}`);
    entries.push(e('Newss/lp_image.heic', `md5${i}`, { ID: `drv${i}`, _Src: path.join(files, `c${i}.heic`) }));
  }
  return entries;
}
const copyidCalls = (log) => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter((l) => l.startsWith('backend copyid')) : []);

test('same Path with different ids becomes separate dup items, fetched by id with the right contents', async () => {
  const { t, setList, ctx, src } = await boot();
  try {
    fs.mkdirSync(path.join(src, 'Newss'), { recursive: true });
    fs.writeFileSync(path.join(src, 'Newss', 'lp_image.heic'), 'shared-winner');
    setList(dupSetup(ctx, t.dataDir));
    const r = await syncOnce(ctx, 1000);
    assert.equal(r.listed, 2);
    const items = rows(ctx);
    assert.deepEqual(items.map((i) => i.path), ['dup/md51.heic', 'dup/md52.heic']);
    assert.equal(items[0].folder, 'Newss');
    for (const [i, it] of items.entries()) {
      assert.equal(fs.readFileSync(path.join(ctx.cfg.sourceDir, it.path), 'utf8'), `content-${i + 1}`);
    }
    assert.equal(r.mirrored, true);
    assert.equal(ctx.state.mirror.ok, true);
  } finally { await t.stop(); }
});

test('copyid runs only for dup items missing on disk, with remote, id and file path; skips items without id', async () => {
  const { t, setList, ctx } = await boot();
  try {
    const log = path.join(t.dataDir, 'rclone.log');
    process.env.FAKE_RCLONE_LOG = log;
    const entries = dupSetup(ctx, t.dataDir, 3);
    entries[2].ID = undefined;
    setList(entries);
    await syncOnce(ctx, 1000);
    const calls = copyidCalls(log);
    assert.equal(calls.length, 2);
    assert.ok(calls.every((c) => c.startsWith('backend copyid fake: drv')));
    assert.ok(calls.some((c) => c.endsWith(path.join(ctx.cfg.sourceDir, 'dup', 'md51.heic'))), 'order of parallel fetches is not fixed');
    fs.writeFileSync(log, '');
    await syncOnce(ctx, 2000);
    assert.equal(copyidCalls(log).length, 0, 'files already on disk: no fetch');
    fs.rmSync(path.join(ctx.cfg.sourceDir, 'dup', 'md52.heic'));
    await syncOnce(ctx, 3000);
    assert.equal(copyidCalls(log).length, 1);
  } finally { delete process.env.FAKE_RCLONE_LOG; await t.stop(); }
});

test('a dup file survives later syncs (sync only empties its own root folder)', async () => {
  const { t, setList, ctx } = await boot();
  try {
    setList(dupSetup(ctx, t.dataDir));
    await syncOnce(ctx, 1000);
    const f = path.join(ctx.cfg.sourceDir, 'dup', 'md51.heic');
    assert.ok(fs.existsSync(f));
    await syncOnce(ctx, 2000);
    assert.ok(fs.existsSync(f), 'second sync must not delete it');
  } finally { await t.stop(); }
});

test('an item derived from the shared path that becomes a dup is reset to derived=0 and moved', async () => {
  const { t, setList, ctx } = await boot();
  try {
    setList([e('Newss/lp_image.heic', 'md51', { ID: 'drv1' })]);
    await syncOnce(ctx, 1000);
    ctx.db.prepare("UPDATE items SET derived = 1 WHERE key = 'md51'").run();
    assert.equal(ctx.db.prepare("SELECT path FROM items WHERE key='md51'").get().path, '0/Newss/lp_image.heic');
    setList(dupSetup(ctx, t.dataDir));
    await syncOnce(ctx, 2000);
    const row = ctx.db.prepare("SELECT path, derived FROM items WHERE key='md51'").get();
    assert.deepEqual({ ...row }, { path: 'dup/md51.heic', derived: 0 });
    ctx.db.prepare("UPDATE items SET derived = 1 WHERE key = 'md51'").run();
    await syncOnce(ctx, 3000);
    assert.equal(ctx.db.prepare("SELECT derived FROM items WHERE key='md51'").get().derived, 1, 'already a dup: no reset');
  } finally { await t.stop(); }
});

test('a gone dup item loses its dup file only after 7 days', async () => {
  const { t, setList, ctx } = await boot();
  try {
    setList(dupSetup(ctx, t.dataDir));
    await syncOnce(ctx, 0);
    const f = path.join(ctx.cfg.sourceDir, 'dup', 'md51.heic');
    setList([]);
    await syncOnce(ctx, DAY);
    assert.ok(fs.existsSync(f));
    await syncOnce(ctx, DAY + 7 * DAY + 1);
    assert.ok(!fs.existsSync(f));
    assert.ok(!fs.existsSync(path.join(ctx.cfg.sourceDir, 'dup', 'md52.heic')));
  } finally { await t.stop(); }
});

test('a failed copyid sets mirror.ok=false with the count, the tick does not throw, and the next sync fetches it', async () => {
  const { t, setList, ctx } = await boot();
  try {
    setList(dupSetup(ctx, t.dataDir, 3));
    process.env.FAKE_RCLONE_FAIL_IDS = 'drv2';
    const r = await syncOnce(ctx, 1000);
    assert.equal(r.mirrored, true);
    assert.equal(ctx.state.mirror.ok, false);
    assert.match(ctx.state.mirror.msg, /^1 same-named file\(s\) not fetched: fake rclone: cannot copy drv2$/);
    const f2 = path.join(ctx.cfg.sourceDir, 'dup', 'md52.heic');
    assert.ok(!fs.existsSync(f2));
    assert.ok(fs.existsSync(path.join(ctx.cfg.sourceDir, 'dup', 'md51.heic')), 'the others are still fetched');
    delete process.env.FAKE_RCLONE_FAIL_IDS;
    await syncOnce(ctx, 2000);
    assert.equal(ctx.state.mirror.ok, true);
    assert.equal(fs.readFileSync(f2, 'utf8'), 'content-2');
  } finally { delete process.env.FAKE_RCLONE_FAIL_IDS; await t.stop(); }
});

test('when a same-named twin is deleted, the survivor moves back to its normal path and its dup file is removed', async () => {
  const { t, setList, ctx, src } = await boot();
  try {
    const entries = dupSetup(ctx, t.dataDir);
    setList(entries);
    await syncOnce(ctx, 1000);
    const dupFile = path.join(ctx.cfg.sourceDir, 'dup', 'md51.heic');
    assert.ok(fs.existsSync(dupFile));
    fs.mkdirSync(path.join(src, 'Newss'), { recursive: true });
    fs.writeFileSync(path.join(src, 'Newss', 'lp_image.heic'), 'content-1');
    setList([entries[0]]);
    await syncOnce(ctx, 2000);
    assert.equal(ctx.db.prepare("SELECT path FROM items WHERE key='md51'").get().path, '0/Newss/lp_image.heic');
    assert.ok(!fs.existsSync(dupFile), 'stale dup file removed');
    assert.ok(fs.existsSync(path.join(ctx.cfg.sourceDir, '0', 'Newss', 'lp_image.heic')));
  } finally { await t.stop(); }
});

test('dup fetches run at most 4 at a time', async () => {
  const { t, setList, ctx } = await boot();
  try {
    const conc = path.join(t.dataDir, 'conc');
    fs.mkdirSync(conc, { recursive: true });
    process.env.FAKE_RCLONE_CONC_DIR = conc;
    setList(dupSetup(ctx, t.dataDir, 9));
    await syncOnce(ctx, 1000);
    const seen = fs.readFileSync(path.join(conc, 'max.log'), 'utf8').split('\n').filter(Boolean).map(Number);
    assert.equal(seen.length, 9, 'all 9 fetched');
    assert.ok(Math.max(...seen) <= 4, `max concurrent copyid was ${Math.max(...seen)}`);
    assert.ok(Math.max(...seen) >= 2, 'fetches do overlap');
  } finally { delete process.env.FAKE_RCLONE_CONC_DIR; await t.stop(); }
});

test('remote is the root up to the first colon (curly apostrophe root), passed to rclone as one argument', async () => {
  const { t, setList, ctx } = await boot();
  try {
    const log = path.join(t.dataDir, 'argv.log');
    process.env.FAKE_RCLONE_ARGV_LOG = log;
    const root = 'fake:Perry’s private:2026'; // a second colon tells first-colon from last-colon
    setSetting(ctx.db, 'drivePath', root);
    setList(dupSetup(ctx, t.dataDir));
    await syncOnce(ctx, 1000);
    const calls = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const copyids = calls.filter((c) => c[0] === 'backend');
    assert.equal(copyids.length, 2);
    assert.ok(copyids.every((c) => c[2] === 'fake:'), JSON.stringify(copyids));
    assert.ok(calls.filter((c) => c[0] === 'lsjson').every((c) => c.at(-1) === root));
    assert.ok(calls.filter((c) => c[0] === 'sync').every((c) => c[1] === root));
  } finally { delete process.env.FAKE_RCLONE_ARGV_LOG; await t.stop(); }
});
