// Library: lists the Drive with rclone, keeps the local mirror, tracks items that disappear.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { getSetting, tx } from './db.js';

const PHOTO = new Set(['jpg', 'jpeg', 'png', 'webp', 'heic', 'gif']);
const VIDEO = new Set(['mp4', 'mov', 'm4v', 'webm']);
const EXTS = [...PHOTO, ...VIDEO];
const INCLUDE = `*.{${[...EXTS, ...EXTS.map((x) => x.toUpperCase())].join(',')}}`;
const DAY = 86400_000;
const SYNC_EVERY = 15 * 60_000;
const FIRST_RUN = 30_000;
const LS_TIMEOUT = 10 * 60_000;
const SYNC_TIMEOUT = 6 * 3600_000;

export function kindOf(name) {
  const m = /\.([A-Za-z0-9]+)$/.exec(String(name));
  const ext = m ? m[1].toLowerCase() : '';
  if (PHOTO.has(ext)) return 'photo';
  if (VIDEO.has(ext)) return 'video';
  return null;
}

export function isMedia(name) {
  return kindOf(name) !== null;
}

// md5 (lowercase) when the Drive gave one, else `p:` + first 32 hex of sha1(path + size).
export function itemKey(entry) {
  const h = entry.Hashes || {};
  const md5 = h.md5 ?? h.MD5;
  if (md5) return String(md5).toLowerCase();
  return 'p:' + crypto.createHash('sha1').update(`${entry.Path}${entry.Size}`).digest('hex').slice(0, 32);
}

// derived folder name for an item key; ':' (p: keys) is not a legal Windows path character
import { slug } from './derive.js';

function winGetRclone() {
  const base = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Packages');
  try {
    for (const pkg of fs.readdirSync(base).filter((d) => d.startsWith('Rclone.Rclone_')).sort()) {
      for (const sub of fs.readdirSync(path.join(base, pkg), { withFileTypes: true })) {
        const exe = path.join(base, pkg, sub.name, 'rclone.exe');
        if (sub.isDirectory() && fs.existsSync(exe)) return exe;
      }
    }
  } catch { /* no WinGet install */ }
  return null;
}

// cfg.rclone as an argv; the plain default falls back to the WinGet install when PATH has none.
function rcloneArgv(ctx) {
  const argv = ctx.cfg.rclone;
  if (argv.length !== 1 || argv[0] !== 'rclone') return argv;
  if (ctx.state.rcloneResolved) return ctx.state.rcloneResolved;
  const probe = spawnSync('rclone', ['version'], { windowsHide: true, timeout: 15000, stdio: 'ignore' });
  let resolved = argv;
  if (probe.error || probe.status !== 0) {
    const exe = winGetRclone();
    if (exe) resolved = [exe];
  }
  ctx.state.rcloneResolved = resolved;
  return resolved;
}

function run(argv, args, timeoutMs) {
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let settled = false;
    let timer = null;
    const done = (r) => { if (!settled) { settled = true; clearTimeout(timer); resolve(r); } };
    let child;
    try {
      child = spawn(argv[0], [...argv.slice(1), ...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return resolve({ code: -1, out, err: e.message });
    }
    timer = setTimeout(() => { child.kill(); done({ code: -1, out, err: 'rclone timed out' }); }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => done({ code: -1, out, err: e.message }));
    child.on('close', (code) => done({ code, out, err }));
  });
}

const firstLine = (s, dflt) => (String(s).split(/\r?\n/).find((l) => l.trim()) || dflt).trim();

function roots(ctx) {
  const drive = getSetting(ctx.db, 'drivePath');
  if (!drive) return [];
  const extra = getSetting(ctx.db, 'extraRoots');
  return [drive, ...(Array.isArray(extra) ? extra.filter(Boolean) : [])];
}

function freeGB(dir) {
  try {
    const s = fs.statfsSync(dir);
    return (s.bavail * s.bsize) / 1024 ** 3;
  } catch {
    return Infinity;
  }
}

function setMirror(ctx, at, ok, msg) {
  ctx.state.mirror = { at, ok, msg };
}

// One full pass: list every root, upsert, mark gone, clean old derivatives, mirror.
export async function syncOnce(ctx, now) {
  const result = { listed: 0, added: 0, gone: 0, mirrored: false, msg: '' };
  try {
    const rs = roots(ctx);
    if (rs.length === 0) {
      result.msg = 'no Drive folder set';
      setMirror(ctx, now, false, result.msg);
      return result;
    }
    const argv = rcloneArgv(ctx);

    // 1. list every root first; one bad listing aborts before anything is marked gone
    const found = new Map(); // key -> entry
    for (let i = 0; i < rs.length; i++) {
      const r = await run(argv, ['lsjson', '-R', '--hash', '--files-only', rs[i]], LS_TIMEOUT);
      if (r.code !== 0) throw new Error(firstLine(r.err, `rclone lsjson exited ${r.code}`));
      let arr;
      try { arr = JSON.parse(r.out); } catch { throw new Error('rclone lsjson returned bad JSON'); }
      if (!Array.isArray(arr)) throw new Error('rclone lsjson returned bad JSON');
      for (const x of arr) {
        if (!x || typeof x.Path !== 'string' || !isMedia(x.Path)) continue;
        const key = itemKey(x);
        if (found.has(key)) continue; // same file twice: first path wins
        found.set(key, { key, root: i, path: x.Path, size: x.Size ?? null, id: x.ID ?? null });
      }
    }
    result.listed = found.size;

    // 2. upsert, un-gone, mark the missing
    const goneKeys = [];
    tx(ctx.db, () => {
      const sel = ctx.db.prepare('SELECT key, gone FROM items WHERE key = ?');
      const ins = ctx.db.prepare(`INSERT INTO items(key, path, folder, drive_id, kind, size, md5, added_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
      const upd = ctx.db.prepare(`UPDATE items SET path = ?, folder = ?, drive_id = ?, size = ?,
        gone = 0, gone_at = NULL WHERE key = ?`);
      const kids = ctx.db.prepare('UPDATE items SET gone = 0, gone_at = NULL WHERE parent = ?');
      for (const f of found.values()) {
        const rel = `${f.root}/${f.path}`;
        const dir = path.posix.dirname(f.path);
        const folder = dir === '.' ? '' : dir;
        const row = sel.get(f.key);
        if (!row) {
          ins.run(f.key, rel, folder, f.id, kindOf(f.path), f.size, f.key.startsWith('p:') ? null : f.key, now);
          result.added++;
        } else {
          upd.run(rel, folder, f.id, f.size, f.key);
          if (row.gone) kids.run(f.key);
        }
      }
      const live = ctx.db.prepare('SELECT key FROM items WHERE parent IS NULL AND gone = 0 AND path IS NOT NULL').all();
      const markGone = ctx.db.prepare('UPDATE items SET gone = 1, gone_at = ? WHERE key = ? OR parent = ?');
      for (const { key } of live) {
        if (found.has(key)) continue;
        markGone.run(now, key, key);
        goneKeys.push(key);
      }
    });
    result.gone = goneKeys.length;
    if (goneKeys.length) {
      for (const fn of ctx.hooks?.gone ?? []) {
        try { await fn(goneKeys, now); } catch (e) { ctx.log('error', `gone hook failed: ${e.message}`, { stack: e.stack }); }
      }
    }

    // 3. derivatives of items gone for more than 7 days
    const old = ctx.db.prepare('SELECT key FROM items WHERE gone = 1 AND gone_at < ?').all(now - 7 * DAY);
    for (const { key } of old) {
      try { fs.rmSync(path.join(ctx.cfg.derivedDir, slug(key)), { recursive: true, force: true }); } catch (e) {
        ctx.log('warn', `could not remove derivatives of ${key}: ${e.message}`);
      }
    }

    // 4. mirror, unless the disk is short
    const minFree = ctx.cfg.minFreeGB ?? 30;
    if (freeGB(ctx.cfg.sourceDir) < minFree) {
      result.msg = 'disk low';
      ctx.log('warn', 'mirror skipped: disk low');
      setMirror(ctx, now, false, 'disk low');
      return result;
    }
    for (let i = 0; i < rs.length; i++) {
      const dest = path.join(ctx.cfg.sourceDir, String(i));
      const r = await run(argv, ['sync', rs[i], dest, '--transfers', '4', '--include', INCLUDE], SYNC_TIMEOUT);
      if (r.code !== 0) throw new Error(firstLine(r.err, `rclone sync exited ${r.code}`));
    }
    result.mirrored = true;
    result.msg = 'ok';
    setMirror(ctx, now, true, 'ok');
  } catch (e) {
    result.msg = e.message;
    ctx.log('error', `library sync failed: ${e.message}`);
    setMirror(ctx, now, false, e.message);
  }
  return result;
}

// Runs a sync unless one is already running. Returns false when one was.
async function guarded(ctx, now) {
  if (ctx.state.syncing) return false;
  ctx.state.syncing = true;
  try {
    await syncOnce(ctx, now);
  } finally {
    ctx.state.syncing = false;
  }
  return true;
}

export function start(ctx) {
  ctx.ticks.push({ name: 'library', everyMs: SYNC_EVERY, fn: (now) => guarded(ctx, now) });
  // first run 30 s after start (the tick loop alone would wait the whole 15 minutes)
  const t = setTimeout(() => {
    guarded(ctx, Date.now()).catch((e) => ctx.log('error', `library first sync failed: ${e.message}`));
  }, FIRST_RUN);
  t.unref();
  ctx.state.libraryFirstCancel = () => clearTimeout(t);
}

export function stop(ctx) {
  ctx.state.libraryFirstCancel?.();
}

export function routes(router, ctx) {
  router.add('POST', '/reel/api/library/sync', () => {
    if (ctx.state.syncing) return { ok: true, running: true };
    guarded(ctx, Date.now()).catch((e) => ctx.log('error', `library sync failed: ${e.message}`));
    return { ok: true };
  });
}
