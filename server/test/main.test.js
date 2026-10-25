import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempEnv, removeTempDir, getJson, postJson, waitFor } from './helpers.js';

const MAIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'main.js');

test('an unhandled rejection is logged and the engine keeps serving', async (t) => {
  const env = tempEnv({ REEL_TEST_HOOKS: '1' });
  const child = spawn(process.execPath, [MAIN], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  let exited = null;
  child.on('exit', (code) => { exited = code; });
  t.after(async () => {
    if (exited === null) { child.kill(); await waitFor(() => exited !== null, 3000); }
    removeTempDir(env.REEL_DATA);
  });
  const m = await waitFor(() => /listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(out) || exited !== null, 8000);
  assert.ok(m && m !== true, `engine did not start: ${out}`);
  const base = m[1];
  const r = await postJson(`${base}/reel/api/__test/reject`, {});
  assert.equal(r.status, 200);
  await new Promise((res) => setTimeout(res, 300));
  assert.equal(exited, null, `engine exited (${exited}) on a rejection: ${out}`);
  const s = await getJson(`${base}/reel/api/status`);
  assert.equal(s.status, 200);
  const logText = fs.readFileSync(path.join(env.REEL_DATA, 'logs', 'engine.log'), 'utf8');
  assert.match(logText, /unhandled rejection: injected rejection/);
});
