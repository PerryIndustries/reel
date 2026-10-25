// The read/write API the thin phone app uses: feed, reels, explore, profile, posts, comments,
// stories, activity, taste, seen and the like/save/pin switches. Accounts, settings, DMs, library,
// status and import live in their own modules.
import { ensureColumn } from './db.js';
import { HttpError } from './router.js';
import { slug } from './derive.js';
import { summary, hashStr, rng } from './accounts.js';
import { countsAt, followersGained } from './engagement.js';
import { newStream, page } from './feed.js';

const HOUR = 3600_000;
const COMMENT_PAGE = 30;
const TOP_COMMENTS = 4;
const MAX_COMMENT_LEN = 500;

const parseKeys = (p) => { try { const k = JSON.parse(p.items || '[]'); return Array.isArray(k) ? k : []; } catch { return []; } };

// ---- shapes -------------------------------------------------------------------------------------------

export function mediaEntry(item) {
  const base = `media/${slug(item.key)}`;
  const video = item.kind === 'video';
  return {
    kind: video ? 'video' : 'photo',
    item: item.key,
    thumb: `${base}/thumb.jpg`,
    full: video ? null : `${base}/full.jpg`,
    video: video ? `${base}/video.mp4` : null,
    poster: video ? `${base}/poster.jpg` : null,
    w: item.w ?? null,
    h: item.h ?? null,
    dur: video && item.dur != null ? item.dur : null,
  };
}

function mediaOf(ctx, post) {
  const get = ctx.db.prepare('SELECT * FROM items WHERE key = ?');
  const out = [];
  for (const k of parseKeys(post)) {
    const it = get.get(k);
    if (it) out.push(mediaEntry(it));
  }
  return out;
}

function acctSummary(ctx, id, fallback) {
  const a = ctx.db.prepare('SELECT * FROM accounts WHERE id = ?').get(id);
  return a ? summary(a) : fallback;
}

// A comment's author: an account (owner replies, your own comments) or a fan handle.
function authorOf(ctx, c) {
  return acctSummary(ctx, c.author, { id: c.author, handle: c.author, name: '', pfp: c.author_pfp || '', own: false });
}

// The comments visible `now`, oldest first: the scheduled ones that have landed (never more than countsAt
// allows) plus everything you wrote yourself.
function visibleComments(ctx, post, now) {
  const rows = ctx.db.prepare('SELECT * FROM comments WHERE post = ? ORDER BY at, id').all(post.id);
  const theirs = rows.filter((c) => !c.mine && c.at <= now);
  const mine = rows.filter((c) => c.mine && c.at <= now);
  const n = countsAt(post, now, theirs.length).comments;
  return [...theirs.slice(0, n), ...mine].sort((a, b) => a.at - b.at || a.id - b.id);
}

const commentOut = (ctx, c) => ({ author: authorOf(ctx, c), text: c.text, at: c.at });

// post row -> Card (contract shape). `top` is the newest 4 visible comments, oldest first.
export function card(ctx, post, now) {
  const acct = acctSummary(ctx, post.acct, { id: post.acct, handle: post.acct, name: '', pfp: '', own: false });
  const vis = visibleComments(ctx, post, now);
  const { likes } = countsAt(post, now, vis.length);
  return {
    id: post.id,
    acct,
    kind: post.kind === 'reel' ? 'reel' : 'post',
    media: mediaOf(ctx, post),
    caption: post.caption || '',
    likes,
    comments: vis.length,
    top: vis.slice(-TOP_COMMENTS).map((c) => commentOut(ctx, c)),
    liked: !!post.liked,
    saved: !!post.saved,
    pinned: !!post.pinned,
    at: post.up_at ?? null,
  };
}

// ---- routes -------------------------------------------------------------------------------------------

function strField(body, k) {
  if (!body || typeof body !== 'object' || typeof body[k] !== 'string' || !body[k]) throw new HttpError(400, `${k} is required`);
  return body[k];
}

export function start(ctx) {
  ensureColumn(ctx.db, 'items', 'last_vote', 'TEXT');
}

export function routes(router, ctx) {
  const { db } = ctx;

  const livePost = (id) => {
    const p = db.prepare(`SELECT p.* FROM posts p JOIN accounts a ON a.id = p.acct
      WHERE p.id = ? AND p.status = 'live' AND p.kind <> 'story'`).get(id);
    if (!p) throw new HttpError(404, 'no such post');
    return p;
  };

  // A known stream continues; a missing or expired one quietly starts a fresh stream.
  const paged = (scope, query, now) => {
    let out = query.stream ? page(ctx, query.stream, query.cursor, now) : null;
    if (!out) out = page(ctx, newStream(ctx, scope, now), null, now);
    return out;
  };

  router.add('GET', '/reel/api/feed', (req, res, params, query) => paged('home', query, Date.now()));
  router.add('GET', '/reel/api/reels', (req, res, params, query) => paged('reels', query, Date.now()));
  router.add('GET', '/reel/api/explore', (req, res, params, query) => paged('explore', query, Date.now()));

  router.add('GET', '/reel/api/acct/:id', (req, res, params, query) => {
    const now = Date.now();
    const a = db.prepare('SELECT * FROM accounts WHERE id = ?').get(params.id);
    if (!a) throw new HttpError(404, 'no such account');
    const live = db.prepare("SELECT * FROM posts WHERE acct = ? AND status = 'live' AND kind <> 'story'").all(a.id);
    const gained = live.reduce((s, p) => s + followersGained(p, now), 0);
    const pinned = live.filter((p) => p.pinned).sort((x, y) => (y.up_at ?? 0) - (x.up_at ?? 0)).map((p) => card(ctx, p, now));
    return {
      acct: {
        ...summary(a),
        bio: a.bio ?? '',
        followers: (a.followers ?? 0) + gained,
        following: 60 + Math.floor(rng(hashStr(`following:${a.id}`))() * 540),
        posts: live.length,
      },
      pinned,
      page: paged(`acct:${a.id}`, query, now),
    };
  });

  router.add('GET', '/reel/api/post/:id', (req, res, params) => {
    const now = Date.now();
    const p = livePost(params.id);
    return { ...card(ctx, p, now), comments: visibleComments(ctx, p, now).map((c) => commentOut(ctx, c)) };
  });

  router.add('GET', '/reel/api/post/:id/comments', (req, res, params, query) => {
    const now = Date.now();
    const p = livePost(params.id);
    const start = Math.max(0, Number.parseInt(query.cursor ?? '0', 10) || 0);
    const all = visibleComments(ctx, p, now);
    const next = start + COMMENT_PAGE;
    return { comments: all.slice(start, next).map((c) => commentOut(ctx, c)), cursor: next < all.length ? String(next) : null };
  });

  router.add('GET', '/reel/api/stories', () => {
    const now = Date.now();
    const rows = db.prepare(`SELECT p.* FROM posts p JOIN accounts a ON a.id = p.acct
      WHERE p.kind = 'story' AND p.status = 'live' AND p.highlight = 0 AND p.up_at IS NOT NULL
        AND p.up_at <= ? AND p.up_at > ? ORDER BY p.up_at, p.id`).all(now, now - 24 * HOUR);
    const getItem = db.prepare('SELECT * FROM items WHERE key = ?');
    const groups = new Map();
    for (const p of rows) {
      const it = getItem.get(parseKeys(p)[0]);
      if (!it) continue;
      if (!groups.has(p.acct)) groups.set(p.acct, { acct: acctSummary(ctx, p.acct), items: [], last: 0 });
      const g = groups.get(p.acct);
      g.items.push({ id: p.id, media: mediaEntry(it), text: p.story_text || '', at: p.up_at });
      g.last = Math.max(g.last, p.up_at);
    }
    return [...groups.values()]
      .sort((x, y) => (Number(y.acct.own) - Number(x.acct.own)) || y.last - x.last)
      .map(({ acct, items }) => ({ acct, items }));
  });

  router.add('GET', '/reel/api/activity', () => {
    const now = Date.now();
    const rows = db.prepare(`SELECT t.* FROM activity t JOIN accounts a ON a.id = t.acct
      WHERE t.at <= ? ORDER BY t.at DESC, t.id DESC LIMIT 100`).all(now);
    return rows.map((r) => ({
      type: r.type,
      acct: acctSummary(ctx, r.acct),
      who: { id: r.who, handle: r.who, name: '', pfp: r.who_pfp || '', own: false },
      post: r.post,
      text: r.text || '',
      at: r.at,
    }));
  });

  router.add('POST', '/reel/api/taste', (req, res, params, query, body) => {
    const key = strField(body, 'item');
    const vote = body.vote;
    if (!['up', 'down', 'undo'].includes(vote)) throw new HttpError(400, 'vote must be up, down or undo');
    const it = db.prepare('SELECT key, last_vote FROM items WHERE key = ?').get(key);
    if (!it) throw new HttpError(404, 'no such item');
    if (vote === 'up') {
      db.prepare("UPDATE items SET up = COALESCE(up, 0) + 1, last_vote = 'up' WHERE key = ?").run(key);
    } else if (vote === 'down') {
      db.prepare("UPDATE items SET down = COALESCE(down, 0) + 1, last_vote = 'down' WHERE key = ?").run(key);
    } else if (it.last_vote === 'up') {
      db.prepare('UPDATE items SET up = MAX(0, COALESCE(up, 0) - 1), last_vote = NULL WHERE key = ?').run(key);
    } else if (it.last_vote === 'down') {
      db.prepare('UPDATE items SET down = MAX(0, COALESCE(down, 0) - 1), last_vote = NULL WHERE key = ?').run(key);
    }
    return { ok: true };
  });

  router.add('POST', '/reel/api/seen', (req, res, params, query, body) => {
    if (!body || !Array.isArray(body.items) || !body.items.every((k) => typeof k === 'string')) {
      throw new HttpError(400, 'items must be an array of item keys');
    }
    const upd = db.prepare('UPDATE items SET seen_at = ? WHERE key = ?');
    const now = Date.now();
    db.exec('BEGIN');
    try { for (const k of body.items) upd.run(now, k); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
    return { ok: true };
  });

  for (const [route, col] of [['like', 'liked'], ['save', 'saved'], ['pin', 'pinned']]) {
    router.add('POST', `/reel/api/${route}`, (req, res, params, query, body) => {
      const id = strField(body, 'post');
      if (typeof body.on !== 'boolean') throw new HttpError(400, 'on must be true or false');
      const p = db.prepare('SELECT p.id FROM posts p JOIN accounts a ON a.id = p.acct WHERE p.id = ?').get(id);
      if (!p) throw new HttpError(404, 'no such post');
      db.prepare(`UPDATE posts SET ${col} = ? WHERE id = ?`).run(body.on ? 1 : 0, id);
      return { ok: true };
    });
  }

  router.add('POST', '/reel/api/comment', (req, res, params, query, body) => {
    const id = strField(body, 'post');
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text) throw new HttpError(400, 'text is required');
    if (text.length > MAX_COMMENT_LEN) throw new HttpError(400, `text is over ${MAX_COMMENT_LEN} characters`);
    const p = livePost(id);
    // written as the post's account when it is yours, else as your first account
    let me = db.prepare('SELECT * FROM accounts WHERE id = ? AND own = 1').get(p.acct);
    if (!me) me = db.prepare('SELECT * FROM accounts WHERE own = 1 ORDER BY created_at, id LIMIT 1').get();
    if (!me) throw new HttpError(409, 'no own account to comment as');
    db.prepare('INSERT INTO comments(post, author, author_pfp, text, at, owner_reply, mine) VALUES (?,?,?,?,?,0,1)')
      .run(p.id, me.id, me.pfp || '', text, Date.now());
    return { ok: true };
  });
}
