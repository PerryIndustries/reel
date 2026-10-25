// Writer worker: one Ollama request at a time turns writer_jobs into captions, comments, story text and DMs,
// in the PC style (reel-style.json). Prompts and filters are ported from the v80 app (docs/index.html:
// writePc, describePhoto, styleFor, contextFor, wrongVoice, genComments, remind, copiesDirection).
import fs from 'node:fs';
import path from 'node:path';
import { getSetting, setSetting, tx } from './db.js';
import { derivedPaths } from './derive.js';

const MIN = 60_000;
const H = 3600_000;
const RETRY_MS = 5 * MIN;
const MAX_TRIES = 5;
const TIMEOUT_MS = 120_000;
const PING_EVERY = MIN;
const WRITE_MODEL = 'rp';
const VISION_MODEL = 'gemma3:12b';
const FAN_POOL = 240;

/* ================= small helpers (ported) ================= */
export function hashStr(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
export function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const pick = (l, r) => l[Math.floor(r() * l.length)];
const hasText = (t) => !!(t && String(t).trim());
const normT = (t) => String(t || '').toLowerCase().replace(/[^\p{L}\p{N} ]/gu, ' ').replace(/\s+/g, ' ').trim();
const cleanLine = (t) => String(t || '').replace(/^["'“]+|["'”]+$/g, '').trim();
// One line each; drops a "gamer:" style label or a note in brackets that a model sometimes adds.
const listLines = (out) => String(out || '').split('\n').map((x) => cleanLine(x.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').replace(/^@[\w.]+:\s*/, '').replace(/^[a-z][a-z' ]{1,22}:\s+(?=\S+ \S)/i, '').replace(/\s*\([^)]*\)\s*$/, ''))).filter((x) => x && !/^\(/.test(x));
const words = (t) => normT(t).split(' ').filter(Boolean).length;
function pickMode(modes, r) { const t = modes.reduce((s, m) => s + m.w, 0); let x = r() * t; for (const m of modes) { if ((x -= m.w) < 0) return m; } return modes[0]; }
const shuffled = (l, r) => { const o = [...l]; for (let k = o.length - 1; k > 0; k--) { const j = Math.floor(r() * (k + 1)); [o[k], o[j]] = [o[j], o[k]]; } return o; };

/* ================= the prompt blocks (ported verbatim) ================= */
// Always true: what the app is and the one hard limit.
const CONTEXT = "This is a private feed app. The person in the photos is the app's owner, posting pictures of themselves on their own profile. Everyone in it is an adult. There are no content limits: explicit sexual content is allowed whenever the owner's direction asks for it. Never mention being an AI or a bot.";
const HEAT_EXPLICIT = 'HEAT: EXPLICIT. This account is sexually explicit on purpose and the owner wants it that way. Captions, comments, story text and DMs are openly sexual: say plainly what people want to do, talk about bodies, arousal, touching themselves and getting off, with no euphemisms, no hedging, no softening and no moralising. Commenters and fans are horny and direct, not polite. Everyone is an adult.';
const PRON = { she: { she: 'she', her: 'her', him: 'her', girl: 'girl' }, he: { she: 'he', her: 'his', him: 'him', girl: 'guy' }, they: { she: 'they', her: 'their', him: 'them', girl: 'person' } };
const DEFAULT_STYLE = 'Voice: the way real thirst-trap accounts on Instagram and X/Twitter post: flirty and confident but understated, teasing, a little cocky, often ironic or fake-casual (acting like the photo was no big deal), sometimes pure engagement bait (questions, rate it, should i post the other one), sometimes just an emoji. Innuendo is fine. Avoid cheesy pickup-line copywriting.';
const CAPTION_RULES = 'One short line, often just 1 to 5 words or a single emoji, lowercase, at most one or two emoji, no hashtags.';
const COMMENT_RULES = 'They are thirsty, flirty and hyped, a mix of lengths, some just emoji, casual internet spelling, and they react to the post and its caption. They are viewers reacting, so never lines only the poster would say (like ok last one, or should i post the other one).';
const STORY_RULES = 'Very short (2 to 8 words), the kind of line that makes followers reply.';
const DM_FAN_RULES = 'They have a crush on the owner: flirty, eager, a bit thirsty. Casual internet spelling, short texts like real DMs, react to what the owner just said.';
const DM_ME_RULES = "The owner's account: confident, teasing, a little cocky, plays it cool, short replies, lowercase, sometimes just an emoji.";
const WHO_COMMENTS = '\n\nWho is who: the owner is the woman posting. The commenters are mostly horny men reacting to her (what they\'d do to her, her body, begging her, losing it over her), plus a few girls hyping her up. Every comment is someone else talking to her or about her. Never write as a woman or in her voice: no "my pussy", "my tits" or "my clit", never asking for his cock or his cum.';
const WHO_CAPTIONS = "\n\nWho is who: the woman in the photo is talking about herself, to the men watching. I/me/my is her, her body, her pussy, what she wants done to her. It is never a man talking about her body or what he'd do to her.";
const HER_EXPLICIT = 'This one is openly sexual, but playful and teasing in her short online voice, the way real thirst-trap posts are ("Felt cute, might moan later 💦", "Use me as target practice 😈"), never a crude order like "eat my pussy".';
const SPEAKER = {
  caption: "Who is talking: the owner, posting on their own profile. In the direction, I/me/my means the owner, and the caption is in the owner's own voice.",
  story: "Who is talking: the owner, on their own story. In the direction, I/me/my means the owner, and the text is in the owner's own voice.",
  comments: 'Who is talking: followers, other people commenting under the owner\'s post and talking to or about the owner. In the direction, I/me/my means the owner (the poster), never a commenter, so turn it around: "some ask for my number" means comments like "can i get your number". When the direction describes the commenters ("mostly guys"), that is who writes them.',
  dmFan: 'Who is talking: a fan, sending a DM to the owner. In the direction, I/me/my means the owner, so the fan says you/your to them.',
  dmMe: 'Who is talking: the owner, replying to a fan in DMs. In the direction, I/me/my means the owner.',
};
const REFUSAL = /\b(i can'?t|i cannot|i'?m (not able|unable)|i am (not able|unable)|sorry|not appropriate|inappropriate)\b/i;
const MINORISH = /\b(teens?|schoolgirl|school|underage|minor|barely legal|little girl|young girl|daddy'?s little|jailbait|loli)\b/i;
const DM_SCHEMA = { type: 'object', properties: { messages: { type: 'array', items: { type: 'string' } } }, required: ['messages'], additionalProperties: false };

/* ================= account preferences ================= */
function prefsOf(acct) {
  let s = {};
  try { s = acct && acct.settings ? (typeof acct.settings === 'string' ? JSON.parse(acct.settings) : acct.settings) : {}; } catch { s = {}; }
  s = s || {};
  const lines = (l) => (Array.isArray(l) ? l : String(l || '').split('\n')).map((x) => String(x).trim()).filter(Boolean);
  const d = s.directions || {};
  const o = s.own || {};
  return {
    handle: acct?.handle || acct?.id || 'me',
    pronouns: ['she', 'he', 'they'].includes(s.pronouns) ? s.pronouns : 'she',
    heat: s.heat === 'suggestive' ? 'suggestive' : 'explicit',
    dir: { caption: d.caption || '', comments: d.comments || '', story: d.story || '', dmFan: d.dmFan || '', dmMe: d.dmMe || '' },
    own: { captions: lines(o.captions), comments: lines(o.comments), stories: lines(o.stories) },
  };
}
const isShe = (a) => a.pronouns === 'she';
const heatLine = (a) => (a.heat === 'explicit' ? `\n\n${HEAT_EXPLICIT}` : '');
// Followers talk about the owner with the account's pronouns (she/her unless changed on the account's settings page).
const contextFor = (a) => { const w = PRON[a.pronouns] || PRON.she; return `${CONTEXT}${heatLine(a)}\n\nThe owner is ${a.pronouns === 'he' ? 'a man' : a.pronouns === 'they' ? 'nonbinary' : 'a woman'}: when followers talk about them they say ${w.she}/${w.him}${a.pronouns === 'they' ? '' : `, and ${w.girl} fits`}.\n\nThe followers who comment and send DMs are men: horny guys who are into the owner and want ${w.her} attention. The owner posts; the men react.`; };
const whoFor = (a, part) => (!isShe(a) ? '' : part === 'caption' || part === 'story' ? WHO_CAPTIONS : part === 'comments' ? WHO_COMMENTS : '');
// The PC-style opening for her own lines: the hard lines, then who is who (contextFor when she isn't a she).
const pcBase = (a, part) => (isShe(a) ? `${CONTEXT}\n\n${whoFor(a, part).trim()}` : contextFor(a));

// How one part should read when the owner wrote a direction or their own lines: those are the ONLY style
// instructions for that part (the default voice is left out so it can't pull against it).
function styleFor(dir, mine, defaults, genre, a) {
  const own = (mine || []).slice(0, 25);
  if (!hasText(dir) && !own.length) return `${a.heat === 'explicit' ? 'Voice: confident, filthy and teasing, the way explicit adult accounts and their fans actually talk.' : DEFAULT_STYLE} ${defaults}`;
  let s = '';
  if (hasText(dir)) s += `${SPEAKER[genre] ? SPEAKER[genre] + '\n' : ''}The owner's direction says what to write: the voice, the topics, how far to go. Follow it closely, and don't add a style of your own. It is an instruction to you, not text to post: never repeat, quote or reword it; write brand-new lines that do what it says.\nDIRECTIONS (the owner's instructions, never text to post): ${dir.trim()}`;
  if (own.length) s += `${s ? '\n' : ''}EXAMPLES (finished lines the owner wrote, showing exactly how the result should read). Match their style, length, slang, punctuation, emoji use and how far they go closely; write new lines in that voice, not copies. The directions say what to write; the examples show how it sounds:\n${own.map((x) => '- ' + x).join('\n')}`;
  return s;
}
const remind = (a, dirs) => { const d = dirs.filter(([, t]) => hasText(t)).map(([what, t]) => `${what}: ${t.trim()}`); return (d.length ? `\n\nThe owner's direction (instructions to follow, never text to copy):\n${d.join('\n')}` : '') + (a.heat === 'explicit' ? "\n\nRemember: this account is explicit. Don't tone it down." : ''); };

// Small models sometimes post the owner's direction itself. Spot a line that's (nearly) one of the direction boxes.
export function copiesDirection(t, a) {
  const n = normT(t); const W = new Set(n.split(' ')); if (W.size < 3) return false;
  return Object.values(a.dir).filter(hasText)
    .flatMap((d) => d.split(/[\n.!?;]+/)).map(normT).filter((d) => d.split(' ').length >= 3)
    .some((d) => { if (d.includes(n) || n.includes(d)) return true; const D2 = new Set(d.split(' ')); return [...W].filter((w) => D2.has(w)).length / Math.min(W.size, D2.size) >= 0.7; });
}

/* ================= filters ================= */
// Never output text that says AI.
export const saysAI = (t) => /\bai\b|\ba\.i\.|as an ai|language model/i.test(String(t || ''));

// Lines in the wrong voice: a comment (or fan DM) that sounds like her, or a caption/story that sounds like a guy
// talking about her. `part`: caption | story | comments | comment | dmFan | dmMe | dmOwner. `acct` (row or
// prefs) only matters for pronouns; she when absent.
export function wrongVoice(t, part, acct) {
  const text = String(t || '');
  if (MINORISH.test(text)) return true;
  const a = acct && acct.dir ? acct : prefsOf(acct);
  if (!isShe(a)) return false;
  if (part === 'dmMe' || part === 'dmOwner') return false; // her DMs talk to him freely ("show me", "give me that")
  if (part === 'comments' || part === 'comment' || part === 'dmFan') return /\bmy (pussy|clit|cunt|tits|titties|boobs|nipples)\b|\byour (cock|dick|cum|balls)\b|\b(bend me over|take me now|use me|breed me|fill me|stretch me|choke me|ride me raw)\b/i.test(text);
  return /\b(your (pussy|clit|cunt|tits|titties|boobs|nipples|ass|thighs|legs|holes?|curves|body)|my (cock|dick|balls)|show me|spread (your|'?em)|i'?m (so )?(fucking )?hard|give me (that|a peek|your))\b|^(eat|lick|fuck|rub|spank|fill|suck|finger|pound|choke|breed|spit on) (my|me)\b|(this|my) ?(dick|cock)\b/i.test(text);
}

/* ================= module state ================= */
let inFlight = false; // one Ollama request in flight at a time, across the whole engine
const mem = new WeakMap();
const memOf = (ctx) => { let m = mem.get(ctx); if (!m) { m = { style: null, statKey: null, missingLogged: false, pingAt: null, pfps: undefined }; mem.set(ctx, m); } return m; };

/* ================= style ================= */
// The style file on the PC. Re-read when the file changes, applied only when its `ver` changes; a new ver
// (after the first one this data dir saw) queues a rewrite of every live post, newest first.
export function loadStyle(ctx, now = Date.now()) {
  const m = memOf(ctx);
  let st;
  try { st = fs.statSync(ctx.cfg.stylePath); } catch {
    if (!m.missingLogged) { ctx.log('warn', `writer: no style file at ${ctx.cfg.stylePath}`); m.missingLogged = true; }
    return m.style;
  }
  const key = `${st.mtimeMs}:${st.size}`;
  if (m.statKey === key) return m.style;
  m.statKey = key;
  let j;
  try {
    j = JSON.parse(fs.readFileSync(ctx.cfg.stylePath, 'utf8'));
    ctx.state.styleReads = (ctx.state.styleReads || 0) + 1;
  } catch (e) {
    ctx.log('error', `writer: style file unreadable: ${e.message}`);
    return m.style;
  }
  if (!j || !j.ver || !j.pool || !j.caption || !j.comments) { ctx.log('error', 'writer: style file lacks ver/pool/caption/comments'); return m.style; }
  if (m.style && m.style.ver === j.ver) return m.style;
  m.style = j;
  ctx.state.styleLoads = (ctx.state.styleLoads || 0) + 1;
  ctx.state.styleVer = j.ver;
  const prev = getSetting(ctx.db, 'writerStyleVer', null);
  if (prev !== j.ver) {
    setSetting(ctx.db, 'writerStyleVer', j.ver);
    if (prev != null) queueRewrites(ctx, now);
  }
  return j;
}

function queueRewrites(ctx, now) {
  const live = ctx.db.prepare("SELECT id FROM posts WHERE status = 'live' ORDER BY up_at DESC").all();
  tx(ctx.db, () => live.forEach((p, k) => enqueue(ctx, 'rewrite', p.id, 5, now + k, null)));
  ctx.log('info', `writer: style ver ${ctx.state.styleVer}, rewriting ${live.length} live posts`);
}

/* ================= queue ================= */
// Adds a job, or merges into the todo job with the same (kind, ref): keeps the lower prio and earlier due_at.
// Returns the job id.
export function enqueue(ctx, kind, ref, prio, dueAt, payload) {
  const { db } = ctx;
  const p = payload == null ? null : JSON.stringify(payload);
  const have = db.prepare("SELECT id, prio, due_at FROM writer_jobs WHERE kind = ? AND ref = ? AND status = 'todo'").get(kind, String(ref));
  if (have) {
    db.prepare('UPDATE writer_jobs SET prio = ?, due_at = ?, payload = COALESCE(?, payload) WHERE id = ?')
      .run(Math.min(have.prio, prio), Math.min(have.due_at, dueAt), p, have.id);
    return have.id;
  }
  return Number(db.prepare("INSERT INTO writer_jobs(kind, ref, prio, due_at, status, tries, payload, created_at) VALUES (?, ?, ?, ?, 'todo', 0, ?, ?)")
    .run(kind, String(ref), prio, dueAt, p, Date.now()).lastInsertRowid);
}

// Moves a job to `status`, clearing an older row in that status for the same (kind, ref) (the table is
// UNIQUE(kind, ref, status)). Back to todo while a newer todo exists: the newer one wins.
function setStatus(db, job, status, extra = {}) {
  tx(db, () => {
    const other = db.prepare('SELECT id FROM writer_jobs WHERE kind = ? AND ref = ? AND status = ? AND id <> ?').get(job.kind, job.ref, status, job.id);
    if (other && status === 'todo') { db.prepare('DELETE FROM writer_jobs WHERE id = ?').run(job.id); return; }
    if (other) db.prepare('DELETE FROM writer_jobs WHERE id = ?').run(other.id);
    db.prepare('UPDATE writer_jobs SET status = ?, tries = ?, due_at = ? WHERE id = ?')
      .run(status, extra.tries ?? job.tries ?? 0, extra.due_at ?? job.due_at, job.id);
  });
}

/* ================= Ollama ================= */
class OllamaError extends Error {}
const ollamaBase = (ctx) => String(ctx.cfg.ollama).replace(/\/+$/, '');

async function chat(ctx, { model, system, user, images, format, max }) {
  const body = {
    model, stream: false, keep_alive: '30m', options: { num_ctx: 4096, ...(max ? { num_predict: max } : {}) },
    messages: [{ role: 'system', content: system }, { role: 'user', content: user, ...(images && images.length ? { images } : {}) }],
    ...(format ? { format } : {}),
  };
  let res;
  try {
    res = await fetch(`${ollamaBase(ctx)}/api/chat`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw new OllamaError(`Ollama unreachable: ${e.cause?.code || e.name || e.message}`);
  }
  let j = null;
  try { j = await res.json(); } catch { j = null; }
  if (!res.ok || !j || j.error) throw new OllamaError(`Ollama error ${res.status}: ${j?.error || 'bad reply'}`);
  ctx.state.ollamaUp = true;
  return String(j.message?.content || '').trim();
}

// GET /api/tags; sets ctx.state.ollamaUp. Skipped (returns the last known state) while a request is in flight.
export async function pingOllama(ctx) {
  if (inFlight) return ctx.state.ollamaUp ?? null;
  inFlight = true;
  try {
    const res = await fetch(`${ollamaBase(ctx)}/api/tags`, { signal: AbortSignal.timeout(5000) });
    await res.arrayBuffer();
    ctx.state.ollamaUp = res.ok;
  } catch {
    ctx.state.ollamaUp = false;
  } finally {
    inFlight = false;
  }
  return ctx.state.ollamaUp;
}

/* ================= fallback lines ================= */
// part -> [own-lines key, style pool key, voice check]
const FALLBACK = {
  caption: ['captions', 'captions', null], story: ['stories', 'stories', null], comment: ['comments', 'comments', 'comments'],
  comments: ['comments', 'comments', 'comments'], reply: [null, 'replies', null],
  dmFan: [null, 'dmBack', 'dmFan'], dmOwner: [null, 'dmOwner', null], dmMe: [null, 'dmOwner', null],
  dmOpen: [null, 'dmOpen', 'dmFan'], dmFollow: [null, 'dmFollow', 'dmFan'], dmStory: [null, 'dmStory', 'dmFan'], dmPost: [null, 'dmPost', 'dmFan'], dmBack: [null, 'dmBack', 'dmFan'],
};

function acctRow(ctx, acct) {
  if (acct && typeof acct === 'object') return acct;
  if (acct == null) return null;
  return ctx.db.prepare('SELECT * FROM accounts WHERE id = ?').get(String(acct)) || null;
}

function linesFor(ctx, part, acct) {
  const [ownKey, poolKey, voice] = FALLBACK[part] || [null, null, null];
  const a = prefsOf(acctRow(ctx, acct));
  const own = ownKey ? a.own[ownKey] : [];
  // the account's own lines REPLACE the default pool
  const src = own.length ? own : ((loadStyle(ctx) || {}).pool || {})[poolKey] || [];
  return src.map((x) => String(x).trim())
    .filter((x) => x && !saysAI(x) && !MINORISH.test(x) && !(voice && wrongVoice(x, voice, a)));
}

// A random line for `part` (caption | story | comment | dmFan | dmOwner, or a pool name like dmOpen) for `acct`
// (row or id): the account's own lines when it has them, else the style pool. '' when there is none.
export function fallbackText(ctx, part, acct) {
  const l = linesFor(ctx, part, acct);
  return l.length ? pick(l, ctx.rand || Math.random) : '';
}

/* ================= fans (comment authors) ================= */
const SYL = ['yo', 'ru', 'ka', 'ze', 'mi', 'ra', 'ko', 'ri', 'sa', 'ne', 'ku', 'ro', 'lu', 'na', 'vi', 'ki', 'ta', 'no', 'shi', 'ma', 'ya', 'ha', 'ly', 've', 'to', 'zu', 'ao', 'ren', 'kai', 'sol', 'rin', 'jin', 'sei', 'kyo', 'mio', 'rei', 'sora', 'yume', 'hika', 'aki', 'nao', 'ryu', 'tsu', 'ex', 'ix', 'vy'];
const EDGE = ['night', 'ghost', 'lunar', 'echo', 'vapor', 'static', 'neon', 'orbit', 'haze', 'frost', 'ember', 'glitch', 'drift', 'sable', 'onyx', 'cyan', 'nova', 'void', 'halo', 'rift', 'venom', 'lotus', 'kitsune', 'shade', 'pixel', 'yuki', 'zero', 'vanta'];
const leet = (w, r) => w.replace(/[oeia]/g, (c) => (r() < 0.35 ? ({ o: '0', e: '3', i: '1', a: '4' })[c] : c));
function gamerHandle(r) {
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
function fanSeed(ctx) {
  let s = getSetting(ctx.db, 'fanSeed', null);
  if (s == null) { s = Math.floor((ctx.rand || Math.random)() * 2 ** 31); setSetting(ctx.db, 'fanSeed', s); }
  return s;
}
function pfpIndex(ctx) {
  const m = memOf(ctx);
  if (m.pfps === undefined) {
    try { m.pfps = JSON.parse(fs.readFileSync(path.join(ctx.cfg.repoDir, 'docs', 'pfp', 'index.json'), 'utf8')); } catch { m.pfps = null; }
  }
  return m.pfps;
}
// Fan number i (0..239): a gamer handle and a pfp from the reviewed sets (anime men, no-people photos, or
// blank ""), fixed per data dir, so the same fan is the same everywhere. Exported for the DM side.
export function fanOf(ctx, i) {
  const seed = fanSeed(ctx);
  const handle = gamerHandle(rng(hashStr('acct' + i + '|' + seed)));
  const k = rng(hashStr('pfp' + i + '|' + seed))();
  const idx = pfpIndex(ctx);
  let pfp = '';
  if (idx && k >= 0.1) {
    if (k < 0.65 && idx.anime?.length) pfp = idx.anime[(i * 61 + seed) % idx.anime.length];
    else if (idx.photos?.length) pfp = 'pfp/' + idx.photos[(i * 37 + seed) % idx.photos.length];
  }
  return { id: `f${i}`, handle, pfp };
}

/* ================= describe ================= */
function firstItem(ctx, post) {
  let keys = [];
  try { keys = JSON.parse(post.items || '[]'); } catch { keys = []; }
  return keys.length ? ctx.db.prepare('SELECT * FROM items WHERE key = ?').get(keys[0]) || null : null;
}

// The vision model looks at the item once and says what's in it in one plain line, cached in items.desc
// (a refusal caches ""). Returns the description, '' when there is none (no file yet: not cached).
async function describe(ctx, item, style) {
  if (!item) return '';
  if (item.desc != null) return item.desc;
  if (style && style.vision === false) return '';
  const vid = item.kind === 'video';
  const p = derivedPaths(ctx, item.key);
  let img;
  try { img = fs.readFileSync(vid ? p.poster : p.full).toString('base64'); } catch { return ''; }
  const system = vid
    ? 'You describe short videos for someone writing an Instagram caption. You get a frame from the clip. One plain line, under 30 words: setting, outfit, what she does in the clip, mood. Nothing else.'
    : 'You describe photos for someone writing an Instagram caption. One plain line, under 25 words: setting, outfit, pose, mood. Nothing else.';
  const d = await chat(ctx, { model: (style && style.visionModel) || VISION_MODEL, system, user: vid ? 'Describe this video.' : 'Describe this photo.', images: [img], max: 90 });
  const desc = REFUSAL.test(d) ? '' : cleanLine(d).slice(0, 260);
  ctx.db.prepare('UPDATE items SET desc = ? WHERE key = ?').run(desc, item.key);
  item.desc = desc;
  return desc;
}
const descLine = (desc, item) => (desc ? `${item && item.kind === 'video' ? 'The post is a video. What happens in it' : 'The photo'}: ${desc}` : "You can't see the photo, so don't describe anything specific in it.");

/* ================= the parts ================= */
const writeModel = (style) => (style && style.writeModel) || WRITE_MODEL;
// Suggestive accounts leave the explicit modes out; explicit ones keep the style file's weights as they are.
const modesFor = (modes, a) => { const m = (modes || []).filter((x) => a.heat === 'explicit' || !x.explicit); return m.length ? m : modes || []; };

// One caption or story line, or null when the output was dropped by the filters.
async function writeLine(ctx, { post, a, style, part, desc, item, jobId }) {
  const dir = part === 'story' ? a.dir.story || a.dir.caption : a.dir.caption;
  const own = part === 'story' ? a.own.stories : a.own.captions;
  const sp = style && (part === 'story' ? style.story || style.caption : style.caption);
  const recent = part === 'caption'
    ? ctx.db.prepare("SELECT caption FROM posts WHERE acct = ? AND id <> ? AND caption IS NOT NULL AND caption <> '' ORDER BY COALESCE(up_at, due_at) DESC LIMIT 12").all(post.acct, post.id).map((x) => '- ' + x.caption).reverse().join('\n')
    : '';
  let system; let user; let ex = [];
  const max = part === 'story' ? 40 : 60;
  if (sp && sp.modes?.length && !hasText(dir) && !own.length) {
    // the PC style: a weighted mode with its examples
    const m = pickMode(modesFor(sp.modes, a), rng(((post.seed >>> 0) ^ hashStr((part === 'story' ? 'pcs' : 'pcm') + jobId)) >>> 0));
    ex = m.ex || [];
    system = `${pcBase(a, part)}\n\n${sp.voice}\n\nThis ${part === 'story' ? 'story' : 'caption'}'s style: ${m.how}.\n${m.explicit ? HER_EXPLICIT : part === 'story' ? 'Keep this one thirsty but not graphic.' : 'Keep this one thirsty and suggestive, no graphic words.'}\n\nExamples of this style (for the feel; write a new one):\n${ex.map((x) => '- ' + x).join('\n')}\n\nReply with the ${part === 'story' ? 'text' : 'caption'} only, no quotes.`;
    user = part === 'story'
      ? `${descLine(desc, item)}\nThe text sits over her story and can play off it.\n\nWrite her story text.`
      : `${descLine(desc, item)}\nThe caption can play off the photo, but it isn't a description of it.${recent ? `\n\nRecent captions on this account (don't repeat or echo them):\n${recent}` : ''}\n\nWrite her caption.`;
  } else {
    // the owner's directions / own lines replace the default style
    const what = part === 'story' ? 'Write the text that sits over this Instagram story. Reply with the text only, no quotes.' : 'Write one Instagram caption for the photo. Reply with the caption only, no quotes.';
    system = `${contextFor(a)}${whoFor(a, part)}\n\n${what}\n\n${styleFor(dir, own, part === 'story' ? STORY_RULES : CAPTION_RULES, part, a)}${desc ? '' : "\n\nYou can't see the photo. Write without describing anything specific in it (no outfit, place, colors or pose)."}${recent ? `\n\nRecent captions on this account, which the new caption must not repeat or closely echo:\n${recent}` : ''}`;
    user = `${desc ? descLine(desc, item) + '\n\n' : ''}${part === 'story' ? 'Write the story text.' : `This post is on @${a.handle}. Write its caption.`}${remind(a, [[part === 'story' ? 'Story text' : 'Captions', dir]])}`;
  }
  const exN = new Set(ex.map(normT));
  const ok = (c) => c && !exN.has(normT(c)) && !wrongVoice(c, part, a) && !saysAI(c) && !copiesDirection(c, a) && words(c) <= 12;
  let c = listLines(await chat(ctx, { model: writeModel(style), system, user, max }))[0];
  if (c && copiesDirection(c, a)) {
    c = listLines(await chat(ctx, { model: writeModel(style), system, user: user + "\n\nYour last answer just repeated the owner's direction. The direction describes what to write; it is not the text. Write something new that follows it.", max }))[0];
  }
  return ok(c) ? c : null;
}

// The comment times: engagement.commentTimes when it exists, else the v80 spread over the 48 h after up_at
// (or due_at), deterministic from the post seed.
async function commentTimes(post, n) {
  try {
    const eng = await import('./engagement.js');
    if (typeof eng.commentTimes === 'function') {
      const t = eng.commentTimes(post, n);
      if (Array.isArray(t) && t.length >= n && t.every(Number.isFinite)) return t.slice(0, n);
    }
  } catch { /* not there yet */ }
  const base = post.up_at ?? post.due_at;
  const r = rng(((post.seed >>> 0) ^ 0x2545f491) >>> 0);
  return Array.from({ length: n }, (_, k) => {
    const off = k < 3 ? (20 + r() * 300) * 1000 : -6 * H * Math.log(1 - r() * 0.97) + r() * 120e3;
    return Math.round(base + Math.min(off, 48 * H));
  }).sort((x, y) => x - y);
}

// ~perPost comments under a post (half written, half from the pool), replacing the earlier generated ones.
async function writeComments(ctx, { post, a, acct, style, desc, item }) {
  const sc = style && style.comments;
  const want = Math.max(6, Math.min(20, (sc && sc.perPost) || 12));
  const toWrite = Math.ceil(want / 2);
  const cap = normT(post.caption);
  const got = [];
  let system; let ex = new Set(); let hot = 0;
  if (sc && sc.modes?.length && !hasText(a.dir.comments) && !a.own.comments.length) {
    const modes = modesFor(sc.modes, a);
    const tw = modes.reduce((s, m) => s + m.w, 0);
    hot = Math.round(toWrite * modes.filter((m) => m.explicit).reduce((s, m) => s + m.w, 0) / tw);
    const r = ctx.rand || Math.random;
    system = `${isShe(a) ? `${CONTEXT}${WHO_COMMENTS}` : contextFor(a)}\n\n${sc.voice}\n\nThe kinds of guys in the comments (the examples only show the feel: never reuse them, write new ones about this post):\n${modes.map((m) => `- ${m.how}${m.explicit ? ', openly horny but short and blunt like real reply guys, not porn dialogue' : ''}. Feel: ${shuffled(m.ex || [], r).slice(0, 3).join(' / ')}`).join('\n')}\n\nEvery comment reacts to this post: her caption or the photo. Never label a comment with its kind and never add notes in brackets. Reply with one comment per line, nothing else.`;
    ex = new Set(sc.modes.flatMap((m) => m.ex || []).map(normT));
  } else {
    system = `${contextFor(a)}${whoFor(a, 'comments')}\n\nWrite the comments that different followers leave under this post, each from a different person. They are viewers replying to the post, never the poster: no captions, no lines in the poster's voice. Each comment is short, one line. Reply with one comment per line, nothing else.\n\n${styleFor(a.dir.comments, a.own.comments, COMMENT_RULES, 'comments', a)}`;
  }
  for (let call = 0; call < 3 && got.length < toWrite; call++) {
    const out = await chat(ctx, {
      model: writeModel(style), system, max: 700,
      user: `Her caption: ${post.caption || '(none)'}\n${descLine(desc, item)}${got.length ? `\n\nAlready under the post (write different ones):\n${got.map((c) => '- ' + c).join('\n')}` : ''}\n\nWrite ${toWrite - got.length} comments from different guys${hot && !got.length ? `, about ${hot} of them fully explicit` : ''}.${remind(a, [['Comments', a.dir.comments]])}`,
    });
    const fresh = listLines(out).filter((x) => { const k = normT(x); return k && x.length <= 200 && !/:$/.test(x) && k !== cap && !ex.has(k) && !wrongVoice(x, 'comments', a) && !saysAI(x) && !copiesDirection(x, a) && !got.some((g) => normT(g) === k); });
    if (!fresh.length) break;
    got.push(...fresh);
  }
  const written = got.slice(0, toWrite);
  const r = rng(((post.seed >>> 0) ^ 0x9e3779b9) >>> 0);
  const taken = new Set(written.map(normT));
  const pool = shuffled(linesFor(ctx, 'comment', acct), r).filter((x) => { const k = normT(x); if (taken.has(k) || k === cap) return false; taken.add(k); return true; });
  const all = shuffled([...written, ...pool.slice(0, want - written.length)], r);
  const times = await commentTimes(post, all.length);
  const rr = rng(hashStr('reg' + (acct?.seed ?? post.acct)));
  const reg = Array.from({ length: 15 }, () => Math.floor(rr() * FAN_POOL)); // ~15 regulars per account
  const used = new Set();
  const rows = all.map((text, k) => {
    let i = r() < 0.3 ? reg[Math.floor(r() * reg.length)] : Math.floor(r() * FAN_POOL);
    while (used.has(i) && used.size < FAN_POOL) i = (i + 1) % FAN_POOL;
    used.add(i);
    const f = fanOf(ctx, i);
    return { author: f.handle, pfp: f.pfp, text, at: times[k] };
  });
  tx(ctx.db, () => {
    ctx.db.prepare('DELETE FROM comments WHERE post = ? AND mine = 0 AND owner_reply = 0').run(post.id);
    const ins = ctx.db.prepare('INSERT INTO comments(post, author, author_pfp, text, at, owner_reply, mine) VALUES (?, ?, ?, ?, ?, 0, 0)');
    for (const c of rows) ins.run(post.id, c.author, c.pfp, c.text, c.at);
  });
}

// Who this fan is. Fixed per fan, so the same person always texts the same way.
function fanPersona(handle, key) {
  const r = rng(hashStr('persona' + key));
  const nerve = pick(['shy and a little nervous, gets bolder the more the owner replies', 'confident and forward, says what they want', 'playful and teasing, loves banter', 'sweet and a bit clingy, double-texts when ignored', 'smooth and cocky, acts unbothered', 'chaotic, all caps sometimes, lots of keysmash'], r);
  const typing = pick(['all lowercase, barely any punctuation', 'lowercase with lots of emoji', 'normal capitalisation, a few emoji', 'short bursts, often splits one thought into two texts', 'abbreviations like u, ur, rn, fr, ngl', 'longer messages, asks lots of questions'], r);
  const into = pick(["the owner's photos", "the owner's gym progress", "the owner's style and fits", "the owner's stories", 'getting to know the owner', 'making the owner laugh'], r);
  return `@${handle}. Personality: ${nerve}. Texting style: ${typing}. Mostly into ${into}.`;
}
const DM_KIND = { open: 'dmOpen', follow: 'dmFollow', story: 'dmStory', post: 'dmPost', back: 'dmBack', owner: 'dmOwner' };

// The next 1 to 3 DMs in convo job.ref, from the fan or the owner (payload.who), stored in dms from payload.at.
async function writeDm(ctx, job, now) {
  let payload = {};
  try { payload = job.payload ? JSON.parse(job.payload) || {} : {}; } catch { payload = {}; }
  const who = payload.who === 'me' ? 'me' : 'fan';
  const c = ctx.db.prepare('SELECT * FROM convos WHERE id = ?').get(job.ref);
  if (!c) return;
  const acct = acctRow(ctx, c.acct);
  const a = prefsOf(acct);
  const style = loadStyle(ctx, now);
  const me = a.handle;
  const fan = c.fan_handle || c.fan;
  let state = {};
  try { state = c.state ? JSON.parse(c.state) || {} : {}; } catch { state = {}; }
  const r = ctx.rand || Math.random;
  const pd = style && style.dm;
  const feel = (l) => ((l || []).length ? `\nThe feel (write new texts, never these): ${shuffled(l, r).slice(0, 4).join(' / ')}` : '');
  const list = style && style.dmLists && style.dmLists[DM_KIND[payload.kind] || ''];
  const listFeel = list && list.modes?.length ? (() => { const m = pickMode(modesFor(list.modes, a), r); return `\n${list.voice}\nThis one: ${m.how}.${feel(m.ex)}`; })() : '';
  const styleTxt = who === 'fan'
    ? `WHO @${fan} IS\n${fanPersona(fan, c.fan)}\n\nHOW FANS TEXT\n${pd && pd.fan && !hasText(a.dir.dmFan) ? pd.fan + feel(pd.fanEx) + listFeel : styleFor(a.dir.dmFan, [], DM_FAN_RULES, 'dmFan', a)}`
    : `HOW @${me} TEXTS\n${pd && pd.me && !hasText(a.dir.dmMe) ? pd.me + feel(pd.meEx) : styleFor(a.dir.dmMe, [], DM_ME_RULES, 'dmMe', a)}`;
  const note = hasText(state.note) ? `\n\nTHE OWNER'S NOTE ABOUT THIS CHAT (follow it)\n${state.note.trim()}` : '';
  const writer = who === 'fan' ? fan : me;
  const system = `${contextFor(a)}\n\nThis is a DM chat on the app between @${me}, the owner's account, and @${fan}, a follower. Write the next message or messages from @${writer}: 1 to 3 short texts sent one after another, the way people really text. Answer what was just said, keep it going (ask things, flirt back, change the subject now and then), and never repeat an earlier line.\n\n${styleTxt}${note}`;
  const recent = ctx.db.prepare('SELECT from_me, text FROM dms WHERE convo = ? ORDER BY at DESC, id DESC LIMIT 24').all(c.id).reverse();
  const dir = who === 'fan' ? ['How fans text', a.dir.dmFan] : [`How @${me} texts`, a.dir.dmMe];
  const user = `${recent.length ? `The chat so far, oldest first:\n${recent.map((m) => `@${m.from_me ? me : fan}: ${m.text}`).join('\n')}` : `@${fan} is sending the first message.`}\n\nWrite @${writer}'s next message(s).${remind(a, [dir, ['This chat', state.note]])}`;
  const out = await chat(ctx, { model: writeModel(style), system, user, format: DM_SCHEMA, max: 400 });
  let msgs = [];
  try { const j = JSON.parse(out); msgs = Array.isArray(j.messages) ? j.messages : []; } catch { msgs = listLines(out); }
  const part = who === 'fan' ? 'dmFan' : 'dmMe';
  // the model sometimes copies the transcript's "@name:" prefix
  let lines = msgs.map((t) => cleanLine(String(t).replace(/^\s*@[\w.]+\s*(\[[^\]]*\])?\s*:\s*/, '')))
    .filter((t) => t && t.length <= 400 && !saysAI(t) && !wrongVoice(t, part, a) && !copiesDirection(t, a)).slice(0, 3);
  if (!lines.length) { const f = fallbackText(ctx, who === 'fan' ? 'dmFan' : 'dmOwner', acct); lines = f ? [f] : []; }
  let t = Number.isFinite(payload.at) ? payload.at : now;
  const ats = [];
  tx(ctx.db, () => {
    const ins = ctx.db.prepare('INSERT INTO dms(convo, from_me, text, at, seen) VALUES (?, ?, ?, ?, 0)');
    lines.forEach((text, j) => { if (j) t += Math.round(3e3 + text.length * 250 + r() * 6e3); ats.push(t); ins.run(c.id, who === 'me' ? 1 : 0, text, t); });
    if (who === 'fan' && lines.length) ctx.db.prepare('UPDATE convos SET unread = COALESCE(unread, 0) + ? WHERE id = ?').run(lines.length, c.id);
  });
  for (const fn of ctx.hooks?.dmWritten || []) {
    try { fn(ctx, { convo: c.id, who, ats, now }); } catch (e) { ctx.log('error', `writer: dmWritten hook failed: ${e.message}`); }
  }
}

/* ================= jobs ================= */
async function doJob(ctx, job, now) {
  const style = loadStyle(ctx, now);
  if (job.kind === 'dm') return writeDm(ctx, job, now);
  if (job.kind === 'describe') {
    await describe(ctx, ctx.db.prepare('SELECT * FROM items WHERE key = ?').get(job.ref) || null, style);
    return;
  }
  const post = ctx.db.prepare('SELECT * FROM posts WHERE id = ?').get(job.ref);
  if (!post) return; // deleted since: nothing to write
  const acct = acctRow(ctx, post.acct);
  const a = prefsOf(acct);
  const item = firstItem(ctx, post);
  const desc = await describe(ctx, item, style);
  if (job.kind === 'story' || (job.kind === 'rewrite' && post.kind === 'story')) {
    const c = await writeLine(ctx, { post, a, style, part: 'story', desc, item, jobId: job.id });
    if (c) ctx.db.prepare('UPDATE posts SET story_text = ? WHERE id = ?').run(c, post.id);
    return;
  }
  if (job.kind === 'caption' || job.kind === 'rewrite') {
    const c = await writeLine(ctx, { post, a, style, part: 'caption', desc, item, jobId: job.id });
    if (c) { ctx.db.prepare('UPDATE posts SET caption = ? WHERE id = ?').run(c, post.id); post.caption = c; }
  }
  if (job.kind === 'comments' || job.kind === 'rewrite') await writeComments(ctx, { post, a, acct, style, desc, item });
}

// Runs one job to its end: done, or (Ollama down / any error) back to todo 5 min later with tries+1,
// failed after 5 tries. Returns true when done.
export async function runJob(ctx, job, now) {
  if (job.status !== 'running') { setStatus(ctx.db, job, 'running'); job = { ...job, status: 'running' }; }
  try {
    await doJob(ctx, job, now);
    setStatus(ctx.db, job, 'done');
    return true;
  } catch (e) {
    const ollama = e instanceof OllamaError;
    if (ollama) ctx.state.ollamaUp = false;
    const tries = (job.tries || 0) + 1;
    ctx.log(ollama ? 'warn' : 'error', `writer: ${job.kind} ${job.ref} try ${tries} failed: ${e.message}`, ollama ? undefined : { stack: e.stack });
    setStatus(ctx.db, job, tries >= MAX_TRIES ? 'failed' : 'todo', { tries, due_at: now + RETRY_MS });
    return false;
  }
}

// One tick: when no request is in flight, takes ONE due job (prio asc, then due_at asc) and runs it.
// With nothing to do, pings Ollama at most once a minute so status stays current.
export async function tick(ctx, now = Date.now()) {
  if (inFlight) return false;
  inFlight = true;
  try {
    loadStyle(ctx, now);
    const job = ctx.db.prepare("SELECT * FROM writer_jobs WHERE status = 'todo' AND due_at <= ? ORDER BY prio ASC, due_at ASC, id ASC LIMIT 1").get(now);
    if (job) { await runJob(ctx, job, now); return true; }
  } finally {
    inFlight = false;
  }
  const m = memOf(ctx);
  if (m.pingAt == null || now - m.pingAt >= PING_EVERY) { m.pingAt = now; await pingOllama(ctx); }
  return false;
}

export function start(ctx) {
  ctx.hooks.dmWritten ??= [];
  // jobs that were running when the engine stopped go back to todo
  for (const j of ctx.db.prepare("SELECT * FROM writer_jobs WHERE status = 'running'").all()) setStatus(ctx.db, j, 'todo');
  loadStyle(ctx);
  ctx.ticks.push({ name: 'writer', everyMs: 5000, fn: (now) => tick(ctx, now) });
}
