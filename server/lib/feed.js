// Feed streams: the endless scroll behind home, reels, explore and a profile grid.
// A stream is built once (a snapshot of the candidate posts), kept in memory for 6 h, and paged 8 cards at
// a time. Home deals only files he favorited (see isFavorited), rested ones first, once there are FAV_HOME_MIN. Reels and
// explore favour what you have not seen and what you voted up (explore is a uniform mix), with new files (added in
// the last 7 days, never seen) and favorites (see isFav) first, taking turns, within the dealing rules; files that
// arrive while a stream is open join it. Home never deals two videos in a row while a photo card is left.
// A thumbs-down buries a photo everywhere except a profile grid: each one cuts its odds 50x.
import { publish, postNow, storiesFolder } from './scheduler.js';
import { card } from './cards.js';

const DAY = 24 * 3600_000;
const STREAM_TTL = 6 * 3600_000;
export const PAGE_SIZE = 8;
const SPACING = 3; // no same account within the last 3 cards (home / explore)
// No two cards in a row from the same top-level Drive folder (home / explore / reels), whenever another folder has a candidate.
// Home never deals a video right after a video while a photo card is left (photos may follow photos). A card is the
// kind of its first, visible item. When the rules clash, the folder rule gives way first, then this one.
const MAX_STREAMS = 200;
export const DOWN = 0.02; // odds kept per thumbs-down
// New uploads first: a file added in the last 7 days that has never been seen (and never thumbed down) is dealt
// ahead of everything else in home, reels and explore, within the spacing rules, until it is seen.
export const NEW_WINDOW = 7 * DAY;
// Favorites first too: a file he hearted 2+ times (each heart tap is a taste up), or on a saved or pinned post, never
// thumbed down and not seen in the last 12 h (so the front rotates through them instead of showing the same few).
// The front alternates new and favorite while both have a card the rules allow; then whichever is left; then the
// normal weighted mix.
export const FAV_UPS = 2;
export const FAV_REST = 12 * 3600_000;
export const isFav = (item, now) => !(Number(item.down) > 0) && (Number(item.up) >= FAV_UPS || !!item.kept) && (item.seen_at == null || now - item.seen_at >= FAV_REST);
// Home is only files he favorited: hearted at least once, or on a saved or pinned post, never thumbed down. Rested
// ones (not seen in the last 12 h) come first; then the rest, least recently seen first. A file he hearts anywhere
// joins an open Home stream.
// Home turns favorites-only once there are FAV_HOME_MIN of them (three pages), so a few hearts never leave it near empty.
export const FAV_HOME_MIN = 24;
export const isFavorited = (item) => !(Number(item.down) > 0) && (Number(item.up) >= 1 || !!item.kept);
const rested = (item, now) => item.seen_at == null || now - item.seen_at >= FAV_REST;
export const isNew = (item, now) => item.seen_at == null && !(Number(item.down) > 0) && now - Number(item.added_at ?? 0) <= NEW_WINDOW;

// novelty x taste. Never seen: 1. Seen: back toward 1 over 3 days, faster when voted up.
export function weight(item, now) {
  const up = Math.max(0, Number(item.up) || 0);
  const down = Math.max(0, Number(item.down) || 0);
  let novelty = 1;
  if (item.seen_at != null) {
    const age = Math.max(0, now - item.seen_at);
    novelty = 1 - Math.exp(-age / (3 * DAY / (1 + up)));
  }
  return novelty * (1 + up) ** 0.7 * DOWN ** down;
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
  // home / reels / explore take live and queued posts (a queued pick is published); a profile only live ones,
  // so scrolling it can never drain the queue past the scheduler's pacing.
  const where = [`p.kind <> 'story'`, m ? `p.status = 'live'` : `p.status IN ('live','queued')`];
  const args = [];
  if (scope === 'reels') where.push(`p.kind = 'reel'`);
  if (m) { where.push('p.acct = ?'); args.push(m[1]); }
  const rows = db.prepare(`SELECT p.id, p.acct, p.kind, p.items, p.status, p.up_at, p.pinned, p.due_at
    FROM posts p JOIN accounts a ON a.id = p.acct WHERE ${where.join(' AND ')}`).all(...args);
  const getItem = db.prepare('SELECT key, kind, folder, seen_at, up, down, added_at FROM items WHERE key = ?');
  const kept = new Set(db.prepare(`SELECT DISTINCT j.value v FROM posts p, json_each(p.items) j WHERE p.saved = 1 OR p.pinned = 1`).all().map((r) => r.v));
  const out = [];
  const seenFirst = new Set();
  for (const p of rows) {
    const first = parseKeys(p)[0];
    if (!first || seenFirst.has(first)) continue;
    const row = getItem.get(first);
    if (!row) continue;
    const item = kept.has(first) ? { ...row, kept: 1 } : row;
    seenFirst.add(first);
    out.push({ id: p.id, acct: p.acct, folder: item.folder ?? '', status: p.status, up_at: p.up_at, pinned: p.pinned, first, item });
  }
  if (m) return out;
  // Home, reels and explore draw from the whole library: a file in no post yet is a candidate too, and goes up
  // as a post the moment it is picked.
  const loose = ctx.db.prepare(`SELECT i.key, i.kind, i.folder, i.acct, i.seen_at, i.up, i.down, i.added_at FROM items i JOIN accounts a ON a.id = i.acct
    WHERE i.derived = 1 AND i.err IS NULL AND i.gone = 0 ${scope === 'reels' ? "AND i.kind = 'video'" : ''}
    AND i.key NOT IN (SELECT j.value FROM posts p, json_each(p.items) j WHERE p.status IN ('live','queued') AND p.kind <> 'story')`).all();
  for (const it of loose) {
    if (seenFirst.has(it.key) || storiesFolder(it)) continue;
    seenFirst.add(it.key);
    out.push({ id: null, acct: it.acct, folder: it.folder ?? '', status: 'loose', first: it.key, item: kept.has(it.key) ? { ...it, kept: 1 } : it });
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
  // Home is favorites only once there are FAV_HOME_MIN of them (fewer: the normal mix, new files and favorites first)
  let favOnly = false;
  if (scope === 'home') {
    const favs = list.filter((c) => isFavorited(c.item));
    if (favs.length >= FAV_HOME_MIN) { list = favs; favOnly = true; }
  }
  const id = newId(ctx, now);
  streamsOf(ctx).set(id, { id, scope, favOnly, at: now, pool: list, known: new Set(list.map((c) => c.first)), emitted: [], dealtDown: new Map(), recent: [], profile, done: false });
  return id;
}

// Folder and kind of the card a stream dealt last: the first item of its last emitted post. Read from the database
// (not kept beside `emitted`) so a stream continued with emitted cards already in it still knows where it stands.
function lastCard(ctx, s) {
  const id = s.emitted[s.emitted.length - 1];
  if (id == null) return null;
  const row = ctx.db.prepare('SELECT items FROM posts WHERE id = ?').get(id);
  const first = row && parseKeys(row)[0];
  const it = first && ctx.db.prepare('SELECT folder, kind FROM items WHERE key = ?').get(first);
  return it ? { folder: it.folder ?? '', kind: it.kind } : null;
}

// Files that arrived (or finished processing) after the stream was built join its pool while they are new, so
// an app that keeps its stream open still gets them: the post that holds one (by its first item), or the loose file.
// A favorites-only Home instead takes files favorited since it was built (hearted on Reels or Explore, say).
function joinArrivals(ctx, s, now) {
  const { db } = ctx;
  const reels = s.scope === 'reels';
  const home = !!s.favOnly;
  const kept = home ? new Set(db.prepare(`SELECT DISTINCT j.value v FROM posts p, json_each(p.items) j WHERE p.saved = 1 OR p.pinned = 1`).all().map((r) => r.v)) : new Set();
  const rows = (home
    ? db.prepare(`SELECT i.key, i.kind, i.folder, i.acct, i.seen_at, i.up, i.down, i.added_at FROM items i JOIN accounts a ON a.id = i.acct
      WHERE i.derived = 1 AND i.err IS NULL AND i.gone = 0 AND COALESCE(i.down, 0) = 0 ORDER BY i.key`).all().filter((it) => Number(it.up) >= 1 || kept.has(it.key))
    : db.prepare(`SELECT i.key, i.kind, i.folder, i.acct, i.seen_at, i.up, i.down, i.added_at FROM items i JOIN accounts a ON a.id = i.acct
      WHERE i.derived = 1 AND i.err IS NULL AND i.gone = 0 AND i.seen_at IS NULL AND i.added_at >= ? ${reels ? "AND i.kind = 'video'" : ''} ORDER BY i.key`).all(now - NEW_WINDOW))
    .map((it) => (kept.has(it.key) ? { ...it, kept: 1 } : it));
  const unknown = rows.filter((it) => !s.known.has(it.key) && !storiesFolder(it) && (home ? isFavorited(it) : isNew(it, now)));
  if (!unknown.length) return;
  // one pass over the live and queued posts: which post holds each file (reels: only reel posts)
  const holder = new Map();
  for (const r of db.prepare(`SELECT p.id, p.acct, p.kind, p.items, p.status, p.up_at, p.pinned, j.value v FROM posts p JOIN accounts a ON a.id = p.acct, json_each(p.items) j
    WHERE p.status IN ('live','queued') AND p.kind <> 'story' ORDER BY p.id`).all()) if (!holder.has(r.v)) holder.set(r.v, r);
  const getItem = db.prepare('SELECT key, kind, folder, seen_at, up, down, added_at FROM items WHERE key = ?');
  for (const it of unknown) {
    if (s.known.has(it.key)) continue;
    s.known.add(it.key); // looked at once: a carousel member whose post is already in play is not looked up again
    const p = holder.get(it.key);
    if (p) {
      if (reels && p.kind !== 'reel') continue;
      const first = parseKeys(p)[0];
      if (!first || (first !== it.key && s.known.has(first))) continue;
      const fi = first === it.key ? it : getItem.get(first);
      if (!fi || (home && !isFavorited(fi))) continue;
      s.known.add(first);
      s.pool.push({ id: p.id, acct: p.acct, folder: fi.folder ?? '', status: p.status, up_at: p.up_at, pinned: p.pinned, first, item: fi });
    } else {
      s.known.add(it.key);
      s.pool.push({ id: null, acct: it.acct, folder: it.folder ?? '', status: 'loose', first: it.key, item: it });
    }
  }
  if (s.pool.length) s.done = false;
}

// The live or queued post (reels: reel) whose first item is `key`, not one already dealt; null when none.
function holderOf(ctx, key, scope) {
  return ctx.db.prepare(`SELECT p.* FROM posts p JOIN accounts a ON a.id = p.acct WHERE p.status IN ('live','queued') AND p.kind <> 'story'
    ${scope === 'reels' ? "AND p.kind = 'reel'" : ''} AND json_extract(p.items, '$[0]') = ? ORDER BY p.id LIMIT 1`).get(key) ?? null;
}

// The stream's copy of a candidate's seen / vote state is from when it was built; a file seen or voted on since
// (in another stream, or on another tab) is no longer new, or rests as a favorite.
// Home re-reads every candidate and drops one that is no longer favorited (thumbed down, heart undone).
function refreshFront(ctx, s, now) {
  const get = ctx.db.prepare('SELECT seen_at, up, down FROM items WHERE key = ?');
  const home = !!s.favOnly;
  for (const c of s.pool) {
    if (!home && !isNew(c.item, now) && !isFav(c.item, now)) continue;
    const r = get.get(c.first);
    if (r) c.item = { ...c.item, seen_at: r.seen_at, up: r.up, down: r.down };
  }
  if (home) s.pool = s.pool.filter((c) => isFavorited(c.item));
}

function pickOne(ctx, s, now) {
  const spaced = !s.profile && s.scope !== 'reels';
  const recent = new Set(s.recent.slice(-SPACING));
  if (!s.pool.length) return -1;
  if (s.profile) return 0;
  const uniform = s.scope === 'explore';
  // Hard rules on the last card: on home no video right after a video, and another folder than the last card's.
  // Only the cards passing both are in play; when none does, the folder rule is dropped, then the video rule too,
  // so a pool of only videos or only one folder keeps going (never end early).
  const prev = lastCard(ctx, s);
  const kindOk = (c) => s.scope !== 'home' || prev == null || prev.kind !== 'video' || c.item.kind !== 'video';
  const sameFolder = (c) => prev == null || c.folder !== prev.folder;
  const both = (c) => kindOk(c) && sameFolder(c);
  const folderOk = s.pool.some(both) ? both : s.pool.some(kindOk) ? kindOk : s.pool.some(sameFolder) ? sameFolder : () => true;
  const base = (allowed) => s.pool.map((c) => (folderOk(c) && allowed(c) ? Math.max(uniform ? DOWN ** (Number(c.item.down) || 0) : weight(c.item, now), 1e-9) : 0));
  // among the cards allowed here, new uploads and favorites go first, taking turns while both have one
  let group = null;
  const weights = (allowed) => {
    const w = base(allowed);
    if (s.favOnly) {
      const rest = w.map((x, i) => (x > 0 && rested(s.pool[i].item, now) ? x : 0));
      return rest.some((x) => x > 0) ? rest : w;
    }
    const front = {
      new: w.map((x, i) => (x > 0 && isNew(s.pool[i].item, now) ? x : 0)),
      fav: w.map((x, i) => (x > 0 && !isNew(s.pool[i].item, now) && isFav(s.pool[i].item, now) ? x : 0)),
    };
    for (const g of s.lastGroup === 'new' ? ['fav', 'new'] : ['new', 'fav']) {
      if (front[g].some((x) => x > 0)) { group = g; return front[g]; }
    }
    group = null;
    return w;
  };
  let w = weights((c) => !(spaced && recent.has(c.acct)));
  let total = w.reduce((x, y) => x + y, 0);
  if (total <= 0) {
    // Nobody is eligible (few accounts post): never end early, pick among the accounts shown least recently.
    const lastSeen = (acct) => s.recent.lastIndexOf(acct);
    const oldest = Math.min(...s.pool.filter(folderOk).map((c) => lastSeen(c.acct)));
    w = weights((c) => lastSeen(c.acct) === oldest);
    total = w.reduce((x, y) => x + y, 0);
    if (total <= 0) return -1;
  }
  if (group) s.lastGroup = group;
  let x = (ctx.rand ?? Math.random)() * total;
  let last = -1;
  for (let i = 0; i < w.length; i++) {
    if (w[i] <= 0) continue;
    last = i;
    if ((x -= w[i]) < 0) return i;
  }
  return last;
}


// True once a card has been thumbed down since this stream dealt it; a re-read from the start leaves it out.
const votedOut = (ctx, s, row) => {
  const first = parseKeys(row)[0];
  return !!first && (ctx.db.prepare('SELECT down FROM items WHERE key = ?').get(first)?.down || 0) > (s.dealtDown.get(row.id) || 0);
};

// -> {stream, cursor, cards}. An unknown/expired stream id is not an error for the caller: the API
// starts a new one. `cursor` is the number of cards already delivered ("" / null = from the start).
export function page(ctx, streamId, cursor, now, scope) {
  const s = streamsOf(ctx).get(streamId);
  if (!s || (scope != null && s.scope !== scope)) return null; // unknown, expired or another scope's stream
  s.at = now;
  const start = Math.max(0, Number.parseInt(cursor ?? '0', 10) || 0);
  const cards = [];
  let pos = start;
  let checked = false;
  while (cards.length < PAGE_SIZE) {
    if (pos < s.emitted.length) {
      const row = ctx.db.prepare('SELECT p.* FROM posts p JOIN accounts a ON a.id = p.acct WHERE p.id = ?').get(s.emitted[pos]);
      pos++;
      if (row && (s.profile || !votedOut(ctx, s, row))) cards.push(card(ctx, row, now));
      continue;
    }
    if (!s.profile && !checked) { checked = true; joinArrivals(ctx, s, now); refreshFront(ctx, s, now); }
    if (s.done) break;
    const i = pickOne(ctx, s, now);
    if (i < 0) { s.done = true; break; }
    const [c] = s.pool.splice(i, 1);
    let row = c.id ? ctx.db.prepare('SELECT p.* FROM posts p JOIN accounts a ON a.id = p.acct WHERE p.id = ?').get(c.id) : postNow(ctx, c.first, now);
    // a loose file the scheduler put in a post after the stream was built: deal that post instead
    if (!row && !c.id) row = holderOf(ctx, c.first, s.scope);
    if (row && !c.id && s.emitted.includes(row.id)) continue;
    if (row && row.status === 'queued') row = publish(ctx, row.id, now);
    if (!row || row.status !== 'live') continue;
    s.emitted.push(row.id);
    s.dealtDown.set(row.id, Number(c.item.down) || 0);
    s.recent.push(row.acct);
  }
  if (pos >= s.emitted.length && s.pool.length === 0) s.done = true;
  const more = pos < s.emitted.length || !s.done;
  return { stream: s.id, cursor: more ? String(pos) : null, cards };
}
