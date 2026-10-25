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
