import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, ensureColumn, getSetting, setSetting, allSettings, tx, backupNightly } from '../lib/db.js';
import { removeTempDir } from './helpers.js';

// A temp dir whose cleanup closes every db opened through `open` before deleting the dir
// (Windows will not delete an open SQLite file).
function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-db-'));
  const dbs = [];
  t.after(() => {
    for (const db of dbs) if (db.isOpen) db.close();
    removeTempDir(dir);
  });
  return { dir, dbPath: path.join(dir, 'reel.db'), open: (p = path.join(dir, 'reel.db')) => { const db = openDb(p); dbs.push(db); return db; } };
}

const TABLES = ['accounts', 'activity', 'comments', 'convos', 'dms', 'items', 'posts', 'settings', 'writer_jobs'];

test('openDb creates every table in WAL mode', (t) => {
  const db = tempDir(t).open();
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name);
  assert.deepEqual(names, TABLES);
  assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
});

test('reopening an existing db is idempotent and keeps its rows', (t) => {
  const tmp = tempDir(t);
  const a = tmp.open();
  a.prepare("INSERT INTO items(key, kind) VALUES ('f1', 'photo')").run();
  a.close();
  const b = tmp.open();
  assert.equal(b.prepare('SELECT count(*) AS n FROM items').get().n, 1);
});

test('items get gone/up/down/derived = 0 by default', (t) => {
  const db = tempDir(t).open();
  db.prepare("INSERT INTO items(key, kind) VALUES ('f1', 'photo')").run();
  const row = db.prepare("SELECT gone, up, down, derived FROM items WHERE key='f1'").get();
  assert.deepEqual({ ...row }, { gone: 0, up: 0, down: 0, derived: 0 });
});

test('setSetting / allSettings round-trip and fill defaults for missing keys', (t) => {
  const db = tempDir(t).open();
  setSetting(db, 'postsPerDay', 12);
  setSetting(db, 'extraRoots', ['a/b']);
  assert.deepEqual(allSettings(db), {
    postsPerDay: 12, ownShare: 0.4, itemsPerOther: 40, maxOthers: 80, drivePath: '', extraRoots: ['a/b'],
  });
});

test('getSetting returns the stored JSON value, else the given default', (t) => {
  const db = tempDir(t).open();
  assert.equal(getSetting(db, 'nope', 'dflt'), 'dflt');
  setSetting(db, 'obj', { a: [1, 2] });
  assert.deepEqual(getSetting(db, 'obj', null), { a: [1, 2] });
});

test('ensureColumn adds a missing column once', (t) => {
  const db = tempDir(t).open();
  ensureColumn(db, 'items', 'extra_col', 'INT');
  ensureColumn(db, 'items', 'extra_col', 'INT');
  const cols = db.prepare('PRAGMA table_info(items)').all().filter((c) => c.name === 'extra_col');
  assert.equal(cols.length, 1);
});

test('tx rolls back when fn throws', (t) => {
  const db = tempDir(t).open();
  assert.throws(() => tx(db, () => {
    db.prepare("INSERT INTO items(key, kind) VALUES ('f1', 'photo')").run();
    throw new Error('boom');
  }), /boom/);
  assert.equal(db.prepare('SELECT count(*) AS n FROM items').get().n, 0);
});

test('backupNightly copies at most once per day and keeps the newest 3', (t) => {
  const { dir, dbPath, open } = tempDir(t);
  const db = open();
  db.prepare("INSERT INTO items(key, kind) VALUES ('f1', 'photo')").run();
  const day = (d) => new Date(2026, 9, d, 12).getTime();
  assert.equal(backupNightly(db, dbPath, day(1)), true);
  assert.equal(backupNightly(db, dbPath, day(1) + 3600_000), false);
  for (const d of [2, 3, 4]) backupNightly(db, dbPath, day(d));
  const baks = fs.readdirSync(dir).filter((f) => f.startsWith('reel.db.bak.')).sort();
  assert.deepEqual(baks, ['reel.db.bak.20261002', 'reel.db.bak.20261003', 'reel.db.bak.20261004']);
  const copy = open(path.join(dir, 'reel.db.bak.20261004'));
  assert.equal(copy.prepare('SELECT count(*) AS n FROM items').get().n, 1);
});
