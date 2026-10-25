// reel-engine: the HTTP server, the module wiring and the tick loop.
//   node server/main.js            (normally started by run.js, the supervisor)
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './lib/config.js';
import { makeLog } from './lib/log.js';
import { openDb, backupNightly } from './lib/db.js';
import { makeRouter, sendError } from './lib/router.js';

// Fixed module order. Each module may export start(ctx), routes(router, ctx) and stop(ctx).
export const MODULES = [
  'status', 'library', 'derive', 'accounts', 'scheduler', 'engagement', 'dms', 'writer',
  'feed', 'api', 'media', 'importer',
];

const HOUR = 3600_000;

// Starts the engine. Ticks: any module may push {name, everyMs, fn(now)} to ctx.ticks (also after
// start); each runs every everyMs (first run everyMs after it is seen), never overlapping itself,
// errors logged. env.REEL_TICK_MS sets how often the tick loop looks (default 1000 ms).
export async function startEngine(env = process.env) {
  const cfg = loadConfig(env);
  const log = makeLog(cfg.logDir);
  const db = openDb(cfg.dbPath);
  const router = makeRouter(log);
  const ctx = {
    cfg, db, log, router,
    state: {},
    ticks: [],
    hooks: { gone: [] },
    rand: Math.random,
  };

  const started = [];
  let server = null;
  let timer = null;
  const running = new Set();
  let stopped = false;

  async function stop() {
    if (stopped) return;
    stopped = true;
    if (timer) clearInterval(timer);
    if (server) {
      const closed = new Promise((r) => server.close(r));
      server.closeAllConnections();
      await closed;
    }
    await Promise.race([Promise.allSettled([...running]), new Promise((r) => setTimeout(r, 5000))]);
    for (const [name, mod] of started.reverse()) {
      try { await mod.stop?.(ctx); } catch (e) { log('error', `module ${name} stop failed: ${e.message}`, { stack: e.stack }); }
    }
    try { db.close(); } catch { /* already closed */ }
  }

  try {
    try { backupNightly(db, cfg.dbPath, Date.now()); } catch (e) { log('error', `backup failed: ${e.message}`); }
    ctx.ticks.push({ name: 'backup', everyMs: HOUR, fn: (now) => backupNightly(db, cfg.dbPath, now) });

    for (const name of MODULES) {
      const mod = await import(`./lib/${name}.js`);
      started.push([name, mod]);
      await mod.start?.(ctx);
      mod.routes?.(router, ctx);
    }

    const tickState = new WeakMap();
    const runTicks = () => {
      const now = Date.now();
      for (const t of ctx.ticks) {
        let s = tickState.get(t);
        if (!s) { tickState.set(t, { next: now + t.everyMs, running: false }); continue; }
        if (s.running || now < s.next) continue;
        s.running = true;
        let p;
        try { p = Promise.resolve(t.fn(now)); } catch (e) { p = Promise.reject(e); }
        const done = p
          .catch((e) => log('error', `tick ${t.name} failed: ${e?.message ?? e}`, { stack: e?.stack }))
          .finally(() => { s.running = false; s.next = Date.now() + t.everyMs; running.delete(done); });
        running.add(done);
      }
    };
    timer = setInterval(runTicks, Number(env.REEL_TICK_MS) || 1000);

    server = http.createServer((req, res) => {
      router.handle(req, res).then((handled) => {
        if (handled) return;
        const pathname = new URL(req.url, 'http://localhost').pathname;
        if (pathname.startsWith('/reel/api/')) return sendError(res, 404, `not found: ${req.method} ${pathname}`);
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('not found');
      }).catch((e) => {
        log('error', `request ${req.method} ${req.url} crashed: ${e.message}`, { stack: e.stack });
        res.destroy();
      });
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(cfg.port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
    });
    server.on('error', (e) => log('error', `server error: ${e.message}`));
    log('info', `engine listening on 127.0.0.1:${server.address().port} data=${cfg.dataDir}`);
  } catch (e) {
    if (server && !server.listening) server = null;
    await stop();
    throw e;
  }

  return { ctx, server, stop };
}

function isMain() {
  if (!process.argv[1]) return false;
  const a = path.resolve(process.argv[1]);
  const b = fileURLToPath(import.meta.url);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

if (isMain()) {
  let engine = null;
  const fallbackLog = (() => { try { return makeLog(loadConfig(process.env).logDir); } catch { return () => {}; } })();
  const logOf = () => engine?.ctx.log ?? fallbackLog;
  process.on('uncaughtException', (e) => {
    logOf()('fatal', `uncaught exception: ${e?.message ?? e}`, { stack: e?.stack });
    console.error('reel-engine uncaught exception:', e);
    process.exit(1); // the supervisor restarts us
  });
  // A stray rejection (a failed fetch nobody awaited) must not take the engine down: log and run on.
  process.on('unhandledRejection', (e) => {
    logOf()('error', `unhandled rejection: ${e?.message ?? e}`, { stack: e?.stack });
  });
  const shutdown = () => { (engine ? engine.stop() : Promise.resolve()).finally(() => process.exit(0)); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  engine = await startEngine(process.env);
  if (process.env.REEL_TEST_HOOKS === '1') {
    // Test-only (inert unless the env var is set): lets a child-process test inject faults.
    engine.ctx.router.add('POST', '/reel/api/__test/reject', () => { Promise.reject(new Error('injected rejection')); return { ok: true }; });
  }
  console.log(`reel-engine listening on http://127.0.0.1:${engine.server.address().port}/reel/api/status`);
}
