// The read/write API the thin phone app uses: feed, reels, explore, profile, posts, comments,
// stories, activity, taste, seen and the like/save/pin switches, plus the one-read library that Wire
// and Thread (docs/x/, docs/r/) post from. Accounts, settings, DMs, Drive sync, status and import live
// in their own modules.
import { ensureColumn } from './db.js';
import { HttpError } from './router.js';
import { summary, hashStr, rng } from './accounts.js';
import { followersGained } from './engagement.js';
import { card, mediaEntry, parseKeys, acctSummary, visibleComments, commentOut } from './cards.js';
import { newStream, page } from './feed.js';

const HOUR = 3600_000;
const COMMENT_PAGE = 30;
const MAX_COMMENT_LEN = 500;
const POSTABLE = 'derived = 1 AND err IS NULL AND gone = 0';

const parseSettings = (a) => { try { return JSON.parse(a.settings || '{}') || {}; } catch { return {}; } };

// An account the way Wire and Thread (docs/kit/core.js) read it: the summary plus what their fans, numbers
// and writer prompts need. `following` matches the profile page when the settings hold none.
export function libraryAccount(a) {
  const s = parseSettings(a);
  return {
    ...summary(a),
    npc: !a.own,
    bio: a.bio ?? '',
    pronouns: typeof s.pronouns === 'string' && s.pronouns ? s.pronouns : 'she',
    heat: typeof s.heat === 'string' && s.heat ? s.heat : 'suggestive',
    followers: a.followers ?? 0,
    following: Number.isFinite(s.following) ? s.following : 60 + Math.floor(rng(hashStr(`following:${a.id}`))() * 540),
    verified: !!s.verified,
    seed: a.seed ?? null,
    startedAt: a.created_at ?? null,
  };
}

// Everything Wire and Thread need in one read: every account, each account's ready files (from its
// non-story posts of any status, deduped, derivatives present), the votes and seen times of those files.
export function library(ctx) {
  const { db } = ctx;
  const accts = db.prepare('SELECT * FROM accounts ORDER BY own DESC, created_at, id').all();
  const getItem = db.prepare(`SELECT * FROM items WHERE key = ? AND ${POSTABLE}`);
  const media = Object.fromEntries(accts.map((a) => [a.id, []]));
  const have = new Map(accts.map((a) => [a.id, new Set()]));
  const taste = {};
  const seen = {};
  const posts = db.prepare(`SELECT p.acct, p.items FROM posts p JOIN accounts a ON a.id = p.acct
    WHERE p.kind <> 'story' ORDER BY p.created_at, p.id`).all();
  for (const p of posts) {
    const mine = have.get(p.acct);
    if (!mine) continue;
    for (const k of parseKeys(p)) {
      if (mine.has(k)) continue;
      const it = getItem.get(k);
      if (!it) continue;
      mine.add(k);
      media[p.acct].push(mediaEntry(it));
      if (it.up > 0 || it.down > 0) taste[k] = { up: it.up || 0, down: it.down || 0 };
      if (it.seen_at != null) seen[`f:${k}`] = it.seen_at;
    }
  }
  const first = accts.find((a) => a.own);
  return { accounts: accts.map(libraryAccount), current: first ? first.id : null, media, taste, seen };
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
    let out = query.stream ? page(ctx, query.stream, query.cursor, now, scope) : null;
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

  router.add('GET', '/reel/api/highlights', (req, res, params, query) => {
    const acct = typeof query.acct === 'string' && query.acct ? query.acct : null;
    const rows = db.prepare(`SELECT p.* FROM posts p JOIN accounts a ON a.id = p.acct
      WHERE p.kind = 'story' AND p.status = 'live' AND p.highlight = 1 AND p.up_at IS NOT NULL
        AND (? IS NULL OR p.acct = ?) ORDER BY p.up_at DESC, p.id DESC`).all(acct, acct);
    const getItem = db.prepare('SELECT * FROM items WHERE key = ?');
    const out = [];
    for (const p of rows) {
      const it = getItem.get(parseKeys(p)[0]);
      if (it) out.push({ id: p.id, media: mediaEntry(it), text: p.story_text || '', at: p.up_at });
    }
    return out;
  });

  router.add('GET', '/reel/api/library', () => library(ctx));

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
