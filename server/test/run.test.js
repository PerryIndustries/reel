import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { computeBackoff, stopChild, needsSelfRestart } from '../run.js';
import { makeLog } from '../lib/log.js';
import { tempEnv, removeTempDir } from './helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));

test('computeBackoff starts at 2 s and doubles up to a 60 s cap', () => {
  const seq = [];
  let b = 0;
  for (let i = 0; i < 8; i++) { b = computeBackoff(b, 1000); seq.push(b); }
  assert.deepEqual(seq, [2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000]);
});

test('computeBackoff resets to 2 s after 10 min of uptime', () => {
  assert.equal(computeBackoff(60000, 10 * 60_000), 2000);
  assert.equal(computeBackoff(60000, 10 * 60_000 - 1), 60000);
});

test('log rotation yields engine.log.1 and never more than 3 rotated files', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-log-'));
  t.after(() => removeTempDir(dir));
  const log = makeLog(dir, { maxBytes: 200 });
  for (let i = 0; i < 60; i++) log('info', `line ${i} ${'x'.repeat(30)}`);
  const files = fs.readdirSync(dir).sort();
  assert.deepEqual(files, ['engine.log', 'engine.log.1', 'engine.log.2', 'engine.log.3']);
  assert.ok(fs.statSync(path.join(dir, 'engine.log')).size <= 200);
  assert.match(fs.readFileSync(path.join(dir, 'engine.log'), 'utf8'), /line 59/);
});

test('log lines carry the level, message and extra JSON', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-log-'));
  t.after(() => removeTempDir(dir));
  makeLog(dir)('warn', 'hello', { n: 1 });
  assert.match(fs.readFileSync(path.join(dir, 'engine.log'), 'utf8'), /warn hello \{"n":1\}/);
});

test('supervisor refuses to start a second copy when the port already listens', async (t) => {
  const srv = http.createServer((req, res) => res.end('busy'));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());
  const env = tempEnv({ REEL_PORT: String(srv.address().port) });
  t.after(() => removeTempDir(env.REEL_DATA));
  const { code, stdout } = await new Promise((resolve) => {
    execFile(process.execPath, [path.join(here, '..', 'run.js')], { env, timeout: 15000 }, (err, stdout) => {
      resolve({ code: err ? err.code : 0, stdout });
    });
  });
  assert.equal(code, 0);
  assert.match(stdout, /already running/);
});

test('stopChild on win32 runs taskkill /PID <pid> /T /F and not child.kill()', () => {
  const calls = [];
  let killed = false;
  stopChild({ pid: 4242, kill: () => { killed = true; } }, 'win32', (cmd, args, opts) => { calls.push({ cmd, args, opts }); return { status: 0 }; });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'taskkill');
  assert.deepEqual(calls[0].args, ['/PID', '4242', '/T', '/F']);
  assert.equal(calls[0].opts.windowsHide, true);
  assert.equal(killed, false);
});

test('stopChild elsewhere uses child.kill()', () => {
  let killed = false;
  stopChild({ pid: 1, kill: () => { killed = true; } }, 'linux', () => assert.fail('no taskkill off Windows'));
  assert.equal(killed, true);
});

test('stopChild takes a grandchild down with the child (real processes)', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-tree-'));
  t.after(() => removeTempDir(dir));
  const pidFile = path.join(dir, 'grandchild.pid');
  const script = path.join(dir, 'child.js');
  fs.writeFileSync(script, `
    const { spawn } = require('node:child_process');
    const fs = require('node:fs');
    const g = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore', windowsHide: true, detached: true });
    fs.writeFileSync(process.argv[2], String(g.pid));
    setTimeout(() => {}, 60000);
  `);
  const child = spawn(process.execPath, [script, pidFile], { stdio: 'ignore', windowsHide: true, detached: true });
  const exited = new Promise((r) => child.once('exit', r));
  let gpid = 0;
  for (let i = 0; i < 100 && !gpid; i++) {
    await new Promise((r) => setTimeout(r, 50));
    try { gpid = Number(fs.readFileSync(pidFile, 'utf8')); } catch { /* not yet */ }
  }
  assert.ok(gpid > 0, 'grandchild started');
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  assert.ok(alive(gpid));
  t.after(() => { try { process.kill(gpid, 'SIGKILL'); } catch { /* gone */ } });
  stopChild(child);
  await exited;
  for (let i = 0; i < 60 && alive(gpid); i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(alive(gpid), false, 'grandchild is gone');
});

test('needsSelfRestart is true only when server/run.js changed', () => {
  assert.equal(needsSelfRestart(['docs/index.html', 'server/run.js']), true);
  assert.equal(needsSelfRestart(['server' + String.fromCharCode(92) + 'run.js']), true);
  assert.equal(needsSelfRestart(['server/main.js', 'server/lib/run.js', 'docs/server/run.js.md']), false);
  assert.equal(needsSelfRestart([]), false);
});
