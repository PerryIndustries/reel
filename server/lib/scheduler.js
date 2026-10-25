// Scheduler: the bot. Keeps every account's queue filled 48 h ahead, publishes what is due, plans stories,
// takes posts down after their life and puts the photos back in the pool (sometimes with another account),
// and reacts to files that disappeared from the Drive. Ports the v50 rules from docs/index.html (nextSlot,
// lifeOf, cyclePosts, groupPosts, autoStories, autoHighlights). Everything is driven by stored due_at and by
// the `now` it is handed; no timers.
import { allSettings, tx } from './db.js';
import { hashStr, rng } from './accounts.js';
import { enqueue, fallbackText } from './writer.js';
import { makeTargets, activityTick } from './engagement.js';

const MIN = 60_000;
const H = 3600_000;
const D = 24 * H;
const HORIZON = 48 * H;
const KEEP_MIN = 9;
const MULTI = { off: 0, some: 0.35, lots: 0.6 };
const POSTABLE = 'derived = 1 AND err IS NULL AND gone = 0';

const parseItems = (s) => { try { const a = JSON.parse(s || '[]'); return Array.isArray(a) ? a : []; } catch { return []; } };
const settingsOf = (a) => { try { return JSON.parse(a.settings || '{}') || {}; } catch { return {}; } };
const nextRand = (ctx) => (ctx.rand ?? Math.random)();

// ---- time rules -------------------------------------------------------------------------------------
// Your own accounts stay quiet from midnight to 09:00 local.
export function isOwnQuiet(ts) {
  return new Date(ts).getHours() < 9;
}

// v1 humanize: a time in the quiet hours moves to 09:00 plus up to 2.5 h of jitter.
function humanize(t) {
  const d = new Date(t);
  if (d.getHours() >= 9) return t;
  d.setHours(9, 0, 0, 0);
  return d.getTime() + Math.floor(rng(hashStr('q' + t))() * 150) * MIN;
}

// v50: how long a post stays up. 15% 0.5-8 h ("posted then panicked"), 45% 12-72 h, 40% 3-8 days. Fixed per post.
export function lifeOf(post) {
  const r = rng(((Number(post.seed) >>> 0) ^ hashStr('life')) >>> 0);
  const x = r();
  return x < 0.15 ? (0.5 + r() * 7.5) * H : x < 0.6 ? (12 + r() * 60) * H : (3 + r() * 5) * D;
}

const keptFlag = (p) => !!(p.liked || p.saved || p.pinned);

// posts per day for each non-quiet account: postsPerDay shared by their postable item counts
function rates(ctx) {
  const ppd = Number(allSettings(ctx.db).postsPerDay) || 0;
  const rows = ctx.db.prepare(`SELECT a.id, COUNT(i.key) n FROM accounts a LEFT JOIN items i ON i.acct = a.id AND i.${POSTABLE.replace(/ AND /g, ' AND i.')}
    WHERE a.quiet = 0 GROUP BY a.id`).all();
  const total = rows.reduce((s, r) => s + r.n, 0);
  const out = new Map();
  for (const r of rows) out.set(r.id, total ? ppd * r.n / total : 0);
  return out;
}

const stepOf = (ctx, acct, rate) => D / Math.max(rate ?? rates(ctx).get(acct.id) ?? 0, 0.05);

// v50 bursty gap mixture: a quarter of the gaps are tiny (two or three posts close together), half are
// ordinary and the rest are long, with the same average. Others post at half rate 01:00-07:00. Own accounts
// never land in 00:00-09:00. `step` is the average gap (24 h / posts per day), looked up when not given.
export function nextSlot(ctx, acct, after, step) {
  const st = step ?? stepOf(ctx, acct);
  const r = rng(hashStr('j' + after + acct.seed));
  const x = r();
  let gap = st * (x < 0.25 ? 0.05 + r() * 0.2 : x < 0.75 ? 0.6 + r() * 0.8 : 1.5 + r() * 1.1);
  const hour = new Date(after).getHours();
  if (!acct.own && hour >= 1 && hour < 7) gap *= 2;
  const t = after + Math.max(gap, 5 * MIN);
  return acct.own ? humanize(t) : t;
}

// ---- ids ---------------------------------------------------------------------------------------------
function newId(ctx, prefix, now) {
  for (;;) {
    const id = prefix + now.toString(36) + Math.floor(nextRand(ctx) * 1e9).toString(36);
    if (!ctx.db.prepare('SELECT 1 FROM posts WHERE id = ?').get(id)) return id;
  }
}

const INSERT_POST = `INSERT INTO posts(id, acct, items, kind, caption, status, due_at, up_at, down_at, targets, liked, saved, pinned, cycled, seed, story_text, highlight, created_at)
  VALUES (?,?,?,?,?, 'queued', ?, NULL, NULL, NULL, 0, 0, 0, ?, ?, '', 0, ?)`;

// ---- planning ----------------------------------------------------------------------------------------
// Which items are in a live or queued post, and which have ever been posted.
function usage(ctx) {
  const inUse = new Set(ctx.db.prepare(`SELECT DISTINCT j.value v FROM posts p, json_each(p.items) j WHERE p.status IN ('live','queued') AND p.kind <> 'story'`).all().map((r) => r.v));
  const posted = new Set(ctx.db.prepare(`SELECT DISTINCT j.value v FROM posts p, json_each(p.items) j WHERE p.status = 'down' AND p.kind <> 'story'`).all().map((r) => r.v));
  return { inUse, posted };
}

const storiesFolder = (it) => String(it.folder || '').split(/[\\/]/).filter(Boolean).pop()?.toLowerCase() === 'stories';

// Random among the unposted items; when two draws tie, a never-posted item goes before a repost.
function pickItem(ctx, pool, posted) {
  let best = null;
  let bestKey = Infinity;
  for (const it of pool) {
    const k = Math.floor(nextRand(ctx) * 1e6);
    if (k < bestKey || (k === bestKey && best && posted.has(best.key) && !posted.has(it.key))) { best = it; bestKey = k; }
  }
  return best;
}

// 35% (scaled by the account's multi setting) of photo posts hold 2-6 photos from the same folder.
function groupFor(ctx, first, pool, prob) {
  if (first.kind !== 'photo' || !(prob > 0) || nextRand(ctx) >= prob) return [first];
  const x = nextRand(ctx);
  const size = x < 0.45 ? 2 : x < 0.8 ? 3 : x < 0.93 ? 4 : 5 + Math.floor(nextRand(ctx) * 2);
  const mates = pool.filter((i) => i.key !== first.key && i.kind === 'photo' && i.folder === first.folder);
  const out = [first];
  while (out.length < size && mates.length) out.push(mates.splice(Math.floor(nextRand(ctx) * mates.length), 1)[0]);
  return out;
}

// Adds a queued post for `items` at `dueAt`; returns its id.
function addPost(ctx, acct, items, dueAt, now, cycled) {
  const id = newId(ctx, 'p_', now);
  const kind = items.length === 1 && items[0].kind === 'video' ? 'reel' : 'post';
  const seed = Math.floor(nextRand(ctx) * 2 ** 31);
  ctx.db.prepare(INSERT_POST).run(id, acct.id, JSON.stringify(items.map((i) => i.key)), kind, '', dueAt, cycled, seed, now);
  return id;
}

// Keeps every account's queue filled 48 h ahead. A brand-new account first gets a profile's worth of older
// posts (v1 starter), so it does not open empty.
export function planPosts(ctx, now) {
  const { db } = ctx;
  const rate = rates(ctx);
  const accts = db.prepare('SELECT * FROM accounts WHERE quiet = 0').all();
  const { inUse, posted } = usage(ctx);
  let made = 0;
  for (const acct of accts) {
    const pool = db.prepare(`SELECT key, folder, kind FROM items WHERE acct = ? AND ${POSTABLE}`).all(acct.id)
      .filter((i) => !inUse.has(i.key) && !storiesFolder(i));
    if (!pool.length) continue;
    const prob = MULTI[settingsOf(acct).multi] ?? 0;
    const step = stepOf(ctx, acct, rate.get(acct.id));
    const take = (items) => { for (const i of items) { inUse.add(i.key); pool.splice(pool.findIndex((p) => p.key === i.key), 1); } };
    const cyc = (items) => (items.some((i) => posted.has(i.key)) ? 1 : 0);

    const any = db.prepare("SELECT 1 FROM posts WHERE acct = ? AND kind <> 'story' LIMIT 1").get(acct.id);
    if (!any) {
      // starter: older posts, one per item, going back a few days each (v1 backdate)
      const n = Math.min(KEEP_MIN, Math.ceil(pool.length / 2));
      const r = rng(hashStr('bd' + now + acct.id));
      let t = now - (1 + r() * 3) * H;
      const ids = [];
      for (let k = 0; k < n; k++) {
        const it = pickItem(ctx, pool, posted);
        take([it]);
        ids.push(addPost(ctx, acct, [it], humanize(t), now, 0));
        t -= (0.6 + r() * 2.8) * D;
        made++;
      }
      for (const id of ids) publish(ctx, id, now);
    }

    const last = db.prepare("SELECT MAX(due_at) m FROM posts WHERE acct = ? AND status = 'queued' AND kind <> 'story'").get(acct.id).m;
    let cursor = Math.max(last ?? 0, now);
    while (pool.length && cursor < now + HORIZON) {
      const first = pickItem(ctx, pool, posted);
      const items = groupFor(ctx, first, pool, prob);
      take(items);
      cursor = nextSlot(ctx, acct, cursor, step);
      addPost(ctx, acct, items, cursor, now, cyc(items));
      made++;
    }
  }
  // posts due within 2 h get their caption written ahead of time
  for (const p of db.prepare("SELECT id FROM posts WHERE status = 'queued' AND kind <> 'story' AND caption = '' AND due_at <= ?").all(now + 2 * H)) {
    enqueue(ctx, 'caption', p.id, 1, now, null);
  }
  return made;
}

// Keeps about a day of stories scheduled per account: files from a "stories" folder first, otherwise reshares
// of the account's own live photos and videos (v1 autoStories).
export function planStories(ctx, now) {
  const { db } = ctx;
  let made = 0;
  for (const acct of db.prepare('SELECT * FROM accounts WHERE quiet = 0').all()) {
    const perDay = Math.max(0, Number(settingsOf(acct).storiesPerDay ?? 3) || 0);
    if (!perDay) continue;
    const step = D / perDay;
    const mine = db.prepare("SELECT items, due_at FROM posts WHERE acct = ? AND kind = 'story' AND status IN ('queued','live')").all(acct.id);
    const shown = new Set(mine.flatMap((s) => parseItems(s.items)));
    let last = mine.reduce((m, s) => Math.max(m, s.due_at || 0), 0) || now - step * 1.5;
    const reshare = db.prepare(`SELECT DISTINCT j.value v FROM posts p, json_each(p.items) j WHERE p.acct = ? AND p.status = 'live' AND p.kind <> 'story'`).all(acct.id).map((r) => r.v);
    const own = db.prepare(`SELECT key, folder FROM items WHERE acct = ? AND ${POSTABLE}`).all(acct.id).filter(storiesFolder).map((i) => i.key).filter((k) => !shown.has(k));
    for (let guard = 0; last < now + D && guard < 20; guard++) {
      const r = rng(hashStr('st' + last + acct.seed));
      let t = last + step * (0.7 + r() * 0.6);
      if (acct.own) t = humanize(t);
      let key = own.shift();
      if (key === undefined) {
        const fresh = reshare.filter((k) => !shown.has(k));
        const from = fresh.length ? fresh : reshare;
        if (!from.length) break;
        key = from[Math.floor(r() * from.length)];
      }
      shown.add(key);
      const id = newId(ctx, 's_', now);
      db.prepare(INSERT_POST).run(id, acct.id, JSON.stringify([key]), 'story', '', t, 0, Math.floor(nextRand(ctx) * 2 ** 31), now);
      enqueue(ctx, 'story', id, 2, now, null);
      last = t;
      made++;
    }
  }
  return made;
}

// ---- publishing --------------------------------------------------------------------------------------
// Puts a queued post up: live from its due time, targets stored, a caption (the fallback when the writer has
// not written one yet, with a rewrite queued), comments queued. Returns the post row, null when it is not
// queued or its account is gone.
export function publish(ctx, postId, now) {
  const { db } = ctx;
  const post = db.prepare("SELECT * FROM posts WHERE id = ? AND status = 'queued'").get(postId);
  if (!post) return null;
  const acct = db.prepare('SELECT * FROM accounts WHERE id = ?').get(post.acct);
  if (!acct) return null;
  const upAt = Math.min(post.due_at ?? now, now);
  const story = post.kind === 'story';
  let caption = post.caption || '';
  let storyText = post.story_text || '';
  let needRewrite = false;
  if (story) {
    if (!storyText) { storyText = fallbackText(ctx, 'story', acct) || ''; needRewrite = true; }
  } else if (!caption) {
    caption = fallbackText(ctx, 'caption', acct) || '';
    needRewrite = true;
  }
  const targets = { ...makeTargets({ ...post, up_at: upAt }, acct), act: { l: 0, c: 0, f: 0 } };
  tx(db, () => {
    db.prepare("UPDATE posts SET status = 'live', up_at = ?, caption = ?, story_text = ?, targets = ? WHERE id = ?")
      .run(upAt, caption, storyText, JSON.stringify(targets), post.id);
    if (needRewrite) enqueue(ctx, 'rewrite', post.id, 4, now, null);
    else if (!story && !db.prepare('SELECT 1 FROM comments WHERE post = ? LIMIT 1').get(post.id)) enqueue(ctx, 'comments', post.id, 2, now, null);
  });
  return db.prepare('SELECT * FROM posts WHERE id = ?').get(post.id);
}

// Publishes everything whose due_at has passed (a PC that was off catches up on its first tick).
export function publishDue(ctx, now) {
  const due = ctx.db.prepare(`SELECT p.id FROM posts p JOIN accounts a ON a.id = p.acct
    WHERE p.status = 'queued' AND p.due_at <= ? ORDER BY p.due_at`).all(now);
  let n = 0;
  for (const p of due) if (publish(ctx, p.id, now)) n++;
  return n;
}

// ---- takedown ----------------------------------------------------------------------------------------
// A live post past up_at + lifeOf comes down unless you liked, saved or pinned it, and an account never
// drops under 9 live posts. Its photos go back in the pool to be posted again later as a new post (new
// id, seed, caption and comments); 30% of the time they move to a different account first.
export function takedown(ctx, now, minLive = KEEP_MIN) {
  const { db } = ctx;
  let n = 0;
  const accts = db.prepare('SELECT id FROM accounts').all();
  for (const { id: acctId } of accts) {
    const live = db.prepare("SELECT * FROM posts WHERE acct = ? AND status = 'live' AND kind <> 'story'").all(acctId);
    let room = live.length - minLive;
    if (room <= 0) continue;
    const expired = live.filter((p) => !keptFlag(p) && p.up_at != null && now - p.up_at >= lifeOf(p)).sort((a, b) => a.up_at - b.up_at);
    for (const p of expired) {
      if (room <= 0) break;
      db.prepare("UPDATE posts SET status = 'down', down_at = ? WHERE id = ?").run(now, p.id);
      room--;
      n++;
      if (nextRand(ctx) < 0.3) {
        const others = db.prepare('SELECT id FROM accounts WHERE quiet = 0 AND id <> ?').all(acctId);
        if (others.length) {
          const to = others[Math.floor(nextRand(ctx) * others.length)].id;
          const upd = db.prepare('UPDATE items SET acct = ? WHERE key = ?');
          for (const k of parseItems(p.items)) upd.run(to, k);
        }
      }
    }
  }
  return n;
}

// ---- stories expire ----------------------------------------------------------------------------------
// A story is up for 24 h. Then it either becomes a highlight (45%, v1 rate, fixed per story) and stays
// live as one, or comes down; down stories are deleted after 3 days.
export function expireStories(ctx, now) {
  const { db } = ctx;
  let n = 0;
  const old = db.prepare("SELECT id FROM posts WHERE kind = 'story' AND status = 'live' AND highlight = 0 AND up_at <= ?").all(now - D);
  for (const s of old) {
    if (rng(hashStr('hl' + s.id))() < 0.45) db.prepare('UPDATE posts SET highlight = 1 WHERE id = ?').run(s.id);
    else db.prepare("UPDATE posts SET status = 'down', down_at = ? WHERE id = ?").run(now, s.id);
    n++;
  }
  db.prepare("DELETE FROM posts WHERE kind = 'story' AND status = 'down' AND highlight = 0 AND down_at <= ?").run(now - 3 * D);
  return n;
}

// ---- gone files --------------------------------------------------------------------------------------
// Items that vanished from the Drive: live posts holding one come down, queued ones are deleted.
export function onGone(ctx, keys, now) {
  const { db } = ctx;
  if (!keys || !keys.length) return 0;
  const hit = new Map();
  for (let i = 0; i < keys.length; i += 200) {
    const chunk = keys.slice(i, i + 200);
    const q = db.prepare(`SELECT DISTINCT p.id, p.status FROM posts p, json_each(p.items) j
      WHERE p.status IN ('live','queued') AND j.value IN (${chunk.map(() => '?').join(',')})`).all(...chunk);
    for (const r of q) hit.set(r.id, r.status);
  }
  tx(db, () => {
    for (const [id, status] of hit) {
      if (status === 'queued') {
        db.prepare('DELETE FROM posts WHERE id = ?').run(id);
        db.prepare("DELETE FROM writer_jobs WHERE ref = ? AND status = 'todo' AND kind IN ('caption','comments','story','rewrite')").run(id);
      } else db.prepare("UPDATE posts SET status = 'down', down_at = ? WHERE id = ?").run(now, id);
    }
  });
  return hit.size;
}

// ---- wiring ------------------------------------------------------------------------------------------
// One pass of everything. Safe to run twice at the same `now`: planning looks at what is already queued.
export function tick(ctx, now) {
  const steps = [
    ['publish', publishDue], ['expireStories', expireStories], ['takedown', takedown],
    ['planPosts', planPosts], ['planStories', planStories], ['publishStories', publishDue], ['activity', activityTick],
  ];
  const out = {};
  for (const [name, fn] of steps) {
    try { out[name] = fn(ctx, now); } catch (e) { ctx.log('error', `scheduler ${name}: ${e.message}`); }
  }
  return out;
}

export function start(ctx) {
  ctx.hooks.gone.push((keys, now) => onGone(ctx, keys, now ?? Date.now()));
  ctx.ticks.push({ name: 'scheduler', everyMs: 60_000, fn: (now) => tick(ctx, now) });
}
