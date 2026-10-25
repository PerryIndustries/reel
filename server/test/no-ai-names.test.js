// Hard line: nothing the app shows may say "AI". Generated account and fan handles must never read as AI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempEnv, removeTempDir } from './helpers.js';
import { loadConfig } from '../lib/config.js';
import { openDb } from '../lib/db.js';
import { gamerHandle } from '../lib/accounts.js';
import { fanOf, saysAI } from '../lib/writer.js';

function seeded(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

test('generated account handles never read as AI', () => {
  for (let seed = 1; seed <= 20000; seed++) {
    const h = gamerHandle(seeded(seed));
    assert.equal(saysAI(h), false, `handle "${h}" (seed ${seed}) reads as AI`);
  }
});

test('fan handles never read as AI', (t) => {
  const env = tempEnv();
  const cfg = loadConfig(env);
  const db = openDb(cfg.dbPath);
  t.after(() => { db.close(); removeTempDir(env.REEL_DATA); });
  for (let run = 0; run < 40; run++) {
    db.prepare("DELETE FROM settings WHERE k = 'fanSeed'").run();
    const ctx = { cfg, db, rand: seeded(run + 1), state: {} };
    for (let i = 0; i < 240; i++) {
      const f = fanOf(ctx, i);
      assert.equal(saysAI(f.handle), false, `fan "${f.handle}" reads as AI`);
    }
  }
});
