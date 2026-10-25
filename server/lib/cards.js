// Response shapes shared by the API and the feed: media entries, the Card, visible comments.
// A plain helper module (not in main.js's module list); api.js and feed.js both import it.
import { slug } from './derive.js';
import { summary } from './accounts.js';
import { countsAt } from './engagement.js';

const TOP_COMMENTS = 4;

export const parseKeys = (p) => { try { const k = JSON.parse(p.items || '[]'); return Array.isArray(k) ? k : []; } catch { return []; } };

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

export function mediaOf(ctx, post) {
  const get = ctx.db.prepare('SELECT * FROM items WHERE key = ?');
  const out = [];
  for (const k of parseKeys(post)) {
    const it = get.get(k);
    if (it) out.push(mediaEntry(it));
  }
  return out;
}

export function acctSummary(ctx, id, fallback) {
  const a = ctx.db.prepare('SELECT * FROM accounts WHERE id = ?').get(id);
  return a ? summary(a) : fallback;
}

// A comment's author: an account (owner replies, your own comments) or a fan handle.
export function authorOf(ctx, c) {
  return acctSummary(ctx, c.author, { id: c.author, handle: c.author, name: '', pfp: c.author_pfp || '', own: false });
}

// The comments visible `now`, oldest first: the scheduled ones that have landed (never more than countsAt
// allows) plus everything you wrote yourself.
export function visibleComments(ctx, post, now) {
  const rows = ctx.db.prepare('SELECT * FROM comments WHERE post = ? ORDER BY at, id').all(post.id);
  const theirs = rows.filter((c) => !c.mine && c.at <= now);
  const mine = rows.filter((c) => c.mine && c.at <= now);
  const n = countsAt(post, now, theirs.length).comments;
  return [...theirs.slice(0, n), ...mine].sort((a, b) => a.at - b.at || a.id - b.id);
}

export const commentOut = (ctx, c) => ({ author: authorOf(ctx, c), text: c.text, at: c.at });

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

