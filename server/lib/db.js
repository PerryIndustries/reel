// SQLite (node:sqlite, WAL). The whole schema lives here so every module agrees on columns;
// a module that needs a new column calls ensureColumn() from its own start(), never edits this file.
import fs from 'node:fs';
import path from 'node:path';
import './quiet.js';
// loaded after quiet.js has run, so its ExperimentalWarning is filtered
const { DatabaseSync } = await import('node:sqlite');

export const SETTINGS_DEFAULTS = Object.freeze({
  postsPerDay: 50,
  ownShare: 0.4,
  itemsPerOther: 40,
  maxOthers: 80,
  drivePath: '',
  extraRoots: Object.freeze([]),
});

const SCHEMA = `
CREATE TABLE IF NOT EXISTS items (
  key TEXT PRIMARY KEY,
  path TEXT,
  folder TEXT,
  drive_id TEXT,
  kind TEXT,              -- 'photo' | 'video'
  w INT,
  h INT,
  dur REAL,
  size INT,
  md5 TEXT,
  parent TEXT,            -- clip parent key
  acct TEXT,
  derived INT DEFAULT 0,  -- 0 | 1
  err TEXT,
  err_at INT,
  gone INT DEFAULT 0,
  gone_at INT,
  seen_at INT,
  up INT DEFAULT 0,
  down INT DEFAULT 0,
  desc TEXT,
  added_at INT
);
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  own INT,
  handle TEXT,
  name TEXT,
  bio TEXT,
  pfp TEXT,
  settings TEXT,          -- json
  created_at INT,
  followers INT,
  quiet INT DEFAULT 0,
  seed INT
);
CREATE TABLE IF NOT EXISTS posts (
  id TEXT PRIMARY KEY,
  acct TEXT,
  items TEXT,             -- json array of item keys
  kind TEXT,              -- 'post' | 'story' | 'reel'
  caption TEXT,
  status TEXT,            -- 'queued' | 'live' | 'down'
  due_at INT,
  up_at INT,
  down_at INT,
  targets TEXT,           -- json
  liked INT,
  saved INT,
  pinned INT,
  cycled INT DEFAULT 0,
  seed INT,
  story_text TEXT,
  highlight INT DEFAULT 0,
  created_at INT
);
CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY,
  post TEXT,
  author TEXT,            -- fan handle or acct id
  author_pfp TEXT,
  text TEXT,
  at INT,
  owner_reply INT DEFAULT 0,
  mine INT DEFAULT 0
);
CREATE TABLE IF NOT EXISTS convos (
  id TEXT PRIMARY KEY,    -- acct|fan
  acct TEXT,
  fan TEXT,
  fan_handle TEXT,
  fan_pfp TEXT,
  state TEXT,             -- json
  next_at INT,
  unread INT
);
CREATE TABLE IF NOT EXISTS dms (
  id INTEGER PRIMARY KEY,
  convo TEXT,
  from_me INT,
  text TEXT,
  at INT,
  seen INT
);
CREATE TABLE IF NOT EXISTS writer_jobs (
  id INTEGER PRIMARY KEY,
  kind TEXT,              -- 'describe' | 'caption' | 'comments' | 'story' | 'dm' | 'rewrite'
  ref TEXT,
  prio INT,
  due_at INT,
  status TEXT,            -- 'todo' | 'done' | 'failed'
  tries INT,
  payload TEXT,
  created_at INT,
  UNIQUE(kind, ref, status)
);
CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY,
  type TEXT,
  acct TEXT,
  who TEXT,
  who_pfp TEXT,
  post TEXT,
  text TEXT,
  at INT
);
CREATE TABLE IF NOT EXISTS settings (
  k TEXT PRIMARY KEY,
  v TEXT                  -- json
);
CREATE INDEX IF NOT EXISTS posts_status_due ON posts(status, due_at);
CREATE INDEX IF NOT EXISTS posts_acct ON posts(acct);
CREATE INDEX IF NOT EXISTS items_acct ON items(acct);
CREATE INDEX IF NOT EXISTS writer_jobs_next ON writer_jobs(status, prio, due_at);
`;

export function openDb(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec(SCHEMA);
  return db;
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Adds `col` to `table` when it is missing. `type` is a column definition like `INT DEFAULT 0`.
// Returns true when it added the column.
export function ensureColumn(db, table, col, type) {
  if (!IDENT.test(table) || !IDENT.test(col)) throw new Error(`bad identifier: ${table}.${col}`);
  if (!/^[A-Za-z0-9_ ().,'-]*$/.test(type)) throw new Error(`bad column type: ${type}`);
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (cols.length === 0) throw new Error(`no such table: ${table}`);
  if (cols.some((c) => c.name === col)) return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
  return true;
}

function clone(v) {
  return v && typeof v === 'object' ? JSON.parse(JSON.stringify(v)) : v;
}

// The stored JSON value of `key`; else `dflt`; else the SETTINGS_DEFAULTS value (or undefined).
export function getSetting(db, key, dflt) {
  const row = db.prepare('SELECT v FROM settings WHERE k = ?').get(key);
  if (row && row.v != null) return JSON.parse(row.v);
  return dflt !== undefined ? dflt : clone(SETTINGS_DEFAULTS[key]);
}

export function setSetting(db, key, value) {
  db.prepare('INSERT INTO settings(k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v')
    .run(key, JSON.stringify(value));
}

// The user-facing settings object: every SETTINGS_DEFAULTS key, stored values winning.
// Other keys in the settings table (module bookkeeping) are not included.
export function allSettings(db) {
  const out = clone({ ...SETTINGS_DEFAULTS });
  for (const key of Object.keys(SETTINGS_DEFAULTS)) {
    const row = db.prepare('SELECT v FROM settings WHERE k = ?').get(key);
    if (row && row.v != null) out[key] = JSON.parse(row.v);
  }
  return out;
}

// Runs synchronous fn inside BEGIN/COMMIT, rolling back when it throws. Inside an already open
// transaction it just runs fn (the outer transaction owns commit/rollback).
export function tx(db, fn) {
  if (db.isTransaction) return fn();
  db.exec('BEGIN');
  try {
    const r = fn();
    if (r && typeof r.then === 'function') throw new Error('tx(fn) must be synchronous');
    db.exec('COMMIT');
    return r;
  } catch (e) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw e;
  }
}

function yyyymmdd(now) {
  const d = new Date(now);
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

// Writes a consistent copy to `<dbPath>.bak.<yyyymmdd>` (local date of `now`) unless that day's
// copy exists, then keeps only the newest `keep`. Returns true when it wrote a backup.
export function backupNightly(db, dbPath, now, keep = 3) {
  const target = `${dbPath}.bak.${yyyymmdd(now)}`;
  if (fs.existsSync(target)) return false;
  db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  const dir = path.dirname(dbPath);
  const prefix = `${path.basename(dbPath)}.bak.`;
  const baks = fs.readdirSync(dir)
    .filter((f) => f.startsWith(prefix) && /^\d{8}$/.test(f.slice(prefix.length)))
    .sort();
  for (const f of baks.slice(0, Math.max(0, baks.length - keep))) fs.rmSync(path.join(dir, f), { force: true });
  return true;
}
