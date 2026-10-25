// Feed streams: the endless scroll behind home, reels, explore and a profile grid.
// A stream is built once (a snapshot of the candidate posts), kept in memory for 6 h, and paged 8 cards at
// a time. Home and reels favour what you have not seen and what you voted up; explore is a uniform mix.
import { publish } from './scheduler.js';
import { card } from './api.js';

const DAY = 24 * 3600_000;
const STREAM_TTL = 6 * 3600_000;
export const PAGE_SIZE = 8;
const SPACING = 3; // no same account within the last 3 cards (home / explore)
const MAX_STREAMS = 200;

// novelty x taste. Never seen: 1. Seen: back toward 1 over 3 days, faster when voted up.
export function weight(item, now) {
  const up = Math.max(0, Number(item.up) || 0);
  const down = Math.max(0, Number(item.down) || 0);
  let novelty = 1;
  if (item.seen_at != null) {
    const age = Math.max(0, now - item.seen_at);
    novelty = 1 - Math.exp(-age / (3 * DAY / (1 + up)));
  }
  return novelty * (1 + up) ** 0.7 * 0.25 ** down;
}

const parseKeys = (p) => { try { const k = JSON.parse(p.items || '[]'); return Array.isArray(k) ? k : []; } catch { return []; } };

function streamsOf(ctx) {
  if (!ctx.feedStreams) ctx.feedStreams = new Map();
  return ctx.feedStreams;
}

function newId(ctx, now) {
  const r = Math.floor((ctx.rand ?? Math.random)() * 0xffffff).toString(36);
  return `s${now.toString(36)}${r}${streamsOf(ctx).size}`;
}

function prune(ctx, now) {
  const streams = streamsOf(ctx);
  for (const [id, s] of streams) if (now - s.at > STREAM_TTL) streams.delete(id);
  if (streams.size >= MAX_STREAMS) {
    const oldest = [...streams.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, streams.size - MAX_STREAMS + 1);
    for (const [id] of oldest) streams.delete(id);
  }
}

// Candidate posts for a scope: every non-story post (live or queued) whose account still exists,
// each with its first item's taste data.
function candidates(ctx, scope) {
  const { db } = ctx;
  const m = /^acct:(.+)$/.exec(scope);
  const where = [`p.kind <> 'story'`, `p.status IN ('live','queued')`];
  const args = [];
  if (scope === 'reels') where.push(`p.kind = 'reel'`);
  if (m) { where.push('p.acct = ?'); args.push(m[1]); }
  const rows = db.prepare(`SELECT p.id, p.acct, p.kind, p.items, p.status, p.up_at, p.pinned, p.due_at
    FROM posts p JOIN accounts a ON a.id = p.acct WHERE ${where.join(' AND ')}`).all(...args);
  const getItem = db.prepare('SELECT key, seen_at, up, down FROM items WHERE key = ?');
  const out = [];
  const seenFirst = new Set();
  for (const p of rows) {
    const first = parseKeys(p)[0];
    if (!first || seenFirst.has(first)) continue;
    const item = getItem.get(first);
    if (!item) continue;
    seenFirst.add(first);
    out.push({ id: p.id, acct: p.acct, status: p.status, up_at: p.up_at, pinned: p.pinned, first, item });
  }
  return out;
}

// scope: home | reels | explore | acct:<id>. -> stream id
export function newStream(ctx, scope, now) {
  prune(ctx, now);
  let list = candidates(ctx, scope);
  const profile = scope.startsWith('acct:');
  if (profile) {
    // a profile grid is chronological, pinned posts are shown separately
    list = list.filter((c) => !c.pinned).sort((a, b) => (b.up_at ?? now) - (a.up_at ?? now) || (a.id < b.id ? -1 : 1));
  }
  const id = newId(ctx, now);
  streamsOf(ctx).set(id, { id, scope, at: now, pool: list, emitted: [], recent: [], profile, done: false });
  return id;
}

function pickOne(ctx, s, now) {
  const spaced = !s.profile && s.scope !== 'reels';
  const recent = new Set(s.recent.slice(-SPACING));
  if (s.profile) return s.pool.length ? 0 : -1;
  const uniform = s.scope === 'explore';
  let total = 0;
  const w = new Array(s.pool.length);
  for (let i = 0; i < s.pool.length; i++) {
    const c = s.pool[i];
    if (spaced && recent.has(c.acct)) { w[i] = 0; continue; }
    w[i] = uniform ? 1 : Math.max(weight(c.item, now), 1e-9);
    total += w[i];
  }
  if (total <= 0) return -1;
  let x = (ctx.rand ?? Math.random)() * total;
  let last = -1;
  for (let i = 0; i < w.length; i++) {
    if (w[i] <= 0) continue;
    last = i;
    if ((x -= w[i]) < 0) return i;
  }
  return last;
}

// -> {stream, cursor, cards}. An unknown/expired stream id is not an error for the caller: the API
// starts a new one. `cursor` is the number of cards already delivered ("" / null = from the start).
export function page(ctx, streamId, cursor, now) {
  const s = streamsOf(ctx).get(streamId);
  if (!s) return null;
  s.at = now;
  const start = Math.max(0, Number.parseInt(cursor ?? '0', 10) || 0);
  const cards = [];
  let pos = start;
  while (cards.length < PAGE_SIZE) {
    if (pos < s.emitted.length) {
      const row = ctx.db.prepare('SELECT p.* FROM posts p JOIN accounts a ON a.id = p.acct WHERE p.id = ?').get(s.emitted[pos]);
      pos++;
      if (row) cards.push(card(ctx, row, now));
      continue;
    }
    if (s.done) break;
    const i = pickOne(ctx, s, now);
    if (i < 0) { s.done = true; break; }
    const [c] = s.pool.splice(i, 1);
    let row = ctx.db.prepare('SELECT p.* FROM posts p JOIN accounts a ON a.id = p.acct WHERE p.id = ?').get(c.id);
    if (row && row.status === 'queued') row = publish(ctx, c.id, now);
    if (!row || row.status !== 'live') continue;
    s.emitted.push(row.id);
    s.recent.push(row.acct);
  }
  if (pos >= s.emitted.length && !s.done && pickOne(ctx, s, now) < 0) s.done = true; // nothing eligible is left
  const more = pos < s.emitted.length || !s.done;
  return { stream: s.id, cursor: more ? String(pos) : null, cards };
}
