import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { computeBackoff } from '../run.js';
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
