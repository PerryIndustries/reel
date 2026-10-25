// Accounts: your own accounts (<= 5) and the made-up "other" creators. Ports the v93 generators
// (docs/index.html: gamerHandle, gamerName, NPC_BIOS, makeNpc, pfpFor) so the same seed gives the same
// account, deals every postable item to exactly one account, and grows the pool of others over time.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { allSettings, getSetting, setSetting, tx } from './db.js';
import { HttpError } from './router.js';

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const MAX_OWN = 5;
const MIN_OTHERS = 6;
const POSTABLE = 'derived = 1 AND err IS NULL AND gone = 0';

// ---- seeded helpers, copied from v93 -------------------------------------------------------------
export function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
const pick = (arr, r) => arr[Math.floor(r() * arr.length)];

const NPC_BIOS = ["18+ only 🔞", "your favorite distraction", "posting what i want", "dms open, be nice", "spicy on purpose 🌶️", "be nice or be gone", "self shot, self made", "gym rat with a camera", "night owl 🌙 posting late", "just a girl and her tripod", "link below 👇", "main account. the other one is worse", "sunsets and bad decisions", "lingerie enthusiast", "here to ruin your focus", "unapologetically me", "📍 somewhere warm", "soft launch of my chaos", "mirror selfie connoisseur", "new post most days", "not sorry 💋", "the lighting is never the problem", "no bra club", "filthy and friendly", "bad influence, good angles", "she/her · adults only", "your mom warned you about me", "i post, you stare", "professional distraction", "late night content only"];
const SYL = ["yo", "ru", "ka", "ze", "mi", "ra", "ko", "ri", "sa", "ne", "ku", "ro", "lu", "na", "vi", "ki", "ta", "no", "shi", "ma", "ya", "ha", "ly", "ve", "to", "zu", "ao", "ren", "kai", "sol", "rin", "jin", "sei", "kyo", "mio", "rei", "sora", "yume", "hika", "aki", "nao", "ryu", "tsu", "ex", "ix", "vy"];
const EDGE = ["night", "ghost", "lunar", "echo", "vapor", "static", "neon", "orbit", "haze", "frost", "ember", "glitch", "drift", "sable", "onyx", "cyan", "nova", "void", "halo", "rift", "venom", "lotus", "kitsune", "shade", "pixel", "yuki", "zero", "vanta"];
const leet = (w, r) => w.replace(/[oeia]/g, (c) => (r() < .35 ? ({ o: '0', e: '3', i: '1', a: '4' })[c] : c));

export function gamerHandle(r) {
  const two = () => pick(SYL, r) + pick(SYL, r);
  switch (Math.floor(r() * 9)) {
    case 0: return two();
    case 1: return String(100 + Math.floor(r() * 900)) + pick(SYL, r);
    case 2: return two() + Math.floor(r() * 99);
    case 3: return leet(pick(EDGE, r), r);
    case 4: return pick(SYL, r) + '.' + Math.floor(r() * 10);
    case 5: return 'x' + two() + 'x';
    case 6: { const w = two(); return w + w.slice(-1); }
    case 7: return pick(EDGE, r) + '_' + pick(SYL, r);
    default: return '_' + two();
  }
}

export function gamerName(handle, r) {
  const k = r();
  const bare = handle.replace(/^[_.]+|[_.]+$/g, '').replace(/^x(.+)x$/, '$1');
  if (k < .45) return handle;
  if (k < .75) return bare.charAt(0).toUpperCase() + bare.slice(1);
  return bare + ' ' + pick(['🦋', '🌙', '🖤', '✨', '🍒', '⚡', '🥀', '☁️', '🎧', '🕊️'], r);
}

// ---- profile pictures: only the reviewed sets in docs/pfp/index.json ------------------------------
let pfpIndex;
function loadPfpIndex() {
  if (pfpIndex !== undefined) return pfpIndex;
  try {
    const file = fileURLToPath(new URL('../../docs/pfp/index.json', import.meta.url));
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    pfpIndex = { anime: Array.isArray(j.anime) ? j.anime : [], photos: Array.isArray(j.photos) ? j.photos : [] };
  } catch {
    pfpIndex = { anime: [], photos: [] };
  }
  return pfpIndex;
}

// v93 pfpFor: ~10% blank, ~55% anime (adult men, reviewed), ~35% photos with no people. Avoids pictures
// other accounts already wear when the set is big enough.
function pickPfp(db, r) {
  const idx = loadPfpIndex();
  const used = new Set(db.prepare('SELECT pfp FROM accounts').all().map((a) => a.pfp));
  const k = r();
  const kind = k < .1 ? 'blank' : k < .65 ? 'anime' : 'photo';
  if (kind === 'blank') return '';
  const list = kind === 'anime' ? idx.anime : idx.photos.map((p) => 'pfp/' + p);
  if (!list.length) return '';
  let uri = pick(list, r);
  for (let i = 0; i < 12 && used.has(uri); i++) uri = pick(list, r);
  return uri;
}

// ---- account rows ---------------------------------------------------------------------------------
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

function defaultSettings(extra = {}) {
  return {
    directions: { caption: '', comments: '', story: '', dmFan: '', dmMe: '' },
    own: { captions: [], comments: [], stories: [] },
    pronouns: 'she',
    heat: 'suggestive',
    multi: 'off',
    ...extra,
  };
}

// Account settings merge: per top-level key; an object value (directions, own) is merged one level
// deeper so a client can send just {directions:{caption:"x"}}. Arrays and scalars replace.
function mergeSettings(base, patch) {
  const out = { ...base };
  if (!isObj(patch)) return out;
  for (const [k, v] of Object.entries(patch)) out[k] = isObj(v) && isObj(out[k]) ? { ...out[k], ...v } : v;
  return out;
}

function handleTaken(db, handle, exceptId = null) {
  const row = db.prepare('SELECT id FROM accounts WHERE handle = ?').get(handle);
  return !!row && row.id !== exceptId;
}

function rowOf(db, id) {
  return db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) ?? null;
}

const INSERT = 'INSERT INTO accounts(id, own, handle, name, bio, pfp, settings, created_at, followers, quiet, seed) VALUES (?,?,?,?,?,?,?,?,?,?,?)';

// A made-up creator, fully determined by `seed` (and the handles/pictures already taken).
export function makeOther(ctx, seed, now) {
  const { db } = ctx;
  const r = rng(hashStr('npc' + seed));
  let handle = gamerHandle(r);
  while (handleTaken(db, handle)) handle += Math.floor(r() * 90 + 10);
  const followers = Math.round(Math.exp(Math.log(200) + r() * (Math.log(40000) - Math.log(200))));
  const name = gamerName(handle, r);
  const bio = pick(NPC_BIOS, r);
  const following = Math.round(150 + r() * 900);
  const verified = followers > 30000 && r() < .6;
  const storiesPerDay = 1 + Math.floor(r() * 3);
  const multi = pick(['some', 'some', 'lots', 'off'], r);
  const pfp = pickPfp(db, r);
  let id = 'n_' + (seed >>> 0).toString(36);
  while (rowOf(db, id)) id += 'x';
  const settings = defaultSettings({ pronouns: 'she', heat: 'suggestive', multi, following, verified, storiesPerDay });
  db.prepare(INSERT).run(id, 0, handle, name, bio, pfp, JSON.stringify(settings), now, followers, 0, seed >>> 0);
  return rowOf(db, id);
}

// An account of yours. `fields`: handle, name, bio, pfp, followers, settings (all optional).
export function makeOwn(ctx, fields = {}, now = Date.now()) {
  const { db } = ctx;
  const seed = Math.floor((ctx.rand ?? Math.random)() * 1e9);
  const r = rng(seed);
  let handle = typeof fields.handle === 'string' && fields.handle.trim() ? fields.handle.trim() : gamerHandle(r);
  while (handleTaken(db, handle)) handle += Math.floor(r() * 90 + 10);
  let id = 'a_' + seed.toString(36);
  while (rowOf(db, id)) id += 'x';
  const settings = mergeSettings(defaultSettings(), fields.settings);
  const followers = Number.isFinite(fields.followers) ? Math.max(0, Math.round(fields.followers)) : 0;
  db.prepare(INSERT).run(id, 1, handle, String(fields.name ?? ''), String(fields.bio ?? ''), String(fields.pfp ?? ''),
    JSON.stringify(settings), now, followers, 0, seed);
  return rowOf(db, id);
}

export function summary(a) {
  return { id: a.id, handle: a.handle, name: a.name ?? '', pfp: a.pfp ?? '', own: !!a.own };
}

// ---- dealing --------------------------------------------------------------------------------------
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function otherTarget(postable, settings) {
  const per = Math.max(1, Number(settings.itemsPerOther) || 40);
  return clamp(Math.ceil(postable / per), MIN_OTHERS, Number(settings.maxOthers));
}

// -> [{id, w}] with w summing to 1: own accounts share ownShare evenly, the rest goes over non-quiet
// others (x2 for one made less than 7 days ago). With no usable others, own accounts take everything.
export function dealWeights(ctx, now) {
  const accts = ctx.db.prepare('SELECT id, own, created_at, quiet FROM accounts').all();
  const own = accts.filter((a) => a.own);
  const others = accts.filter((a) => !a.own && !a.quiet);
  let share = clamp(Number(allSettings(ctx.db).ownShare), 0, 1);
  if (Number.isNaN(share)) share = 0.4;
  if (!others.length) share = 1;
  if (!own.length) share = 0;
  const out = [];
  for (const a of own) out.push({ id: a.id, w: share / own.length });
  const raw = others.map((a) => (now - a.created_at < 7 * DAY ? 2 : 1));
  const total = raw.reduce((s, x) => s + x, 0);
  others.forEach((a, i) => out.push({ id: a.id, w: (1 - share) * raw[i] / total }));
  return out.filter((x) => x.w > 0);
}

// Assigns an account to every postable item that has none. Each item gets one independent draw.
export function dealNew(ctx, now = Date.now()) {
  const weights = dealWeights(ctx, now);
  if (!weights.length) return 0;
  const rand = ctx.rand ?? Math.random;
  const sum = weights.reduce((s, x) => s + x.w, 0);
  const rows = ctx.db.prepare(`SELECT key FROM items WHERE acct IS NULL AND ${POSTABLE}`).all();
  const upd = ctx.db.prepare('UPDATE items SET acct = ? WHERE key = ?');
  tx(ctx.db, () => {
    for (const { key } of rows) {
      let x = rand() * sum;
      let chosen = weights[weights.length - 1].id;
      for (const w of weights) { if ((x -= w.w) < 0) { chosen = w.id; break; } }
      upd.run(chosen, key);
    }
  });
  return rows.length;
}

// Frees everything an account holds (its items go back to the pool, its queued posts are dropped)
// and deals it again to the rest. Call after removing the account row.
export function redeal(ctx, acctId, now = Date.now()) {
  tx(ctx.db, () => {
    ctx.db.prepare("DELETE FROM posts WHERE acct = ? AND status = 'queued'").run(acctId);
    ctx.db.prepare('UPDATE items SET acct = NULL WHERE acct = ?').run(acctId);
  });
  return dealNew(ctx, now);
}

// ---- growth ---------------------------------------------------------------------------------------
// At most one new other account per window (6-30 h, stored as the nextGrowAt setting); the very first
// time (no window stored yet) it tops the pool up to 6 at once. Returns how many it created.
export function grow(ctx, now = Date.now()) {
  const { db } = ctx;
  const rand = ctx.rand ?? Math.random;
  const postable = db.prepare(`SELECT COUNT(*) n FROM items WHERE ${POSTABLE}`).get().n;
  const target = otherTarget(postable, allSettings(db));
  const have = db.prepare('SELECT COUNT(*) n FROM accounts WHERE own = 0').get().n;
  const next = getSetting(db, 'nextGrowAt', null);
  const newWindow = () => setSetting(db, 'nextGrowAt', now + (6 + rand() * 24) * HOUR);
  const create = () => makeOther(ctx, Math.floor(rand() * 1e9) + 1, now);
  if (next == null && have < MIN_OTHERS) {
    for (let i = have; i < MIN_OTHERS; i++) create();
    newWindow();
    return MIN_OTHERS - have;
  }
  if (have >= target) return 0;
  if (next != null && now < next) return 0;
  create();
  newWindow();
  return 1;
}

// Others that still hold no items 14 days after they were made go quiet (and leave the dealing).
export function quietCheck(ctx, now = Date.now()) {
  const { db } = ctx;
  let n = 0;
  for (const a of db.prepare('SELECT id, created_at, quiet FROM accounts WHERE own = 0').all()) {
    const items = db.prepare('SELECT COUNT(*) n FROM items WHERE acct = ?').get(a.id).n;
    if (items === 0 && !a.quiet && now - a.created_at >= 14 * DAY) {
      db.prepare('UPDATE accounts SET quiet = 1 WHERE id = ?').run(a.id);
      n++;
    } else if (items > 0 && a.quiet) {
      db.prepare('UPDATE accounts SET quiet = 0 WHERE id = ?').run(a.id);
    }
  }
  return n;
}

// ---- wiring ---------------------------------------------------------------------------------------
export function start(ctx) {
  const now = Date.now();
  const { db } = ctx;
  if (!db.prepare('SELECT 1 FROM accounts WHERE own = 1 LIMIT 1').get()) {
    // remembered so a later phone import can adopt it even after it has been given starter posts
    setSetting(db, 'defaultOwnId', makeOwn(ctx, {}, now).id);
  } else if (getSetting(db, 'defaultOwnId', null) == null
    && getSetting(db, 'importedAt', null) == null && getSetting(db, 'phoneImport', null) == null) {
    // a database made by an older build: its single own account is the auto-made one
    const own = db.prepare('SELECT id FROM accounts WHERE own = 1').all();
    if (own.length === 1) setSetting(db, 'defaultOwnId', own[0].id);
  }
  grow(ctx, now);
  dealNew(ctx, now);
  ctx.ticks.push({
    name: 'accounts',
    everyMs: 10 * 60_000,
    fn: (t) => { quietCheck(ctx, t); grow(ctx, t); dealNew(ctx, t); },
  });
}

const str = (v, what) => {
  if (typeof v !== 'string') throw new HttpError(400, `${what} must be a string`);
  return v;
};

function validateSettingsPatch(body) {
  if (!isObj(body)) throw new HttpError(400, 'body must be an object');
  const out = {};
  const num = (k, lo, hi, int) => {
    const v = body[k];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi || (int && !Number.isInteger(v))) {
      throw new HttpError(400, `${k} must be ${int ? 'an integer' : 'a number'} from ${lo} to ${hi}`);
    }
    out[k] = v;
  };
  if ('postsPerDay' in body) num('postsPerDay', 1, 100000, true);
  if ('ownShare' in body) num('ownShare', 0, 1, false);
  if ('itemsPerOther' in body) num('itemsPerOther', 1, 1e6, true);
  if ('maxOthers' in body) num('maxOthers', 0, 10000, true);
  if ('drivePath' in body) out.drivePath = str(body.drivePath, 'drivePath');
  if ('extraRoots' in body) {
    if (!Array.isArray(body.extraRoots) || body.extraRoots.some((x) => typeof x !== 'string')) {
      throw new HttpError(400, 'extraRoots must be an array of strings');
    }
    out.extraRoots = body.extraRoots;
  }
  return out;
}

export function routes(router, ctx) {
  const { db } = ctx;
  const full = (a) => ({ ...summary(a), followers: a.followers ?? 0, bio: a.bio ?? '', settings: JSON.parse(a.settings || '{}') });

  router.add('GET', '/reel/api/accounts', () =>
    db.prepare('SELECT * FROM accounts ORDER BY own DESC, created_at, id').all().map(full));

  router.add('POST', '/reel/api/acct', (req, res, params, query, body) => {
    if (!isObj(body)) throw new HttpError(400, 'body must be an object');
    if (db.prepare('SELECT COUNT(*) n FROM accounts WHERE own = 1').get().n >= MAX_OWN) {
      throw new HttpError(409, `${MAX_OWN} own accounts max`);
    }
    for (const k of ['handle', 'name', 'bio', 'pfp']) if (k in body) str(body[k], k);
    if ('settings' in body && !isObj(body.settings)) throw new HttpError(400, 'settings must be an object');
    if ('handle' in body && handleTaken(db, body.handle.trim())) throw new HttpError(409, 'handle taken');
    if ('followers' in body && !Number.isFinite(body.followers)) throw new HttpError(400, 'followers must be a number');
    return full(makeOwn(ctx, body, Date.now()));
  });

  router.add('PUT', '/reel/api/acct/:id', (req, res, params, query, body) => {
    const a = rowOf(db, params.id);
    if (!a) throw new HttpError(404, 'no such account');
    if (!isObj(body)) throw new HttpError(400, 'body must be an object');
    for (const k of ['handle', 'name', 'bio', 'pfp']) if (k in body) str(body[k], k);
    if ('settings' in body && !isObj(body.settings)) throw new HttpError(400, 'settings must be an object');
    let handle = a.handle;
    if ('handle' in body) {
      handle = body.handle.trim();
      if (!handle) throw new HttpError(400, 'handle cannot be empty');
      if (handleTaken(db, handle, a.id)) throw new HttpError(409, 'handle taken');
    }
    db.prepare('UPDATE accounts SET handle = ?, name = ?, bio = ?, pfp = ?, settings = ? WHERE id = ?')
      .run(handle, body.name ?? a.name, body.bio ?? a.bio, body.pfp ?? a.pfp,
        JSON.stringify(mergeSettings(JSON.parse(a.settings || '{}'), body.settings)), a.id);
    return full(rowOf(db, a.id));
  });

  router.add('DELETE', '/reel/api/acct/:id', (req, res, params) => {
    const a = rowOf(db, params.id);
    if (!a) throw new HttpError(404, 'no such account');
    if (a.own && db.prepare('SELECT COUNT(*) n FROM accounts WHERE own = 1').get().n <= 1) {
      throw new HttpError(409, 'cannot delete the last own account');
    }
    tx(db, () => {
      db.prepare('DELETE FROM accounts WHERE id = ?').run(a.id);
      redeal(ctx, a.id, Date.now());
    });
    return { ok: true };
  });

  router.add('GET', '/reel/api/settings', () => allSettings(db));

  router.add('PUT', '/reel/api/settings', (req, res, params, query, body) => {
    const patch = validateSettingsPatch(body);
    tx(db, () => { for (const [k, v] of Object.entries(patch)) setSetting(db, k, v); });
    return allSettings(db);
  });
}
