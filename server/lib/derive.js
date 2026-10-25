// Derivative queue: turns mirrored source files into the small files the phone streams.
// One ffmpeg/ffprobe process at a time, lowest priority, writes to <dir>.tmp then renames.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ensureColumn } from './db.js';

export const CLIP = Object.freeze({ maxKeep: 180, min: 15, max: 60, count: 3 });

const DAY = 24 * 3600_000;
const TICK_MS = 20_000;
const BUDGET_MS = 15_000;
const PHOTO_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.heic', '.gif']);

export function slug(key) {
  return String(key).replace(/[#:]/g, '_');
}

export function derivedPaths(ctx, key) {
  const dir = path.join(ctx.cfg.derivedDir, slug(key));
  return {
    dir,
    thumb: path.join(dir, 'thumb.jpg'),
    full: path.join(dir, 'full.jpg'),
    video: path.join(dir, 'video.mp4'),
    poster: path.join(dir, 'poster.jpg'),
  };
}

// ---- one process at a time ----------------------------------------------------------------

let chain = Promise.resolve();
function serial(fn) {
  const p = chain.then(fn, fn);
  chain = p.catch(() => {});
  return p;
}

// Runs argv (array) -> {code, stdout, stderr}. Lowest priority right after spawn.
function run(argv) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ code: -1, stdout: '', stderr: `${e.message}\n` });
      return;
    }
    try { os.setPriority(child.pid, os.constants.priority.PRIORITY_LOW); } catch { /* already gone */ }
    const out = [];
    const err = [];
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    child.on('error', (e) => resolve({ code: -1, stdout: '', stderr: `${e.message}\n` }));
    child.on('close', (code) => resolve({
      code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'),
    }));
  });
}

const ffmpeg = (ctx, args) => serial(() => run([...ctx.cfg.ffmpeg, '-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args]));
const ffprobe = (ctx, args) => serial(() => run([...ctx.cfg.ffprobe, '-v', 'error', ...args]));

function firstLine(r) {
  const line = (r.stderr || '').split(/\r?\n/).map((s) => s.trim()).find(Boolean);
  return line || `exit code ${r.code}`;
}

async function probeDims(ctx, file) {
  const r = await ffprobe(ctx, ['-select_streams', 'v:0', '-show_entries', 'stream=width,height:format=duration', '-of', 'json', file]);
  if (r.code !== 0) throw new Error(firstLine(r));
  let j;
  try { j = JSON.parse(r.stdout); } catch { throw new Error('ffprobe gave no JSON'); }
  const s = j.streams?.[0];
  if (!s?.width || !s?.height) throw new Error('no video stream');
  const dur = Number(j.format?.duration);
  return { w: s.width, h: s.height, dur: Number.isFinite(dur) ? dur : null };
}

// ---- schema + picking ---------------------------------------------------------------------

const prepared = new WeakSet();
function ensureCols(ctx) {
  if (prepared.has(ctx.db)) return;
  ensureColumn(ctx.db, 'items', 'clip_start', 'REAL');
  ensureColumn(ctx.db, 'items', 'clip_dur', 'REAL');
  prepared.add(ctx.db);
}

function sourceFile(ctx, item) {
  let rel = item.path;
  if (item.parent) {
    const p = ctx.db.prepare('SELECT path FROM items WHERE key = ?').get(item.parent);
    rel = p?.path ?? item.path;
  }
  return rel ? path.join(ctx.cfg.sourceDir, rel) : null;
}

// Next item to derive, or null. Skips items whose source is not on disk yet.
export function pickNext(ctx, now) {
  ensureCols(ctx);
  const rows = ctx.db.prepare(
    `SELECT * FROM items WHERE derived = 0 AND gone = 0 AND (err IS NULL OR err_at < ?)
     ORDER BY added_at ASC, key ASC`,
  ).all(now - DAY);
  for (const row of rows) {
    const src = sourceFile(ctx, row);
    if (src && fs.existsSync(src)) return row;
  }
  return null;
}

function kindOf(item) {
  if (item.kind === 'photo' || item.kind === 'video') return item.kind;
  return PHOTO_EXT.has(path.extname(item.path || '').toLowerCase()) ? 'photo' : 'video';
}

// ---- processing ---------------------------------------------------------------------------

function freshTmp(dir) {
  const tmp = `${dir}.tmp`;
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  return tmp;
}

function publish(tmp, dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.renameSync(tmp, dir);
}

const PHOTO_FIT = (n) => `scale='min(${n},iw)':'min(${n},ih)':force_original_aspect_ratio=decrease`;

async function derivePhoto(ctx, item, src, dir) {
  const tmp = freshTmp(dir);
  try {
    const full = path.join(tmp, 'full.jpg');
    const thumb = path.join(tmp, 'thumb.jpg');
    let r = await ffmpeg(ctx, ['-i', src, '-frames:v', '1', '-vf', PHOTO_FIT(1080), '-q:v', '3', '-threads', '2', full]);
    if (r.code !== 0) throw new Error(firstLine(r));
    r = await ffmpeg(ctx, ['-i', full, '-frames:v', '1', '-vf', PHOTO_FIT(480), '-q:v', '5', '-threads', '2', thumb]);
    if (r.code !== 0) throw new Error(firstLine(r));
    const d = await probeDims(ctx, full);
    publish(tmp, dir);
    ctx.db.prepare('UPDATE items SET derived = 1, err = NULL, err_at = NULL, w = ?, h = ?, kind = ? WHERE key = ?')
      .run(d.w, d.h, 'photo', item.key);
  } catch (e) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
}

const VIDEO_VF = "scale='min(1280,iw)':'min(720,ih)':force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2";

async function deriveVideo(ctx, item, src, dir) {
  const tmp = freshTmp(dir);
  try {
    const video = path.join(tmp, 'video.mp4');
    const poster = path.join(tmp, 'poster.jpg');
    const thumb = path.join(tmp, 'thumb.jpg');
    const cut = item.parent && item.clip_dur
      ? ['-ss', String(item.clip_start ?? 0), '-t', String(item.clip_dur)] : [];
    let r = await ffmpeg(ctx, [
      ...cut, '-i', src, '-map', '0:v:0', '-map', '0:a:0?',
      '-c:v', 'libx264', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-crf', '24', '-vf', VIDEO_VF,
      '-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-movflags', '+faststart', '-threads', '2', video,
    ]);
    if (r.code !== 0) throw new Error(firstLine(r));
    const d = await probeDims(ctx, video);
    const at = d.dur != null && d.dur > 1.5 ? '1' : '0';
    r = await ffmpeg(ctx, ['-ss', at, '-i', video, '-frames:v', '1', '-q:v', '3', '-threads', '2', poster]);
    if (r.code !== 0) throw new Error(firstLine(r));
    r = await ffmpeg(ctx, ['-i', poster, '-frames:v', '1', '-vf', PHOTO_FIT(480), '-q:v', '5', '-threads', '2', thumb]);
    if (r.code !== 0) throw new Error(firstLine(r));
    publish(tmp, dir);
    ctx.db.prepare('UPDATE items SET derived = 1, err = NULL, err_at = NULL, w = ?, h = ?, dur = ?, kind = ? WHERE key = ?')
      .run(d.w, d.h, d.dur, 'video', item.key);
  } catch (e) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
}

// Random non-overlapping [start, len] windows, each CLIP.min..CLIP.max seconds, inside `dur`.
function pickWindows(dur, rand) {
  const lens = [];
  for (let i = 0; i < CLIP.count; i++) lens.push(Math.round(CLIP.min + rand() * (CLIP.max - CLIP.min)));
  const total = lens.reduce((a, b) => a + b, 0);
  const free = Math.max(0, dur - total);
  const offs = lens.map(() => rand() * free).sort((a, b) => a - b);
  let before = 0;
  return lens.map((len, i) => {
    const start = Math.floor((offs[i] + before) * 10) / 10;
    before += len;
    return { start, len };
  });
}

function splitVideo(ctx, item, dur, now) {
  const windows = pickWindows(dur, ctx.rand);
  const ins = ctx.db.prepare(
    `INSERT OR IGNORE INTO items (key, path, folder, kind, parent, acct, derived, gone, added_at, clip_start, clip_dur)
     VALUES (?, ?, ?, 'video', ?, NULL, 0, 0, ?, ?, ?)`,
  );
  ctx.db.exec('BEGIN');
  try {
    windows.forEach((w, i) => ins.run(`${item.key}#c${i + 1}`, item.path, item.folder ?? null, item.key, now, w.start, w.len));
    ctx.db.prepare("UPDATE items SET derived = 1, err = 'split', err_at = NULL, dur = ? WHERE key = ?").run(dur, item.key);
    ctx.db.exec('COMMIT');
  } catch (e) {
    if (ctx.db.isTransaction) ctx.db.exec('ROLLBACK');
    throw e;
  }
}

// -> 'ok' | 'err' | 'split'
export async function deriveOne(ctx, item, now) {
  ensureCols(ctx);
  item = ctx.db.prepare('SELECT * FROM items WHERE key = ?').get(item.key) ?? item;
  const src = sourceFile(ctx, item);
  const { dir } = derivedPaths(ctx, item.key);
  try {
    if (!src || !fs.existsSync(src)) throw new Error('source file missing');
    if (kindOf(item) === 'photo') {
      await derivePhoto(ctx, item, src, dir);
      markOk(ctx, now);
      return 'ok';
    }
    if (!item.parent) {
      const p = await ffprobe(ctx, ['-show_entries', 'format=duration', '-of', 'json', src]);
      if (p.code !== 0) throw new Error(firstLine(p));
      const dur = Number(JSON.parse(p.stdout || '{}').format?.duration);
      if (!Number.isFinite(dur)) throw new Error('unreadable video duration');
      if (dur > CLIP.maxKeep) {
        splitVideo(ctx, item, dur, now);
        return 'split';
      }
    }
    await deriveVideo(ctx, item, src, dir);
    markOk(ctx, now);
    return 'ok';
  } catch (e) {
    const msg = String(e.message || e).slice(0, 500);
    ctx.db.prepare('UPDATE items SET err = ?, err_at = ? WHERE key = ?').run(msg, now, item.key);
    ctx.log('error', `derive ${item.key} failed: ${msg}`);
    ctx.state.derive = { ...ctx.state.derive, lastErr: { key: item.key, msg, at: now }, lastErrAt: now };
    return 'err';
  }
}

function markOk(ctx, now) {
  ctx.state.derive = { lastErr: null, lastErrAt: ctx.state.derive?.lastErrAt ?? null, lastOkAt: now };
}

async function tick(ctx) {
  const t0 = Date.now();
  while (Date.now() - t0 < BUDGET_MS) {
    const item = pickNext(ctx, Date.now());
    if (!item) break;
    await deriveOne(ctx, item, Date.now());
  }
}

export function start(ctx) {
  ensureCols(ctx);
  ctx.ticks.push({ name: 'derive', everyMs: TICK_MS, fn: () => tick(ctx) });
}
