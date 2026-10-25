// Shared test helpers. Every test gets its own temp REEL_DATA and an engine on a random port;
// nothing here ever touches the real data dir, the real Drive or the real Ollama.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startEngine } from '../main.js';

const tempDirs = new Set();

// Env for one test: process.env without any REEL_* keys, plus a fresh temp REEL_DATA, port 0,
// a fast tick loop, and rclone / Ollama pointing nowhere unless `extra` gives them.
export function tempEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('REEL_')) env[k] = v;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-test-'));
  tempDirs.add(dataDir);
  return {
    ...env,
    REEL_DATA: dataDir,
    REEL_PORT: '0',
    REEL_TICK_MS: '10',
    REEL_RCLONE: JSON.stringify(['reel-test-no-such-rclone']),
    REEL_OLLAMA: 'http://127.0.0.1:9',
    REEL_STYLE: path.join(dataDir, 'no-style.json'),
    ...extra,
  };
}

export function removeTempDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  tempDirs.delete(dir);
}

// Starts an engine on a temp data dir. `stop()` stops it and deletes the data dir.
export async function startTestEngine(extra = {}) {
  const env = tempEnv(extra);
  const engine = await startEngine(env);
  const base = `http://127.0.0.1:${engine.server.address().port}`;
  let stopped = false;
  return {
    ctx: engine.ctx,
    server: engine.server,
    env,
    dataDir: env.REEL_DATA,
    base,
    async stop() {
      if (stopped) return;
      stopped = true;
      await engine.stop();
      removeTempDir(env.REEL_DATA);
    },
  };
}

async function readJson(res) {
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, headers: res.headers, body };
}

// -> {status, headers, body} (body parsed as JSON when it is JSON, else the raw text)
export async function getJson(url) {
  return readJson(await fetch(url));
}

// -> {status, headers, body}; method defaults to POST
export async function postJson(url, body, method = 'POST') {
  return readJson(await fetch(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
}

// Polls `fn` until it returns truthy or `ms` elapses; returns the last value.
export async function waitFor(fn, ms = 3000, every = 10) {
  const end = Date.now() + ms;
  let v;
  while (!(v = await fn()) && Date.now() < end) await new Promise((r) => setTimeout(r, every));
  return v;
}
