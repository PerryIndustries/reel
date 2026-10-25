// Engagement: how many likes, comments and followers a post earns and when. Ports the v-current curves
// from docs/index.html (totals, followBump, viral, curve, storyStats). Everything is a pure function of the
// post seed and `now`; nothing here reads a clock or Math.random, so the same post shows the same numbers
// on every read and after every restart.
import { rng } from './accounts.js';
import { fanOf } from './writer.js';

const H = 3600_000;
const MIN = 60_000;
const LEVEL = { low: 0.45, normal: 1, high: 2.2, viral: 5 };

// The most comments a post ever shows. The writer stores 6-20 comment rows per post (12 by default), and
// countsAt must never claim more comments than there are rows, so the target stays at the default.
export const MAX_COMMENTS = 12;

const isObj = (v) => v && typeof v === 'object';

function parseJson(v, dflt) {
  if (isObj(v)) return v;
  if (typeof v !== 'string' || !v) return dflt;
  try { const j = JSON.parse(v); return isObj(j) ? j : dflt; } catch { return dflt; }
}

// v1 curve: a burst in the first minutes, then it keeps climbing toward 1 over about `tau`.
const curve = (age, tau) => (age <= 0 ? 0 : 1 - 0.9 * Math.exp(-age / tau) - 0.1 * Math.exp(-age / (6 * MIN)));

// v1 viral(): about 4% of the made-up accounts' posts blow up. Your own accounts never do.
function isViral(post, acct) {
  return !acct.own && rng((post.seed ^ 0x45d9f3b) >>> 0)() < 0.04;
}

// -> {likes, comments, followers, viral}: the totals this post grows toward. Fixed by post.seed and the
// account's followers / settings.level, so it can be stored at publish time and recomputed identically.
export function makeTargets(post, acct) {
  const s = parseJson(acct.settings, {});
  const lv = LEVEL[s.level] || 1;
  const followers = Math.max(0, Number(acct.followers) || 0);
  const story = post.kind === 'story';
  const viral = !story && isViral(post, acct);
  // followers gained (v1 followBump)
  const rf = rng((post.seed ^ 0x7f4a7c15) >>> 0);
  let frate = story ? 0.003 + rf() * 0.007 : 0.012 + rf() * 0.03;
  if (!story && rf() < 0.15) frate *= 2.5 + rf() * 3;
  if (viral) frate *= 10;
  const gained = Math.round(followers * frate * Math.sqrt(lv));
  if (story) {
    // v1 storyStats: views are a share of followers, likes a share of the views
    const r = rng((post.seed ^ 0x2545f491) >>> 0);
    const views = Math.round(followers * (0.12 + r() * 0.18) * lv);
    return { likes: Math.round(views * (0.05 + r() * 0.07)), comments: 0, followers: gained, viral: false };
  }
  // likes and comments (v1 totals; the PC always writes in the thirsty style)
  const r = rng(post.seed >>> 0);
  let rate = (0.05 + r() * 0.08) * lv;
  if (r() < 0.12) rate *= 2 + r() * 3.5;
  const boost = viral ? 25 + rng((post.seed ^ 0x45d9f3b) >>> 0)() * 75 : 1;
  const likes = Math.round(followers * Math.min(rate, 2.5) * boost);
  const comments = Math.min(MAX_COMMENTS, Math.max(3, Math.round(likes * (0.03 + r() * 0.03))));
  return { likes, comments, followers: gained, viral };
}

// The moments the first n comments land: a few within minutes, then a long tail over up to 48 h. Built
// from running gaps, so it is sorted, and the first k times do not depend on n. That keeps the writer's
// stored rows and countsAt in step whatever number of comments was written.
export function commentTimes(post, n) {
  const base = post.up_at ?? post.due_at ?? 0;
  const r = rng(((post.seed >>> 0) ^ 0x9e3779b9) >>> 0);
  const out = [];
  let off = 0;
  for (let k = 0; k < n; k++) {
    off += k < 3
      ? (k === 0 ? 20 + r() * 300 : 10 + r() * 90) * 1000
      : -(15 * MIN * (k - 2)) * Math.log(1 - r() * 0.97);
    out.push(Math.round(base + Math.min(off, 48 * H)));
  }
  return out;
}

// -> {likes, comments} visible `now`. Likes follow the curve toward targets.likes (plus your own like);
// comments are the comment times already passed, so with `rows` (how many comment rows exist) it never
// exceeds what is stored.
export function countsAt(post, now, rows) {
  const t = parseJson(post.targets, null);
  const upAt = post.up_at;
  if (!t || upAt == null) return { likes: 0, comments: 0 };
  const age = now - upAt;
  if (age <= 0) return { likes: 0, comments: 0 };
  const likes = Math.round((t.likes || 0) * curve(age, 4 * H)) + (post.liked ? 1 : 0);
  let comments = commentTimes(post, t.comments || 0).filter((at) => at <= now).length;
  if (Number.isFinite(rows)) comments = Math.min(comments, rows);
  return { likes, comments };
}

// The follower count a post has brought in by `now`.
export function followersGained(post, now) {
  const t = parseJson(post.targets, null);
  if (!t || post.up_at == null) return 0;
  return Math.round((t.followers || 0) * curve(now - post.up_at, 5 * H));
}

// Writes `activity` rows for the owner's accounts as their live posts grow: a new comment, a follow, a
// round of likes. At most one row per post per tick; what has already been reported is kept in
// targets.act so a restart never repeats a row. Returns the number of rows written.
export function activityTick(ctx, now) {
  const { db } = ctx;
  const posts = db.prepare(`SELECT p.* FROM posts p JOIN accounts a ON a.id = p.acct
    WHERE a.own = 1 AND p.status = 'live' AND p.kind <> 'story' AND p.up_at IS NOT NULL AND p.up_at > ? AND p.up_at <= ?
    ORDER BY p.up_at`).all(now - 3 * 24 * H, now);
  const ins = db.prepare('INSERT INTO activity(type, acct, who, who_pfp, post, text, at) VALUES (?,?,?,?,?,?,?)');
  const save = db.prepare('UPDATE posts SET targets = ? WHERE id = ?');
  let n = 0;
  for (const p of posts) {
    const t = parseJson(p.targets, null);
    if (!t) continue;
    const act = { l: 0, c: 0, f: 0, ...(t.act || {}) };
    const rr = rng(((p.seed >>> 0) ^ 0x51ed27) >>> 0);
    const fan = fanOf(ctx, Math.floor(rr() * 240));
    const comments = db.prepare('SELECT * FROM comments WHERE post = ? AND mine = 0 AND owner_reply = 0 AND at <= ? ORDER BY at').all(p.id, now);
    const counts = countsAt(p, now, comments.length);
    const fb = followersGained(p, now);
    const followAt = Math.min(now, p.up_at + (20 + rr() * 90) * MIN);
    if (comments.length > act.c) {
      const c = comments[comments.length - 1];
      ins.run('comment', p.acct, c.author, c.author_pfp ?? '', p.id, c.text, c.at);
      act.c = comments.length;
    } else if (act.f === 0 && fb > 0 && now >= followAt) {
      ins.run('follow', p.acct, fan.handle, fan.pfp, p.id, fb > 1 ? `and ${fb - 1} others` : '', followAt);
      act.f = fb;
    } else if (counts.likes > 2 && now >= p.up_at + 25 * MIN && counts.likes - act.l >= Math.max(3, Math.ceil(act.l * 0.5))) {
      ins.run('like', p.acct, fan.handle, fan.pfp, p.id, `and ${counts.likes - 1} others`, now);
      act.l = counts.likes;
    } else continue;
    save.run(JSON.stringify({ ...t, act }), p.id);
    n++;
  }
  return n;
}
