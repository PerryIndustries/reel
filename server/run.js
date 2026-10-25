// Supervisor: keeps `node main.js` running.
// - restarts it when it exits, waiting 2 s doubling to 60 s (reset after 10 min up)
// - every 2 min checks `git rev-parse HEAD` of the checkout and restarts it when HEAD moved
// - refuses to start a second copy when the engine port already listens
// - logs to <data>/logs/supervisor.log
//   node server/run.js
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './lib/config.js';
import { makeLog } from './lib/log.js';

const MIN_BACKOFF = 2000;
const MAX_BACKOFF = 60_000;
const RESET_AFTER = 10 * 60_000;
const HEAD_EVERY = 2 * 60_000;

// Wait before the next restart, given the previous wait (0 = none yet) and how long the child ran.
export function computeBackoff(prevMs, upMs) {
  if (!prevMs || upMs >= RESET_AFTER) return MIN_BACKOFF;
  return Math.min(prevMs * 2, MAX_BACKOFF);
}

// Stops the engine and everything it started (ffmpeg, rclone). On Windows child.kill() is TerminateProcess on
// the engine alone, so its children would survive; taskkill /T takes the whole tree.
export function stopChild(child, platform = process.platform, spawn_ = spawnSync) {
  if (!child) return;
  if (platform === 'win32' && child.pid) {
    spawn_('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 15_000 });
    return;
  }
  child.kill();
}

// Whether a HEAD change touched the supervisor itself (it never reloads its own code, so it must replace itself).
export function needsSelfRestart(changedFiles) {
  return (changedFiles ?? []).some((f) => /(^|\/)server\/run\.js$/.test(String(f).split(String.fromCharCode(92)).join("/")));
}

export function portListening(port, host = '127.0.0.1', timeoutMs = 1500) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host });
    const done = (v) => { sock.destroy(); resolve(v); };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

function gitHead(repoDir) {
  try {
    return execFileSync('git', ['-C', repoDir, 'rev-parse', 'HEAD'], {
      encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
    }).trim() || null;
  } catch {
    return null;
  }
}

function changedBetween(repoDir, a, b) {
  if (!a || !b) return [];
  try {
    return execFileSync('git', ['-C', repoDir, 'diff', '--name-only', a, b], {
      encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
    }).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

async function supervise() {
  const cfg = loadConfig(process.env);
  if (cfg.port && await portListening(cfg.port)) {
    console.log(`reel-engine already running on 127.0.0.1:${cfg.port}; not starting another`);
    process.exit(0);
  }
  const log = makeLog(cfg.logDir, { name: 'supervisor.log' });
  const mainPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'main.js');
  let child = null;
  let startedAt = 0;
  let backoff = 0;
  let restartNow = false;
  let stopping = false;
  let selfRestart = false;
  let head = gitHead(cfg.repoDir);

  const pipeLines = (stream, level) => {
    let buf = '';
    stream.setEncoding('utf8');
    stream.on('data', (d) => {
      buf += d;
      const lines = buf.split(/\r?\n/);
      buf = lines.pop();
      for (const l of lines) if (l) log(level, `[engine] ${l}`);
    });
  };

  function handOver() {
    // the engine is gone and its port is free: hand over to a fresh copy of this supervisor
    log('info', 'run.js changed; starting a fresh supervisor');
    try {
      spawn(process.execPath, [fileURLToPath(import.meta.url)], {
        cwd: process.cwd(), env: process.env, detached: true, stdio: 'ignore', windowsHide: true,
      }).unref();
    } catch (e) {
      log('error', `could not start a fresh supervisor: ${e.message}`);
    }
    process.exit(0);
  }

  function launch() {
    if (stopping) return;
    startedAt = Date.now();
    child = spawn(process.execPath, [mainPath], {
      env: process.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    log('info', `engine started pid=${child.pid} head=${head ?? 'unknown'}`);
    pipeLines(child.stdout, 'out');
    pipeLines(child.stderr, 'err');
    child.on('error', (e) => log('error', `engine spawn error: ${e.message}`));
    child.on('exit', (code, signal) => {
      child = null;
      if (stopping) return;
      const up = Date.now() - startedAt;
      if (selfRestart) { handOver(); return; }
      if (restartNow) {
        restartNow = false;
        backoff = 0;
        log('info', 'engine stopped for update; starting the new code');
        launch();
        return;
      }
      backoff = computeBackoff(backoff, up);
      log('warn', `engine exited code=${code} signal=${signal} after ${Math.round(up / 1000)}s; restart in ${backoff / 1000}s`);
      setTimeout(launch, backoff);
    });
  }

  setInterval(() => {
    const h = gitHead(cfg.repoDir);
    if (!h || h === head) return;
    log('info', `HEAD moved ${head ?? 'unknown'} -> ${h}; restarting engine`);
    const changed = changedBetween(cfg.repoDir, head, h);
    head = h;
    if (needsSelfRestart(changed)) selfRestart = true;
    if (child) { restartNow = true; stopChild(child); }
    else if (selfRestart) handOver();
  }, HEAD_EVERY);

  const shutdown = () => {
    stopping = true;
    log('info', 'supervisor stopping');
    if (child) stopChild(child);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  log('info', `supervisor started pid=${process.pid} port=${cfg.port} data=${cfg.dataDir}`);
  launch();
}

function isMain() {
  if (!process.argv[1]) return false;
  const a = path.resolve(process.argv[1]);
  const b = fileURLToPath(import.meta.url);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

if (isMain()) await supervise();
