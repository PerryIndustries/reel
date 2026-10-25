// Phone import: POST /reel/api/import takes what the old phone app keeps about you (accounts, settings, the
// taste / seen / chat records) and moves it into the engine. Only the pieces below are read and stored; the
// rest of the body (S.secret, media, anything else) is never kept. Importing twice updates, never duplicates.
import { getSetting, setSetting, tx } from './db.js';
import { HttpError } from './router.js';
import { makeOwn, gamerHandle, rng, hashStr, dealNew } from './accounts.js';

const MAX_OWN = 5;
const POOL = 240; // the old app's fan pool size: fan indexes past it are the other accounts
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const text = (v) => (typeof v === 'string' ? v : '');
const lines = (v) => text(v).split('\n').map((x) => x.trim()).filter(Boolean);
const oneOf = (v, list, dflt) => (list.includes(v) ? v : dflt);

// Phone file keys: 'd_<Drive id>' (or the bare id) are Drive files; pc: / pcs: / url: keys have no Drive id.
function driveIdOf(key) {
  const k = String(key);
  if (/^(pc|pcs|url):/.test(k)) return null;
  return k.startsWith('d_') ? k.slice(2) : k;
}

// Only a site-relative pfp/ picture comes across ('url:pfp/x.jpg' is how the phone writes it for fans).
function pfpOf(avatar) {
  const a = text(avatar).replace(/^url:/, '');
  return /^pfp\/[\w.\-]+$/.test(a) ? a : null;
}

function accountFields(a, globalSettings) {
  const pick = (k) => text(a[k]) || text(globalSettings[k]);
  return {
    handle: text(a.handle).trim(),
    name: text(a.name),
    bio: text(a.bio),
    followers: Number.isFinite(a.followers) ? a.followers : undefined,
    pfp: pfpOf(a.avatar),
    directions: {
      caption: pick('capDirection'),
      comments: pick('comDirection'),
      story: pick('storyDirection'),
      dmFan: text(a.dmFanDirection),
      dmMe: text(a.dmMeDirection),
    },
    own: {
      captions: lines(pick('myCaptions')),
      comments: lines(a.myComments),
      stories: lines(pick('myStoryTexts')),
    },
    pronouns: oneOf(a.pronouns, ['she', 'he', 'they'], 'she'),
    heat: oneOf(a.heat, ['explicit', 'suggestive'], 'suggestive'),
    multi: oneOf(a.multi, ['off', 'some', 'lots'], 'off'),
  };
}

function handleTakenByOther(db, handle, id) {
  const row = db.prepare('SELECT id FROM accounts WHERE handle = ?').get(handle);
  return !!row && row.id !== id;
}

// The fan's handle the way the old app made it (fan index + the name seed); past the pool they are the other accounts.
function fanHandle(i, body) {
  const st = isObj(body.settings) ? body.settings : {};
  if (i >= POOL) {
    const npcs = (Array.isArray(body.accounts) ? body.accounts : []).filter((a) => isObj(a) && a.npc);
    const a = npcs.length ? npcs[(i - POOL) % npcs.length] : null;
    return a && text(a.handle) ? text(a.handle) : null;
  }
  const bump = isObj(st.nameBump) && Number.isFinite(st.nameBump[i]) && st.nameBump[i] ? `|${st.nameBump[i]}` : '';
  return gamerHandle(rng(hashStr(`acct${i}|${st.nameSeed || st.seed || 0}${bump}`)));
}

const IMPORT_ORIGINS = new Set(['https://perryindustries.github.io']);
function importCors(req, res) {
  const o = req.headers.origin;
  if (o && IMPORT_ORIGINS.has(o)) { res.setHeader('Access-Control-Allow-Origin', o); res.setHeader('Vary', 'Origin'); }
}

export function importPhone(ctx, body, now = Date.now()) {
  const { db } = ctx;
  if (!isObj(body)) throw new HttpError(400, 'body must be an object');
  const phoneAccts = Array.isArray(body.accounts) ? body.accounts.filter(isObj) : [];
  const phoneSettings = isObj(body.settings) ? body.settings : {};
  const misc = isObj(body.misc) ? body.misc : {};
  const counts = { accounts: 0, directions: 0, taste: 0, convos: 0, seen: 0, kept: 0, dropped: 0 };

  return tx(db, () => {
    const map = getSetting(db, 'phoneImport', { accounts: {} }).accounts ?? {};
    const claimed = new Set(Object.values(map));
    let adopted = false;
    const idMap = {}; // phone account id -> engine account id, for this import

    // ---- own accounts ----
    for (const pa of phoneAccts.filter((a) => !a.npc).slice(0, MAX_OWN)) {
      const f = accountFields(pa, phoneSettings);
      const phoneId = text(pa.id);
      let row = map[phoneId] ? db.prepare('SELECT * FROM accounts WHERE id = ? AND own = 1').get(map[phoneId]) : null;
      if (!row && f.handle) row = db.prepare('SELECT * FROM accounts WHERE own = 1 AND handle = ?').get(f.handle) ?? null;
      if (row && claimed.has(row.id) && map[phoneId] !== row.id) row = null;
      if (!row) {
        // the engine's auto-made default own account is adopted by the first imported account, starter posts and all
        const defId = getSetting(db, 'defaultOwnId', null);
        const def = defId && !claimed.has(defId) ? db.prepare('SELECT * FROM accounts WHERE id = ? AND own = 1').get(defId) : null;
        if (def) {
          row = def;
          adopted = true;
          db.prepare('DELETE FROM comments WHERE post IN (SELECT id FROM posts WHERE acct = ?)').run(def.id);
          db.prepare('DELETE FROM posts WHERE acct = ?').run(def.id);
          db.prepare('DELETE FROM dms WHERE convo IN (SELECT id FROM convos WHERE acct = ?)').run(def.id);
          db.prepare('DELETE FROM convos WHERE acct = ?').run(def.id);
          db.prepare('UPDATE items SET acct = NULL WHERE acct = ?').run(def.id);
          db.prepare("UPDATE accounts SET settings = '{}' WHERE id = ?").run(def.id);
        }
      }
      const settings = { directions: f.directions, own: f.own, pronouns: f.pronouns, heat: f.heat, multi: f.multi };
      if (row) {
        const old = JSON.parse(row.settings || '{}');
        let handle = f.handle || row.handle;
        if (handleTakenByOther(db, handle, row.id)) handle += Math.floor((ctx.rand ?? Math.random)() * 90 + 10);
        db.prepare('UPDATE accounts SET handle = ?, name = ?, bio = ?, pfp = ?, settings = ?, followers = ? WHERE id = ?')
          .run(handle, f.name, f.bio, f.pfp ?? row.pfp, JSON.stringify({ ...old, ...settings }),
            f.followers === undefined ? row.followers : Math.max(0, Math.round(f.followers)), row.id);
      } else {
        if (db.prepare('SELECT COUNT(*) n FROM accounts WHERE own = 1').get().n >= MAX_OWN) continue;
        row = makeOwn(ctx, { handle: f.handle, name: f.name, bio: f.bio, pfp: f.pfp ?? '', followers: f.followers, settings }, now);
      }
      claimed.add(row.id);
      idMap[phoneId] = row.id;
      map[phoneId] = row.id;
      counts.accounts++;
      counts.directions += Object.values(f.directions).filter((d) => d.trim()).length;
    }

    // ---- settings ----
    const perDay = phoneSettings.dailyFresh;
    if (Number.isInteger(perDay) && perDay >= 1 && perDay <= 100000) setSetting(db, 'postsPerDay', perDay);

    // ---- items: taste, seen, kept (keyed by Drive file id) ----
    const byDrive = new Map();
    for (const it of db.prepare('SELECT key, drive_id FROM items WHERE drive_id IS NOT NULL').all()) byDrive.set(it.drive_id, it);
    const want = new Map(); // item key -> {up, down, seen, kept}
    const touch = (it) => {
      if (!want.has(it.key)) want.set(it.key, { up: 0, down: 0, seen: 0, kept: 0, rated: false });
      return want.get(it.key);
    };
    const unmatched = new Set();
    const find = (k) => { const id = driveIdOf(k); return id ? byDrive.get(id) : undefined; };
    const whole = (n) => (Number(n) > 0 ? Math.floor(Number(n)) : 0);

    if (isObj(misc.taste)) {
      for (const [k, v] of Object.entries(misc.taste)) {
        const it = find(k);
        if (!it) { unmatched.add(k); continue; }
        const w = touch(it);
        w.up = Math.max(w.up, whole(v?.up));
        w.down = Math.max(w.down, whole(v?.down));
        w.rated = true;
        counts.taste++;
      }
    }
    if (isObj(misc.postSeen)) {
      for (const [k, at] of Object.entries(misc.postSeen)) {
        if (!k.startsWith('f:')) continue; // the other keys are post ids, which the engine does not share
        const fk = k.slice(2);
        const it = find(fk);
        if (!it) { unmatched.add(fk); continue; }
        const w = touch(it);
        w.seen = Math.max(w.seen, whole(at));
        counts.seen++;
      }
    }
    if (Array.isArray(misc.kept)) {
      // A liked post already counts in taste (the phone's like bumps it), so only saved or pinned posts add +1 up.
      const keptKeys = new Map(); // file key -> adds an up
      for (const p of misc.kept) {
        if (!isObj(p) || !(p.liked || p.saved || p.pinned)) continue;
        for (const k of Array.isArray(p.keys) ? p.keys : []) {
          const key = String(k);
          keptKeys.set(key, keptKeys.get(key) || !!(p.saved || p.pinned));
        }
      }
      for (const [k, adds] of keptKeys) {
        const it = find(k);
        if (!it) { unmatched.add(k); continue; }
        const w = touch(it);
        if (adds) w.kept = 1;
        counts.kept++;
      }
    }
    counts.dropped = unmatched.size;
    // max() against what the engine already has, so a second import (or a vote made on the PC) is never undone
    const cur = db.prepare('SELECT up, down, seen_at FROM items WHERE key = ?');
    const upd = db.prepare('UPDATE items SET up = ?, down = ?, seen_at = ? WHERE key = ?');
    for (const [key, w] of want) {
      const c = cur.get(key);
      upd.run(Math.max(c.up ?? 0, w.up + (w.rated ? 0 : w.kept)), Math.max(c.down ?? 0, w.down), Math.max(c.seen_at ?? 0, w.seen) || null, key);
    }

    // ---- chats (only for the accounts imported above) ----
    if (isObj(misc.convos)) {
      const upConvo = db.prepare(`INSERT INTO convos(id, acct, fan, fan_handle, fan_pfp, state, next_at, unread) VALUES (?,?,?,?,?,?,?,0)
        ON CONFLICT(id) DO UPDATE SET state = excluded.state, fan_handle = excluded.fan_handle`);
      const delDms = db.prepare('DELETE FROM dms WHERE convo = ?');
      const insDm = db.prepare('INSERT INTO dms(convo, from_me, text, at, seen) VALUES (?,?,?,?,1)');
      for (const [phoneAcct, fans] of Object.entries(misc.convos)) {
        const acct = idMap[phoneAcct];
        if (!acct || !isObj(fans)) continue;
        for (const [idx, c] of Object.entries(fans)) {
          const msgs = isObj(c) && Array.isArray(c.msgs) ? c.msgs.filter((m) => isObj(m) && typeof m.text === 'string') : [];
          const handle = fanHandle(Number(idx), body);
          if (!msgs.length || !handle) continue;
          const id = `${acct}|${handle}`;
          upConvo.run(id, acct, handle, handle, '', JSON.stringify({ note: text(c.note), imported: now }), null);
          delDms.run(id);
          for (const m of msgs) insDm.run(id, m.me ? 1 : 0, m.text, Number.isFinite(m.at) ? m.at : now);
          counts.convos++;
        }
      }
    }

    if (adopted) { setSetting(db, 'defaultOwnId', null); dealNew(ctx, now); }
    setSetting(db, 'phoneImport', { accounts: map, at: now });
    setSetting(db, 'importedAt', now);
    return counts;
  });
}

export function routes(router, ctx) {
  // The old app may still be open from its github.io copy, which posts here cross-origin.
  router.add('OPTIONS', '/reel/api/import', (req, res) => {
    importCors(req, res);
    res.writeHead(204, { 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '600' });
    res.end();
  });
  // The phone's whole export (accounts, chats, seen marks) can be far over the default 10 MB.
  router.add('POST', '/reel/api/import', (req, res, params, query, body) => {
    importCors(req, res);
    const out = importPhone(ctx, body, Date.now());
    ctx.log('info', `import: ${JSON.stringify(out)}`);
    return out;
  }, { bodyLimit: 200 * 1024 * 1024 });
}
