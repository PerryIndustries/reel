import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { tempEnv, removeTempDir } from './helpers.js';
import { loadConfig } from '../lib/config.js';
import { makeLog } from '../lib/log.js';
import { openDb } from '../lib/db.js';
import { deriveOne, pickNext, derivedPaths, slug, CLIP } from '../lib/derive.js';

const haveFfmpeg = spawnSync('ffmpeg', ['-version'], { windowsHide: true }).status === 0
  && spawnSync('ffprobe', ['-version'], { windowsHide: true }).status === 0;
if (!haveFfmpeg) console.log('SKIP derive.test.js: ffmpeg/ffprobe not on PATH');
const opts = { skip: haveFfmpeg ? false : 'ffmpeg/ffprobe not on PATH' };

let fixDir;
const NOW = 1_800_000_000_000;

function ff(args) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { windowsHide: true });
  assert.equal(r.status, 0, String(r.stderr));
}

function probe(file, entries) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', entries, '-of', 'json', file], { windowsHide: true });
  assert.equal(r.status, 0, String(r.stderr));
  return JSON.parse(r.stdout.toString());
}

before(() => {
  if (!haveFfmpeg) return;
  fixDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-derive-fix-'));
  ff(['-f', 'lavfi', '-i', 'testsrc=size=1600x1200:rate=1', '-frames:v', '1', path.join(fixDir, 'photo.jpg')]);
  ff(['-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=10:duration=3', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', path.join(fixDir, 'short.mp4')]);
  ff(['-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=1:duration=200', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-preset', 'ultrafast', '-g', '10', path.join(fixDir, 'long.mp4')]);
  ff(['-f', 'lavfi', '-i', 'testsrc=size=1921x1081:rate=5:duration=1', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
    '-c:v', 'libx264', '-pix_fmt', 'yuv444p', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', path.join(fixDir, 'odd.mp4')]);
  ff(['-f', 'lavfi', '-i', 'testsrc=size=1081x1921:rate=5:duration=1',
    '-c:v', 'libx264', '-pix_fmt', 'yuv444p', '-preset', 'ultrafast', path.join(fixDir, 'portrait.mp4')]);
  fs.writeFileSync(path.join(fixDir, 'corrupt.jpg'), Buffer.from('this is not an image at all'));
});

after(() => { if (fixDir) fs.rmSync(fixDir, { recursive: true, force: true }); });

// A ctx with the same shape as the engine's, minus the HTTP server and tick loop.
function makeCtx(t) {
  const env = tempEnv();
  const cfg = loadConfig(env);
  const ctx = { cfg, log: makeLog(cfg.logDir), db: openDb(cfg.dbPath), state: {}, ticks: [], hooks: { gone: [] }, rand: Math.random };
  t.after(() => { try { ctx.db.close(); } catch { /* closed */ } removeTempDir(env.REEL_DATA); });
  return ctx;
}

function addItem(ctx, key, fixture, kind, addedAt = NOW) {
  const rel = `0/${fixture}`;
  fs.mkdirSync(path.dirname(path.join(ctx.cfg.sourceDir, rel)), { recursive: true });
  fs.copyFileSync(path.join(fixDir, fixture), path.join(ctx.cfg.sourceDir, rel));
  ctx.db.prepare('INSERT INTO items (key, path, folder, kind, derived, gone, added_at) VALUES (?, ?, ?, ?, 0, 0, ?)')
    .run(key, rel, '0', kind, addedAt);
  return ctx.db.prepare('SELECT * FROM items WHERE key = ?').get(key);
}

const row = (ctx, key) => ctx.db.prepare('SELECT * FROM items WHERE key = ?').get(key);

test('photo produces full.jpg <= 1080 long edge and thumb.jpg <= 480, derived=1', opts, async (t) => {
  const ctx = makeCtx(t);
  const item = addItem(ctx, 'p1', 'photo.jpg', 'photo');
  assert.equal(await deriveOne(ctx, item, NOW), 'ok');
  const p = derivedPaths(ctx, 'p1');
  const full = probe(p.full, 'stream=width,height').streams[0];
  const thumb = probe(p.thumb, 'stream=width,height').streams[0];
  assert.equal(Math.max(full.width, full.height), 1080);
  assert.equal(Math.max(thumb.width, thumb.height), 480);
  const r = row(ctx, 'p1');
  assert.equal(r.derived, 1);
  assert.equal(r.err, null);
  assert.deepEqual([r.w, r.h], [full.width, full.height]);
  assert.equal(fs.existsSync(`${p.dir}.tmp`), false);
});

function topLevelAtoms(file) {
  const buf = fs.readFileSync(file);
  const out = [];
  let pos = 0;
  while (pos + 8 <= buf.length) {
    let size = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    if (size === 1) size = Number(buf.readBigUInt64BE(pos + 8));
    out.push(type);
    if (size < 8) break;
    pos += size;
  }
  return out;
}

test('short video produces faststart h264+aac video.mp4, poster.jpg and thumb.jpg', opts, async (t) => {
  const ctx = makeCtx(t);
  const item = addItem(ctx, 'v1', 'short.mp4', 'video');
  assert.equal(await deriveOne(ctx, item, NOW), 'ok');
  const p = derivedPaths(ctx, 'v1');
  const streams = probe(p.video, 'stream=codec_type,codec_name').streams;
  assert.ok(streams.some((s) => s.codec_type === 'video' && s.codec_name === 'h264'));
  assert.ok(streams.some((s) => s.codec_type === 'audio' && s.codec_name === 'aac'));
  const atoms = topLevelAtoms(p.video);
  assert.ok(atoms.includes('moov') && atoms.includes('mdat'), atoms.join(','));
  assert.ok(atoms.indexOf('moov') < atoms.indexOf('mdat'), `moov must precede mdat: ${atoms.join(',')}`);
  const poster = probe(p.poster, 'stream=width,height').streams[0];
  const thumb = probe(p.thumb, 'stream=width,height').streams[0];
  assert.deepEqual([poster.width, poster.height], [1280, 720]);
  assert.equal(Math.max(thumb.width, thumb.height), 480);
  const r = row(ctx, 'v1');
  assert.equal(r.derived, 1);
  assert.deepEqual([r.w, r.h], [1280, 720]);
  assert.ok(r.dur > 2 && r.dur < 4, `dur ${r.dur}`);
});

test('200 s video splits into <= 3 clip items of 15-60 s, parent not postable', opts, async (t) => {
  const ctx = makeCtx(t);
  const item = addItem(ctx, 'long1', 'long.mp4', 'video');
  assert.equal(await deriveOne(ctx, item, NOW), 'split');
  const parent = row(ctx, 'long1');
  assert.equal(parent.derived, 1);
  assert.equal(parent.err, 'split');
  const postable = ctx.db.prepare('SELECT key FROM items WHERE derived = 1 AND err IS NULL AND gone = 0').all();
  assert.equal(postable.some((r) => r.key === 'long1'), false);
  const clips = ctx.db.prepare('SELECT * FROM items WHERE parent = ? ORDER BY clip_start').all('long1');
  assert.ok(clips.length >= 1 && clips.length <= CLIP.count, `${clips.length} clips`);
  let prevEnd = 0;
  for (const c of clips) {
    assert.match(c.key, /^long1#c\d$/);
    assert.equal(c.kind, 'video');
    assert.equal(c.acct, null);
    assert.equal(c.folder, '0');
    assert.equal(c.derived, 0);
    assert.ok(c.clip_dur >= CLIP.min && c.clip_dur <= CLIP.max, `clip_dur ${c.clip_dur}`);
    assert.ok(c.clip_start >= prevEnd, 'clips overlap');
    assert.ok(c.clip_start + c.clip_dur <= 200 + 1e-6, 'clip runs past the end');
    prevEnd = c.clip_start + c.clip_dur;
  }
  // a clip derives like a short video, cut from the parent's source
  const clip = clips[0];
  assert.equal(await deriveOne(ctx, clip, NOW), 'ok');
  const out = derivedPaths(ctx, clip.key);
  assert.equal(path.basename(out.dir), slug(clip.key));
  const dur = Number(probe(out.video, 'format=duration').format.duration);
  assert.ok(Math.abs(dur - clip.clip_dur) < 2, `output ${dur}s vs ${clip.clip_dur}s`);
  assert.equal(row(ctx, clip.key).derived, 1);
});

test('a corrupt source records err and is not retried within 24 h', opts, async (t) => {
  const ctx = makeCtx(t);
  const item = addItem(ctx, 'bad1', 'corrupt.jpg', 'photo');
  assert.equal(pickNext(ctx, NOW).key, 'bad1');
  assert.equal(await deriveOne(ctx, item, NOW), 'err');
  const r = row(ctx, 'bad1');
  assert.equal(r.derived, 0);
  assert.ok(r.err && r.err.length > 0);
  assert.equal(r.err_at, NOW);
  assert.equal(fs.existsSync(derivedPaths(ctx, 'bad1').dir), false);
  assert.equal(pickNext(ctx, NOW + 3600_000), null);
  assert.equal(pickNext(ctx, NOW + 23 * 3600_000), null);
  assert.equal(pickNext(ctx, NOW + 25 * 3600_000).key, 'bad1');
});

test('picker takes the oldest ready item and skips ones whose source is not on disk', opts, async (t) => {
  const ctx = makeCtx(t);
  ctx.db.prepare("INSERT INTO items (key, path, kind, derived, gone, added_at) VALUES ('missing', '0/nope.jpg', 'photo', 0, 0, ?)").run(NOW);
  addItem(ctx, 'newer', 'photo.jpg', 'photo', NOW + 10);
  assert.equal(pickNext(ctx, NOW + 20).key, 'newer');
  ctx.db.prepare("UPDATE items SET gone = 1 WHERE key = 'newer'").run();
  assert.equal(pickNext(ctx, NOW + 20), null);
});

function videoFacts(file) {
  const v = probe(file, 'stream=codec_type,codec_name,profile,pix_fmt,width,height').streams;
  return { video: v.find((s) => s.codec_type === 'video'), audio: v.find((s) => s.codec_type === 'audio') };
}

test('odd-sized high-res yuv444p sources come out iPhone-safe (h264 High, yuv420p, even dims, <= 720p)', opts, async (t) => {
  const ctx = makeCtx(t);
  const land = addItem(ctx, 'odd', 'odd.mp4', 'video');
  const port = addItem(ctx, 'port', 'portrait.mp4', 'video');
  assert.equal(await deriveOne(ctx, land, NOW), 'ok');
  assert.equal(await deriveOne(ctx, port, NOW), 'ok');
  const a = videoFacts(derivedPaths(ctx, 'odd').video);
  assert.equal(a.video.codec_name, 'h264');
  assert.equal(a.video.profile, 'High');
  assert.equal(a.video.pix_fmt, 'yuv420p');
  assert.equal(a.video.width % 2, 0);
  assert.equal(a.video.height % 2, 0);
  assert.ok(a.video.height <= 720 && a.video.width <= 1280, `${a.video.width}x${a.video.height}`);
  assert.equal(a.audio.codec_name, 'aac');
  const b = videoFacts(derivedPaths(ctx, 'port').video);
  assert.equal(b.video.profile, 'High');
  assert.equal(b.video.pix_fmt, 'yuv420p');
  assert.equal(b.video.width % 2, 0);
  assert.equal(b.video.height % 2, 0);
  assert.ok(b.video.height <= 720 && b.video.width <= 1280, `${b.video.width}x${b.video.height}`);
  assert.equal(b.audio, undefined);
});

test('slug has no colon or hash, so p: keys derive into a legal Windows dir', opts, async (t) => {
  assert.equal(slug('p:abc#c1'), 'p_abc_c1');
  const ctx = makeCtx(t);
  const item = addItem(ctx, 'p:photo1', 'photo.jpg', 'photo');
  assert.equal(await deriveOne(ctx, item, NOW), 'ok');
  const { dir } = derivedPaths(ctx, 'p:photo1');
  assert.ok(!path.basename(dir).includes(':'), dir);
  assert.ok(fs.existsSync(path.join(dir, 'full.jpg')));
});

test('lastErr clears after a later success and keeps lastErrAt/lastOkAt', opts, async (t) => {
  const ctx = makeCtx(t);
  const bad = addItem(ctx, 'bad', 'corrupt.jpg', 'photo');
  assert.equal(await deriveOne(ctx, bad, NOW), 'err');
  assert.equal(ctx.state.derive.lastErr.key, 'bad');
  const good = addItem(ctx, 'good', 'photo.jpg', 'photo');
  assert.equal(await deriveOne(ctx, good, NOW + 5), 'ok');
  assert.equal(ctx.state.derive.lastErr, null);
  assert.equal(ctx.state.derive.lastErrAt, NOW);
  assert.equal(ctx.state.derive.lastOkAt, NOW + 5);
});
