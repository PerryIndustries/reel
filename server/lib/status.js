// GET /reel/api/status: library counts, disk, mirror, writer and account health.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

function gitVersion(repoDir) {
  try {
    const v = execFileSync('git', ['-C', repoDir, 'rev-parse', '--short', 'HEAD'], {
      encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
    }).trim();
    return v || 'dev';
  } catch {
    return 'dev';
  }
}

function freeGB(dir) {
  try {
    const s = fs.statfsSync(dir);
    return Math.round((s.bavail * s.bsize) / 1024 ** 3 * 10) / 10;
  } catch {
    return null;
  }
}

export function start(ctx) {
  ctx.state.version ??= gitVersion(ctx.cfg.repoDir);
}

export function getStatus(ctx) {
  const { db } = ctx;
  const c = db.prepare(`SELECT
      COALESCE(SUM(gone = 0), 0) AS items,
      COALESCE(SUM(derived = 1 AND err IS NULL AND gone = 0), 0) AS postable,
      COALESCE(SUM(derived = 0 AND err IS NULL AND gone = 0), 0) AS pending,
      COALESCE(SUM(gone = 1), 0) AS gone,
      COALESCE(SUM(err IS NOT NULL AND err <> 'split' AND gone = 0), 0) AS failed
    FROM items`).get();
  const d = ctx.state.derive ?? {};
  const queue = db.prepare("SELECT count(*) AS n FROM writer_jobs WHERE status = 'todo'").get().n;
  const a = db.prepare(`SELECT COALESCE(SUM(own = 1), 0) AS own, COALESCE(SUM(own IS NOT 1), 0) AS other
    FROM accounts`).get();
  return {
    ok: true,
    version: ctx.state.version ?? 'dev',
    items: c.items,
    postable: c.postable,
    pending: c.pending,
    gone: c.gone,
    disk: { freeGB: freeGB(ctx.cfg.dataDir) },
    mirror: ctx.state.mirror ?? { at: null, ok: null, msg: 'never' },
    derive: { failed: c.failed, lastErr: d.lastErr ?? null, lastErrAt: d.lastErrAt ?? null, lastOkAt: d.lastOkAt ?? null },
    writer: { queue, ollama: ctx.state.ollamaUp ?? null },
    accounts: { own: a.own, other: a.other },
  };
}

export function routes(router, ctx) {
  router.add('GET', '/reel/api/status', () => getStatus(ctx));
}
