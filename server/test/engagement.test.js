// Engagement: targets, the growth curve and the comment times the writer uses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeTargets, countsAt, commentTimes, activityTick } from '../lib/engagement.js';
import { tempEnv, removeTempDir } from './helpers.js';
import { loadConfig } from '../lib/config.js';
import { openDb } from '../lib/db.js';

const H = 3600_000;
const T = Date.UTC(2026, 9, 20, 12, 0, 0);
const ACCT = { id: 'n1', own: 0, followers: 5000, seed: 77, settings: '{}' };

function post(seed) {
  const p = { id: 'p' + seed, acct: 'n1', kind: 'post', seed, up_at: T, liked: 0 };
  p.targets = JSON.stringify(makeTargets(p, ACCT));
  return p;
}

test('countsAt is monotonic in time and deterministic for a seed', () => {
  for (const seed of [1, 99, 4242, 123456789]) {
    const p = post(seed);
    assert.deepEqual(makeTargets({ ...p }, ACCT), JSON.parse(p.targets), 'targets are fixed by the seed');
    const t = JSON.parse(p.targets);
    assert.ok(t.likes > 0 && t.comments >= 3);
    let prev = { likes: 0, comments: 0 };
    assert.deepEqual(countsAt(p, T - H), { likes: 0, comments: 0 });
    for (let now = T; now <= T + 72 * H; now += 7 * 60_000) {
      const c = countsAt(p, now);
      assert.deepEqual(countsAt(p, now), c, 'same post, same time, same counts');
      assert.ok(c.likes >= prev.likes && c.comments >= prev.comments, `went down at +${(now - T) / H}h`);
      prev = c;
    }
    assert.ok(prev.likes >= Math.floor(t.likes * 0.99) && prev.likes <= t.likes, `ends near the target: ${prev.likes}/${t.likes}`);
  }
});

test('the k-th comment time is when countsAt first shows k+1 comments', () => {
  const p = post(31337);
  const n = JSON.parse(p.targets).comments;
  const times = commentTimes(p, n);
  assert.equal(times.length, n);
  assert.deepEqual(commentTimes(p, n), times);
  assert.deepEqual([...times].sort((a, b) => a - b), times);
  for (let now = T; now <= T + 48 * H; now += 3 * 60_000) {
    assert.equal(times.filter((at) => at <= now).length, countsAt(p, now).comments, `at +${(now - T) / 60_000} min`);
  }
});

test('viral posts exist only on made-up accounts, about 4% of them, and are far bigger', () => {
  const own = { ...ACCT, own: 1 };
  let viral = 0;
  let bigger = 0;
  for (let seed = 1; seed <= 2000; seed++) {
    assert.equal(makeTargets({ seed, kind: 'post' }, own).viral, false);
    const t = makeTargets({ seed, kind: 'post' }, ACCT);
    if (t.viral) { viral++; if (t.likes > 5000 * 25 * 0.05) bigger++; }
  }
  assert.ok(viral > 40 && viral < 130, `viral ${viral}/2000`);
  assert.equal(bigger, viral);
});

test('story targets have no comments and far fewer followers than a post', () => {
  const s = makeTargets({ seed: 5, kind: 'story' }, ACCT);
  assert.equal(s.comments, 0);
  assert.equal(s.viral, false);
  assert.ok(s.likes > 0);
  assert.ok(s.followers <= makeTargets({ seed: 5, kind: 'post' }, ACCT).followers);
});

test('countsAt never shows more comments than there are stored rows', () => {
  const p = post(8);
  assert.equal(countsAt(p, T + 48 * H, 5).comments, 5);
  assert.equal(countsAt(p, T + 48 * H, 99).comments, JSON.parse(p.targets).comments);
  assert.equal(countsAt({ ...p, liked: 1 }, T + 48 * H).likes, countsAt(p, T + 48 * H).likes + 1);
});

test('commentTimes is sorted, starts within minutes, stays inside 48 h and does not change with n', () => {
  const p = post(77);
  const a = commentTimes(p, 20);
  assert.ok(a[0] - T >= 20_000 && a[0] - T <= 330_000);
  assert.ok(a.every((x, i) => i === 0 || x >= a[i - 1]) && a.at(-1) - T <= 48 * H);
  assert.deepEqual(commentTimes(p, 7), a.slice(0, 7));
});

test('activityTick writes at most one row per post per tick and never repeats a report', (t) => {
  const env = tempEnv();
  const cfg = loadConfig(env);
  const db = openDb(cfg.dbPath);
  t.after(() => { db.close(); removeTempDir(env.REEL_DATA); });
  const ctx = { cfg, db, log: () => {}, state: {}, ticks: [], hooks: { gone: [] }, rand: () => 0.5 };
  db.prepare("INSERT INTO accounts(id, own, handle, name, bio, pfp, settings, created_at, followers, quiet, seed) VALUES ('a1',1,'h','n','','','{}',0,5000,0,1)").run();
  const p = post(31);
  db.prepare('INSERT INTO posts(id, acct, items, kind, caption, status, due_at, up_at, targets, liked, saved, pinned, seed) VALUES (?,?,?,?,?,?,?,?,?,0,0,0,?)')
    .run('p1', 'a1', '["k"]', 'post', 'c', 'live', T, T, p.targets, p.seed);
  const times = commentTimes(p, 4);
  times.forEach((at, i) => db.prepare("INSERT INTO comments(post, author, author_pfp, text, at) VALUES ('p1', ?, '', ?, ?)").run('fan' + i, 'c' + i, at));
  let total = 0;
  for (let now = T; now <= T + 72 * H; now += 60_000) {
    const n = activityTick(ctx, now);
    assert.ok(n <= 1);
    total += n;
  }
  const by = Object.fromEntries(db.prepare('SELECT type, COUNT(*) n FROM activity GROUP BY type').all().map((r) => [r.type, r.n]));
  assert.ok(by.comment >= 2 && by.comment <= 4, `comment rows ${by.comment}`);
  assert.equal(by.follow, 1);
  assert.ok(by.like >= 2);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM activity').get().n, total);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM activity WHERE acct <> 'a1'").get().n, 0);
});
