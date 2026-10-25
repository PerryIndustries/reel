// DMs: fan conversations and auto-replies, server-side (ported from the v39 app: dmTick, replyDelay,
// scheduleFan/scheduleMe, ownerSend, autoStartChats, dmTemplate openers).
// A conversation lives in convos (state JSON: next {who, at, seenAt, kind}, byMe, auto, turns, maxTurns,
// autoStart). The next turn is a writer `dm` job whose payload.at is when it shows; the writer inserts the dms
// rows and calls ctx.hooks.dmWritten, where the following turn gets scheduled. Everything is driven by stored
// next_at and the `now` handed in; no timers here.
import { getSetting, setSetting, tx } from './db.js';
import { enqueue, fanOf } from './writer.js';
import { HttpError } from './router.js';

const MIN = 60_000;
const H = 3600_000;
const D = 24 * H;
const FAN_POOL = 240;
const WRITE_LEAD = 25_000;        // v39 writes a turn this long before it shows ("typing..." stays honest)
const TICK_MS = 20_000;
const JOB_PRIO = 3;

const rnd = (ctx) => ctx.rand || Math.random;

/* ================= state ================= */
function parseState(c) {
  try { return (c && c.state ? JSON.parse(c.state) : null) || {}; } catch { return {}; }
}
function saveState(ctx, id, state, nextAt) {
  ctx.db.prepare('UPDATE convos SET state = ?, next_at = ? WHERE id = ?').run(JSON.stringify(state), nextAt ?? null, id);
}
function acctSettings(a) {
  try { return (a && a.settings ? JSON.parse(a.settings) : null) || {}; } catch { return {}; }
}
const dmAuto = (a) => { const v = acctSettings(a).dmAuto; return v === 'off' || v === 'lots' ? v : 'some'; };
const autoOn = (a, state) => dmAuto(a) !== 'off' && (state.auto ?? !state.byMe);
const getAcct = (ctx, id) => ctx.db.prepare('SELECT * FROM accounts WHERE id = ?').get(id);

/* ================= v39 delays ================= */
// Mostly quick when someone is chatting, sometimes they take a while, now and then they go quiet for hours.
export function replyDelay(ctx, fast) {
  const r = rnd(ctx);
  const x = r();
  if (fast) return x < 0.75 ? 15e3 + r() * 165e3 : x < 0.95 ? 3 * MIN + r() * 20 * MIN : H + r() * 4 * H;
  return x < 0.55 ? 30e3 + r() * 6 * MIN : x < 0.88 ? 6 * MIN + r() * 40 * MIN : H + r() * 6 * H;
}

// Schedules the next turn: stores it on the convo and enqueues the writer job.
function setNext(ctx, convo, state, next) {
  state.next = next;
  saveState(ctx, convo, state, next.at);
  const payload = { who: next.who, at: next.at };
  if (next.kind) payload.kind = next.kind;
  enqueue(ctx, 'dm', convo, JOB_PRIO, next.at - WRITE_LEAD, payload);
}

function scheduleFan(ctx, convo, state, from, fast) {
  const d = replyDelay(ctx, fast);
  setNext(ctx, convo, state, { who: 'fan', at: Math.round(from + d), seenAt: Math.round(from + Math.min(d * 0.5, 10e3 + rnd(ctx)() * 80e3)), kind: 'back' });
}
// The account answers in its own time: minutes to a few hours.
function scheduleMe(ctx, convo, state, from) {
  const r = rnd(ctx);
  setNext(ctx, convo, state, { who: 'me', at: Math.round(from + (r() < 0.6 ? 2 * MIN + r() * 25 * MIN : 30 * MIN + r() * 3 * H)) });
}

/* ================= convos ================= */
function ensureConvo(ctx, acct, fan, now) {
  const id = `${acct}|${fan}`;
  const c = ctx.db.prepare('SELECT * FROM convos WHERE id = ?').get(id);
  if (c) return c;
  const m = /^f(\d+)$/.exec(fan);
  const f = m && +m[1] < FAN_POOL ? fanOf(ctx, +m[1]) : { id: fan, handle: fan, pfp: '' };
  ctx.db.prepare('INSERT INTO convos(id, acct, fan, fan_handle, fan_pfp, state, next_at, unread) VALUES (?,?,?,?,?,?,NULL,0)')
    .run(id, acct, fan, f.handle, f.pfp || '', JSON.stringify({ started: now }));
  return ctx.db.prepare('SELECT * FROM convos WHERE id = ?').get(id);
}

// Perry typed in this chat: store it; the fan answers.
export function meSend(ctx, acct, fan, text, now = Date.now()) {
  tx(ctx.db, () => {
    const c = ensureConvo(ctx, acct, fan, now);
    const state = parseState(c);
    ctx.db.prepare('INSERT INTO dms(convo, from_me, text, at, seen) VALUES (?, 1, ?, ?, 0)').run(c.id, text, now);
    state.byMe = true;
    // Perry's message turns the fan's pending turn (an opener, say) into a reply, no later than the fast draw.
    if (state.next && state.next.who === 'fan') {
      const d = replyDelay(ctx, true);
      const at = Math.min(state.next.at, Math.round(now + d));
      setNext(ctx, c.id, state, { who: 'fan', at, seenAt: Math.min(at, Math.round(now + Math.min(d * 0.5, 10e3 + rnd(ctx)() * 80e3))), kind: 'back' });
    } else scheduleFan(ctx, c.id, state, now, true);
  });
}

/* ================= fan openers ================= */
// Fans message each own account every day (v39 dmTemplate: perDay by followers, x3 for the PC engine).
const perDayFor = (a) => Math.max(2, Math.min(60, Math.round((2 + (a.followers || 0) / 1500) * 3)));

export function fanOpeners(ctx, now = Date.now()) {
  const r = rnd(ctx);
  const own = ctx.db.prepare('SELECT * FROM accounts WHERE own = 1').all();
  for (const a of own) {
    const key = `dmOpenAt:${a.id}`;
    const cursor = getSetting(ctx.db, key, null);
    setSetting(ctx.db, key, cursor == null ? now : Math.max(cursor, now));   // never backwards
    if (cursor == null || now <= cursor) continue;       // first look sets the cursor: nothing backfilled
    const from = Math.max(cursor, now - D);
    const n = Math.floor(perDayFor(a) * ((now - from) / D) * (0.6 + r() * 0.8) + r());
    for (let k = 0; k < n; k++) {
      const t = Math.round(from + r() * (now - from));
      let fan = null;
      for (let tries = 0; tries < 12 && !fan; tries++) {
        const f = `f${Math.floor(r() * FAN_POOL)}`;
        if (!ctx.db.prepare('SELECT 1 FROM convos WHERE id = ?').get(`${a.id}|${f}`)) fan = f;
      }
      if (!fan) break;
      const story = ctx.db.prepare("SELECT 1 FROM posts WHERE acct = ? AND kind = 'story' AND status = 'live' AND up_at <= ? AND up_at > ?").get(a.id, t, t - D);
      const recent = ctx.db.prepare("SELECT id FROM posts WHERE acct = ? AND kind <> 'story' AND status = 'live' AND up_at <= ? AND up_at > ? ORDER BY up_at DESC LIMIT 3").all(a.id, t, t - 7 * D);
      const kind = story && r() < 0.35 ? 'story' : recent.length && r() < 0.4 ? 'post' : 'open';
      tx(ctx.db, () => {
        const c = ensureConvo(ctx, a.id, fan, now);
        const state = parseState(c);
        if (kind === 'post') state.post = recent[Math.floor(r() * recent.length)].id;
        setNext(ctx, c.id, state, { who: 'fan', at: t, seenAt: t, kind });
      });
    }
  }
}

/* ================= due ================= */
// Turns whose time is near but have no job (a restart, a lost job) get one; then the account answers a few
// unanswered chats a day by itself (v39 autoStartChats).
export function due(ctx, now = Date.now()) {
  const rows = ctx.db.prepare(`SELECT c.* FROM convos c JOIN accounts a ON a.id = c.acct
    WHERE c.next_at IS NOT NULL AND c.next_at <= ?`).all(now + WRITE_LEAD);
  for (const c of rows) {
    if (ctx.db.prepare("SELECT 1 FROM writer_jobs WHERE kind = 'dm' AND ref = ? AND status IN ('todo','running')").get(c.id)) continue;
    const state = parseState(c);
    if (!state.next) {
      saveState(ctx, c.id, state, null);                  // nothing planned
      continue;
    }
    const failed = ctx.db.prepare("DELETE FROM writer_jobs WHERE kind = 'dm' AND ref = ? AND status = 'failed'").run(c.id).changes;
    if (failed) {                                         // the writer gave up (Ollama down): same turn, ten minutes on
      const at = now + 10 * MIN;
      setNext(ctx, c.id, state, { ...state.next, at, seenAt: Math.min(state.next.seenAt ?? at, at) });
      continue;
    }
    setNext(ctx, c.id, state, state.next);
  }
  for (const a of ctx.db.prepare('SELECT * FROM accounts WHERE own = 1').all()) autoStartChats(ctx, a, now);
}

function autoStartChats(ctx, a, now) {
  const mode = dmAuto(a);
  if (mode === 'off') return;
  const r = rnd(ctx);
  const perDay = mode === 'lots' ? 10 : 3;
  const convos = ctx.db.prepare('SELECT * FROM convos WHERE acct = ?').all(a.id);
  const states = new Map(convos.map((c) => [c.id, parseState(c)]));
  const today = [...states.values()].filter((s) => s.autoStart && now - s.autoStart < D).length;
  if (today >= perDay || r() > 0.5) return;
  const open = [];
  for (const c of convos) {
    const s = states.get(c.id);
    if (s.autoStart || s.byMe || s.next) continue;
    const last = ctx.db.prepare('SELECT from_me, at FROM dms WHERE convo = ? AND at <= ? ORDER BY at DESC, id DESC LIMIT 1').get(c.id, now);
    if (last && !last.from_me && now - last.at < 12 * H) open.push({ c, s, at: last.at });
  }
  if (!open.length) return;
  open.sort((x, y) => y.at - x.at);
  const t = open[Math.floor(r() * Math.min(5, open.length))];
  t.s.autoStart = now;
  scheduleMe(ctx, t.c.id, t.s, Math.max(t.at, now - 20 * MIN));
}

/* ================= after the writer wrote ================= */
function onWritten(ctx, { convo, who, ats, now }) {
  const c = ctx.db.prepare('SELECT c.* FROM convos c JOIN accounts a ON a.id = c.acct WHERE c.id = ?').get(convo);
  if (!c) return;
  const a = getAcct(ctx, c.acct);
  const state = parseState(c);
  const wrote = !!(ats && ats.length);
  const at = wrote ? ats[ats.length - 1] : now;
  state.next = null;
  saveState(ctx, c.id, state, null);
  if (who === 'fan') {
    const lastMine = ctx.db.prepare('SELECT MAX(at) m FROM dms WHERE convo = ? AND from_me = 1').get(c.id).m;
    if (lastMine != null && lastMine > at) { scheduleFan(ctx, c.id, state, now, true); return; }   // Perry typed meanwhile
    // Only chats the account took up by itself (autoStartChats) keep going; a fresh opener waits to be picked.
    if (!wrote || !state.autoStart || !autoOn(a, state)) return;
    state.maxTurns ??= 6 + Math.floor(rnd(ctx)() * 12);
    if ((state.turns || 0) < state.maxTurns) scheduleMe(ctx, c.id, state, at);
    else saveState(ctx, c.id, state, null);
  } else {
    if (!wrote) return;
    state.turns = (state.turns || 0) + 1;
    if (rnd(ctx)() < 0.93) scheduleFan(ctx, c.id, state, at, false);
    else saveState(ctx, c.id, state, null);
  }
}

/* ================= wiring ================= */
export function start(ctx) {
  ctx.hooks ??= {};
  ctx.hooks.dmWritten ??= [];
  ctx.hooks.dmWritten.push(onWritten);
  ctx.ticks.push({
    name: 'dms',
    everyMs: TICK_MS,
    fn: (now) => { fanOpeners(ctx, now); due(ctx, now); },
  });
}

/* ================= routes ================= */
export function routes(router, ctx) {
  const { db } = ctx;
  const fanOut = (c) => ({ id: c.fan, handle: c.fan_handle, pfp: c.fan_pfp || '' });

  router.add('GET', '/reel/api/dms', () => {
    const now = Date.now();
    const rows = db.prepare('SELECT c.* FROM convos c JOIN accounts a ON a.id = c.acct').all();
    const out = [];
    for (const c of rows) {
      const last = db.prepare('SELECT from_me, text, at FROM dms WHERE convo = ? AND at <= ? ORDER BY at DESC, id DESC LIMIT 1').get(c.id, now);
      if (!last) continue;
      const unread = db.prepare('SELECT COUNT(*) n FROM dms WHERE convo = ? AND from_me = 0 AND seen = 0 AND at <= ?').get(c.id, now).n;
      out.push({ acct: c.acct, fan: fanOut(c), last: { text: last.text, at: last.at, from: last.from_me ? 'me' : 'fan' }, unread });
    }
    return out.sort((x, y) => y.last.at - x.last.at);
  });

  router.add('GET', '/reel/api/dm/:acct/:fan', (req, res, params) => {
    const now = Date.now();
    const id = `${params.acct}|${params.fan}`;
    const c = db.prepare('SELECT c.* FROM convos c JOIN accounts a ON a.id = c.acct WHERE c.id = ?').get(id);
    if (!c) return { messages: [], typing: false };
    const state = parseState(c);
    tx(db, () => {
      db.prepare('UPDATE dms SET seen = 1 WHERE convo = ? AND from_me = 0 AND seen = 0 AND at <= ?').run(id, now);
      const left = db.prepare('SELECT COUNT(*) n FROM dms WHERE convo = ? AND from_me = 0 AND seen = 0').get(id).n;
      db.prepare('UPDATE convos SET unread = ? WHERE id = ?').run(left, id);
    });
    const rows = db.prepare('SELECT from_me, text, at, seen FROM dms WHERE convo = ? AND at <= ? ORDER BY at, id').all(id, now);
    const seenAt = state.next && state.next.who === 'fan' ? state.next.seenAt : null;
    const messages = rows.map((m) => ({ from: m.from_me ? 'me' : 'fan', text: m.text, at: m.at, seen: !!m.seen }));
    // Perry's message counts as seen once the fan read it (their reply is on the way, or already came)
    let fanAfter = false;
    for (let i = rows.length - 1; i >= 0; i--) {
      if (!rows[i].from_me) fanAfter = true;
      else if (fanAfter || (seenAt != null && now >= seenAt)) messages[i].seen = true;
    }
    const typing = !!(state.next && state.next.who === 'fan' && now >= state.next.at - 6000 && now < state.next.at);
    return { messages, typing };
  });

  router.add('POST', '/reel/api/dm', (req, res, params, query, body) => {
    const b = body && typeof body === 'object' ? body : {};
    if (typeof b.acct !== 'string' || typeof b.fan !== 'string' || typeof b.text !== 'string' || !b.text.trim() || !b.fan.trim()) {
      throw new HttpError(400, 'acct, fan and text are required');
    }
    if (!getAcct(ctx, b.acct)) throw new HttpError(404, 'no such account');
    meSend(ctx, b.acct, b.fan, b.text.trim(), Date.now());
    return { ok: true };
  });
}
