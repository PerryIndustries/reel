"use strict";
/* Shared by Thread (../r/) and Wire (../x/). A plain script: everything here is a global the app's own script uses.
   Reel's storage ("reel") is only ever read: accounts, the Ollama address and every photo Reel fetched. Each app keeps
   what it makes (its posts, chats, small copies of photos) in its own storage ("reel-thread" / "reel-wire").
   The app sets APP before this file ({ id, name, db, version, defaults }) and adds its views, prompts and lines after. */

/* ================= utils (from Reel) ================= */
const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const now = () => Date.now();
const MIN = 60e3, H = 3600e3, D = 86400e3;
function hashStr(s){ let h = 2166136261; for (let i=0;i<s.length;i++){ h ^= s.charCodeAt(i); h = Math.imul(h,16777619); } return h>>>0; }
function rng(seed){ let a = seed>>>0; return () => { a = (a + 0x6D2B79F5)>>>0; let t = a; t = Math.imul(t ^ t>>>15, t|1); t ^= t + Math.imul(t ^ t>>>7, t|61); return ((t ^ t>>>14)>>>0)/4294967296; }; }
const pick = (arr, r) => arr[Math.floor(r()*arr.length)];
function fmt(n){
  n = Math.max(0, Math.round(n));
  if (n < 10000) return n.toLocaleString("en-US");
  if (n < 1e6) return (n/1e3).toFixed(n < 1e5 ? 1 : 0).replace(/\.0$/,"") + "K";
  return (n/1e6).toFixed(n < 1e7 ? 1 : 0).replace(/\.0$/,"") + "M";
}
function full(n){ return Math.max(0,Math.round(n)).toLocaleString("en-US"); }
function ago(t, long){
  const s = Math.max(0, now()-t)/1000;
  if (s < 60) return long ? "Just now" : "now";
  if (s < 3600){ const m = Math.floor(s/60); return long ? m+(m==1?" minute ago":" minutes ago") : m+"m"; }
  if (s < 86400){ const h = Math.floor(s/3600); return long ? h+(h==1?" hour ago":" hours ago") : h+"h"; }
  if (s < 604800){ const d = Math.floor(s/86400); return long ? d+(d==1?" day ago":" days ago") : d+"d"; }
  if (s < 31*86400 && !long) return Math.floor(s/604800)+"w";
  if (!long) return new Date(t).toLocaleDateString("en-US",{month:"short",day:"numeric"});
  return new Date(t).toLocaleDateString("en-US",{month:"long",day:"numeric",year: new Date(t).getFullYear()===new Date().getFullYear()?undefined:"numeric"});
}
function until(t){
  const s = (t-now())/1000;
  if (s < 60) return "in under a minute";
  if (s < 3600) return "in "+Math.round(s/60)+" min";
  if (s < 86400) return "in "+(s/3600).toFixed(1).replace(/\.0$/,"")+" h";
  return new Date(t).toLocaleString("en-US",{weekday:"short",month:"short",day:"numeric",hour:"numeric",minute:"2-digit"});
}
function toast(msg){ const t = $("#toast"); if (!t) return; t.textContent = msg; t.hidden = false; clearTimeout(toast.h); toast.h = setTimeout(() => t.hidden = true, 2400); }
const isVideo = m => (m||"").startsWith("video/");
const isImage = m => (m||"").startsWith("image/");
const uid = p => p + Math.random().toString(36).slice(2,10) + Date.now().toString(36);
function shuffleInPlace(arr){ for (let i = arr.length - 1; i > 0; i--){ const j = Math.floor(Math.random() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; } return arr; }
const hasText = t => !!(t && t.trim());
const normT = t => String(t || "").toLowerCase().replace(/[^\p{L}\p{N} ]/gu, " ").replace(/\s+/g, " ").trim();
const cleanLine = t => String(t || "").replace(/^["'“]+|["'”]+$/g, "").trim();
// One line each; drops a "gamer:" style label or a note in brackets that a model sometimes adds.
const listLines = out => String(out || "").split("\n").map(x => cleanLine(x.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").replace(/^@[\w.]+:\s*/, "").replace(/^[a-z][a-z' ]{1,22}:\s+(?=\S+ \S)/i, "").replace(/\s*\([^)]*\)\s*$/, ""))).filter(x => x && !/^\(/.test(x) && !/^(here (are|is)|sure|okay,? here)/i.test(x));
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/* ================= storage ================= */
// The same small wrapper Reel uses. REEL is Reel's database, opened read-only (never created, never written);
// DB is this app's own.
function makeDB(name){
  const o = { name, db: null,
    tx(store, mode, fn){ return new Promise((res, rej) => {
      if (!o.db) return rej(new Error("closed"));
      let t; try { t = o.db.transaction(store, mode); } catch(e){ return rej(e); }
      const s = t.objectStore(store); let out;
      const q = fn(s); if (q) q.onsuccess = () => out = q.result;
      t.oncomplete = () => res(out); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
    }); },
    get: (st,k) => o.tx(st,"readonly",s=>s.get(k)),
    all: st => o.tx(st,"readonly",s=>s.getAll()),
    keys: st => o.tx(st,"readonly",s=>s.getAllKeys()),
  };
  return o;
}
const REEL = makeDB("reel");
// True when Reel has storage on this phone. Opening with no version never upgrades; if the database doesn't exist the
// upgrade is aborted so nothing is created behind Reel's back.
REEL.open = () => new Promise(res => {
  if (REEL.db) return res(true);
  let r; try { r = indexedDB.open("reel"); } catch(e){ return res(false); }
  r.onupgradeneeded = () => { try { r.transaction.abort(); } catch(e){} };
  r.onsuccess = () => { const d = r.result; if (!d.objectStoreNames.contains("posts") || !d.objectStoreNames.contains("media") || !d.objectStoreNames.contains("kv")){ d.close(); return res(false); } REEL.db = d; d.onversionchange = () => { d.close(); REEL.db = null; }; res(true); };
  r.onerror = () => res(false); r.onblocked = () => res(false);
});
const reelGet = async (st, k) => { try { if (!REEL.db && !(await REEL.open())) return undefined; return await REEL.get(st, k); } catch(e){ return undefined; } };
const DB = makeDB(APP.db);
DB.open = () => new Promise((res, rej) => {
  const r = indexedDB.open(APP.db, 1);
  r.onupgradeneeded = () => { const d = r.result; d.createObjectStore("kv"); d.createObjectStore("posts",{keyPath:"id"}); d.createObjectStore("media"); };
  r.onsuccess = () => { DB.db = r.result; res(); };
  r.onerror = () => rej(r.error);
});
DB.put = (st,v,k) => DB.tx(st,"readwrite",s=> k===undefined ? s.put(v) : s.put(v,k));
DB.del = (st,k) => DB.tx(st,"readwrite",s=>s.delete(k));
DB.clear = st => DB.tx(st,"readwrite",s=>s.clear());

/* ================= Reel's library ================= */
// Accounts, the writer's address and every photo Reel fetched, per account. Posts in Reel (up or queued) carry the
// files, and a file counts only while its blob is still there.
const LIB = { ok:false, accounts:[], current:"", secret:{ url:"", model:"" }, settings:{}, photos:new Map(), mediaKeys:new Set(), loadedAt:0 };
async function loadLibrary(){
  const okOpen = await REEL.open();
  if (!okOpen){ LIB.ok = false; LIB.accounts = []; LIB.photos = new Map(); return false; }
  let accounts, posts, keys;
  try {
    accounts = (await REEL.get("kv","accounts")) || [];
    LIB.current = (await REEL.get("kv","current")) || "";
    LIB.secret = { url:"", model:"", ...((await REEL.get("kv","secret")) || {}) };
    LIB.settings = (await REEL.get("kv","settings")) || {};
    posts = (await REEL.all("posts")) || [];
    keys = new Set((await REEL.keys("media")) || []);
  } catch(e){ LIB.ok = false; return false; }
  const photos = new Map();
  for (const a of accounts){
    const seen = new Set(), list = [];
    for (const p of posts) if (p.acct === a.id && p.kind !== "story") for (const f of p.files || []) if (isImage(f.mime) && f.key && !String(f.key).startsWith("url:") && keys.has(f.key) && !seen.has(f.key)){ seen.add(f.key); list.push({ key: f.key, mime: f.mime }); }
    photos.set(a.id, list);
  }
  LIB.accounts = accounts.map(a => ({ pronouns: "she", heat: "explicit", level: "normal", followers: 2400, following: 300, growth: 35, ...a }));
  LIB.photos = photos; LIB.mediaKeys = keys;
  LIB.ok = LIB.accounts.length > 0 && [...photos.values()].some(l => l.length > 0);
  LIB.loadedAt = now();
  return LIB.ok;
}
const photosOf = aid => LIB.photos.get(aid) || [];
const accountById = id => LIB.accounts.find(a => a.id === id);
const handleOf = a => (a && a.handle) || "unnamed";
const nameOf = a => (a && (a.name || a.handle)) || "unnamed";
// Pronoun words for the owner, per account: she (default), he or they.
const PRON = { she: { she: "she", her: "her", him: "her", girl: "girl" }, he: { she: "he", her: "his", him: "him", girl: "guy" }, they: { she: "they", her: "their", him: "them", girl: "person" } };
const genderize = (t, pr) => t.replace(/\{(she|her|him|girl)\}/g, (_, w) => (PRON[pr] || PRON.she)[w]);
const isShe = a => !a || !a.pronouns || a.pronouns === "she";
const heatOf = a => (a && a.heat) || "explicit";
// Every owner has a fixed adult age for tags like [24F]: 21 to 29.
const ageOf = a => 21 + Math.floor(rng(hashStr("age" + (a.seed || a.id)))() * 9);

/* ================= this app's state ================= */
const S = { settings: {}, misc: {}, posts: [], current: "", writerMsg: "", dmErr: "" };
const A = () => accountById(S.current) || accountById(LIB.current) || LIB.accounts[0];
const acctOf = p => (p && accountById(p.acct)) || A();
async function saveSettings(){ await DB.put("kv", S.settings, "settings"); }
async function saveMisc(){ await DB.put("kv", S.misc, "misc"); }
async function saveCurrent(){ await DB.put("kv", S.current, "current"); }
async function savePost(p){ await DB.put("posts", p); const i = S.posts.findIndex(x => x.id === p.id); if (i < 0) S.posts.push(p); else S.posts[i] = p; }
async function delPost(p){ await DB.del("posts", p.id); S.posts = S.posts.filter(x => x.id !== p.id); }
// Per-account settings for this app: how often it posts here and whether it posts here at all.
const acctSet = a => ({ perDay: APP.defaults.perDay, on: true, ...((S.settings.acct || {})[a.id] || {}) });
async function setAcct(a, patch){ S.settings.acct = { ...(S.settings.acct || {}), [a.id]: { ...acctSet(a), ...patch } }; await saveSettings(); }
async function switchTo(id){ if (!accountById(id)) return; S.current = id; await saveCurrent(); }

/* ================= media ================= */
const urls = new Map();
// A blob from this app's own storage first (small copies), then from Reel's.
async function blobFor(key){
  let b; try { b = await DB.get("media", key); } catch(e){}
  if (b) return b;
  return reelGet("media", key);
}
async function mediaURL(key){
  if (!key) return "";
  if (String(key).startsWith("url:")) return key.slice(4);
  if (urls.has(key)) return urls.get(key);
  const blob = await blobFor(key);
  if (!blob) return "";
  const u = URL.createObjectURL(blob); urls.set(key, u); return u;
}
// Grids use a small copy of each photo, made once and kept here (Reel's own copy is used when it already made one).
// A screen of full-size phone photos is more than iPhone Safari can hold.
let smallChain = Promise.resolve();
const smallJobs = new Map();
function smallPhoto(key){
  if (smallJobs.has(key)) return smallJobs.get(key);
  const job = smallChain.then(async () => {
    const tk = key + "_sm";
    if (await DB.get("media", tk)) return tk;
    if (LIB.mediaKeys.has(tk)) return tk;
    const blob = await blobFor(key); if (!blob) return "";
    const url = URL.createObjectURL(blob);
    try {
      const img = new Image(); img.src = url; await img.decode();
      const w = img.naturalWidth, h = img.naturalHeight; if (!w || !h) return "";
      const k = Math.min(1, 480 / Math.min(w, h));
      const c = document.createElement("canvas"); c.width = Math.round(w*k); c.height = Math.round(h*k);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      const out = await new Promise(res => c.toBlob(res, "image/jpeg", .8)); c.width = c.height = 0; if (!out) return "";
      await DB.put("media", out, tk); return tk;
    } catch(e){ return ""; } finally { URL.revokeObjectURL(url); }
  });
  smallChain = job.catch(() => {});
  smallJobs.set(key, job); job.then(tk => { if (!tk) smallJobs.delete(key); });
  return job;
}
// Width/height of every photo seen before, so a card keeps its space before the photo loads and the page doesn't jump.
const DIMS = (() => { try { return JSON.parse(localStorage.getItem(APP.id + "-dims") || "{}"); } catch(e){ return {}; } })();
let dimsSave = 0;
function noteDims(el, w, h){
  if (!w || !h || !el.dataset.media) return;
  const r = +(w / h).toFixed(4);
  const box = el.closest("[data-ar]"); if (box) box.style.setProperty("--ar", r);
  if (DIMS[el.dataset.media] === r) return;
  DIMS[el.dataset.media] = r; clearTimeout(dimsSave);
  dimsSave = setTimeout(() => { try { localStorage.setItem(APP.id + "-dims", JSON.stringify(DIMS)); } catch(e){} }, 1000);
}
document.addEventListener("load", e => { const el = e.target; if (el.tagName !== "IMG") return; noteDims(el, el.naturalWidth, el.naturalHeight); el.classList.add("ld"); }, true);
async function hydrate(root){
  if (!root) return;
  // Already-opened files go in straight away with no fade, so a redraw doesn't flicker; the rest load side by side.
  const later = [];
  for (const el of root.querySelectorAll("img[data-small]:not([data-sm])")){
    el.dataset.sm = "1";
    const k = String(el.dataset.media); if (k.startsWith("url:")) continue;
    const hit = urls.get(k + "_sm");
    if (hit){ el.classList.add("ld"); el.src = hit; continue; }
    later.push(el);
  }
  for (const el of root.querySelectorAll("img[data-media]")){
    if (el.getAttribute("src") || el.dataset.sm) continue;
    const k = String(el.dataset.media), hit = k.startsWith("url:") ? "" : urls.get(k);
    if (hit){ el.classList.add("ld"); el.src = hit; } else later.push(el);
  }
  await Promise.all(later.map(async el => {
    if (el.dataset.sm){ const sk = await smallPhoto(el.dataset.media); if (el.isConnected && !el.getAttribute("src")) el.src = await mediaURL(sk || el.dataset.media); return; }
    const u = await mediaURL(el.dataset.media); if (u && !el.getAttribute("src")) el.src = u;
  }));
}
function mediaTag(f, cls, opts={}){
  const ar = DIMS[f.key] ? ` style="--ar:${DIMS[f.key]}"` : "";
  return `<img class="${cls||""}" data-media="${esc(f.key)}"${opts.small ? " data-small" : ""} alt=""${ar} ${opts.lazy===false?"":'loading="lazy"'}>`;
}
// A photo in a box that keeps its shape: the box carries the known ratio so the page is laid out before the photo loads.
const picBox = (f, cls, opts={}) => `<div class="${cls||"pic"}" data-ar${DIMS[f.key] ? ` style="--ar:${DIMS[f.key]}"` : ""}>${mediaTag(f, "", opts)}</div>`;
function myAv(size, a){
  a = a || A();
  if (a && a.avatar) return `<span class="av s${size}"><img data-media="${esc(a.avatar)}" alt=""></span>`;
  return `<span class="av s${size}" style="background:linear-gradient(135deg,#ffb23f,#ff5a36 50%,#d6249f)">${esc((nameOf(a) || "Y")[0].toUpperCase())}</span>`;
}

/* ================= fake people (from Reel) ================= */
const POOL = 240;
const BIOS = ["coffee first ☕","just here for the vibes","📍 LA","photos + bad jokes","living slowly","catch me outside","gym · food · repeat","sunsets collector 🌅","dog parent 🐶","new music fridays","travel when I can ✈️","film camera era 📷","ok but where's the food","always on the move","main character energy","designer by day","night owl 🌙","say less","here for the comments","lurker, mostly","28, taken by the gym","6'2 since you asked","dms open","adult account, 18+ only","just appreciating art","i reply to everything",""];
const SYL = ["yo","ru","ka","ze","mi","ra","ko","ri","sa","ne","ku","ro","lu","na","vi","ki","ta","no","shi","ma","ya","ha","ly","ve","to","zu","ai","ren","kai","sol","rin","jin","sei","kyo","mio","rei","sora","yume","hika","aki","nao","ryu","tsu","ex","ix","vy"];
const EDGE = ["night","ghost","lunar","echo","vapor","static","neon","orbit","haze","frost","ember","glitch","drift","sable","onyx","cyan","nova","void","halo","rift","venom","lotus","kitsune","shade","pixel","yuki","zero","vanta"];
const leet = (w, r) => w.replace(/[oeia]/g, c => r() < .35 ? ({o:"0",e:"3",i:"1",a:"4"})[c] : c);
function gamerHandle(r){
  const two = () => pick(SYL,r) + pick(SYL,r);
  switch (Math.floor(r()*9)){
    case 0: return two();
    case 1: return String(100 + Math.floor(r()*900)) + pick(SYL,r);
    case 2: return two() + Math.floor(r()*99);
    case 3: return leet(pick(EDGE,r), r);
    case 4: return pick(SYL,r) + "." + Math.floor(r()*10);
    case 5: return "x" + two() + "x";
    case 6: { const w = two(); return w + w.slice(-1); }
    case 7: return pick(EDGE,r) + "_" + pick(SYL,r);
    default: return "_" + two();
  }
}
function gamerName(handle, r){
  const k = r();
  const bare = handle.replace(/^[_.]+|[_.]+$/g, "").replace(/^x(.+)x$/, "$1");
  if (k < .45) return handle;
  if (k < .75) return bare.charAt(0).toUpperCase() + bare.slice(1);
  return bare + " " + pick(["🦋","🌙","🖤","✨","🍒","⚡","🥀","☁️","🎧","🕊️"], r);
}
const acctCache = new Map(), usedHandles = new Set();
function acct(i){
  if (acctCache.has(i)) return acctCache.get(i);
  const r = rng(hashStr("acct"+i+"|"+S.settings.seed));
  let handle = gamerHandle(r);
  if (usedHandles.has(handle)) handle += Math.floor(r()*90 + 10);
  usedHandles.add(handle);
  const big = r() < .06;
  const followers = Math.round(big ? 20000 + r()*900000 : Math.exp(4 + r()*4.5));
  const a = { i, handle, name: gamerName(handle, r), bio: pick(BIOS,r), followers, following: Math.round(80 + r()*1400), posts: 6 + Math.floor(r()*120), verified: big && r() < .5, joined: now() - (90 + r()*2200)*D, karma: Math.round(Math.exp(5 + r()*6)), seed: hashStr("t"+i+"|"+S.settings.seed) };
  acctCache.set(i, a); return a;
}
// Every fake account gets a picture: the reviewed anime characters (adult men only), photos with no people in them,
// and some blank defaults. Same set as Reel, served from ../pfp/.
let pfpIndex = null, pfpLoading = null;
const pfpCache = new Map();
function loadPfps(){
  if (pfpLoading) return pfpLoading;
  pfpLoading = fetch("../pfp/index.json").then(r => r.json()).then(j => { pfpIndex = j; pfpCache.clear(); safeRender(); return j; }).catch(() => { pfpLoading = null; });
  return pfpLoading;
}
const BLANK_PFP = "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="#dbdbdb"/><circle cx="50" cy="39" r="17" fill="#fff"/><path d="M18 92c3-20 17-30 32-30s29 10 32 30z" fill="#fff"/></svg>');
let pfpPerm = null;
function pfpFor(a){
  if (pfpCache.has(a.i)) return pfpCache.get(a.i);
  if (!pfpIndex) return "";
  if (!pfpPerm){
    const r0 = rng(hashStr("perm" + S.settings.seed));
    const shuffle = n => { const o = Array.from({length:n}, (_,k) => k); for (let k = n-1; k > 0; k--){ const j = Math.floor(r0()*(k+1)); [o[k], o[j]] = [o[j], o[k]]; } return o; };
    pfpPerm = { a: shuffle(pfpIndex.anime.length), p: shuffle(pfpIndex.photos.length) };
  }
  const k = rng((a.seed ^ 0x3c6ef372) >>> 0)();
  let uri;
  if (k < .1) uri = BLANK_PFP;
  else if (k < .65) uri = pfpIndex.anime[pfpPerm.a[a.i % pfpPerm.a.length]];
  else uri = "../pfp/" + pfpIndex.photos[pfpPerm.p[a.i % pfpPerm.p.length]];
  pfpCache.set(a.i, uri);
  return uri;
}
function acctAv(a, size){
  const pic = pfpFor(a);
  if (pic) return `<span class="av s${size}"><img src="${pic}" alt="" loading="lazy" ${pic.startsWith("http") ? 'style="object-position:50% 18%"' : ""}></span>`;
  loadPfps();
  return `<span class="av s${size}" style="background:#dbdbdb"></span>`;
}
// About 15 fans per owner who show up again and again.
const regularsOf = a => { const r = rng(hashStr("reg" + a.seed + APP.id)); return Array.from({ length: 15 }, () => Math.floor(r() * POOL)); };
// Who this follower is. Fixed per fan, so the same person always texts the same way.
function fanPersona(f){
  const r = rng(hashStr("persona" + f.i + "|" + S.settings.seed));
  const nerve = pick(["shy and a little nervous, gets bolder the more the owner replies", "confident and forward, says what he wants", "playful and teasing, loves banter", "sweet and a bit clingy, double-texts when ignored", "smooth and cocky, acts unbothered", "chaotic, all caps sometimes, lots of keysmash", "filthy and blunt, no small talk"], r);
  const typing = pick(["all lowercase, barely any punctuation", "lowercase with lots of emoji", "normal capitalisation, a few emoji", "short bursts, often splits one thought into two texts", "abbreviations like u, ur, rn, fr, ngl", "longer messages, asks lots of questions"], r);
  const into = pick(["the owner's body", "the owner's ass", "the owner's tits", "what the owner posts late at night", "getting the owner to send more", "getting the owner to meet up"], r);
  return `@${f.handle} (name ${f.name}). Personality: ${nerve}. Texting style: ${typing}. Mostly into ${into}.`;
}

/* ================= growth + engagement (from Reel) ================= */
const LEVEL = { low:.45, normal:1, high:2.2, viral:5 };
function baseFollowersAt(a, t){
  const start = a.startedAt || now() - 30*D;
  const days = Math.max(0, (t - start)/D);
  const r = rng(hashStr("f"+Math.floor(days)+"|"+a.seed));
  return Math.round((a.followers || 2400) * (APP.defaults.followerScale || 1) + (a.growth || 35)*days*(LEVEL[a.level]||1)*(.8+r()*.4));
}
// Engagement lands fast after posting: a burst in the first minutes, then it keeps climbing for about a day.
const curve = (age, tau) => age <= 0 ? 0 : 1 - .9*Math.exp(-age/tau) - .1*Math.exp(-age/(6*60e3));
function followBump(p, a){
  const r = rng(p.seed ^ 0x7f4a7c15);
  const lv = LEVEL[a.level] || 1;
  let rate = .012 + r()*.03;
  if (r() < .15) rate *= 2.5 + r()*3;
  return Math.round(baseFollowersAt(a, p.publishAt) * rate * Math.sqrt(lv));
}
function followersAt(a, t){
  let n = baseFollowersAt(a, t);
  for (const p of S.posts) if (p.acct === a.id && p.publishAt && p.publishAt <= t) n += Math.round(followBump(p, a) * curve(t - p.publishAt, 5*H));
  return n;
}
const followersNow = a => followersAt(a || A(), now());
// What a post ends up with. Seeded, so the numbers never jump around; apps turn these into their own counts.
function totals(p){
  const a = acctOf(p);
  const r = rng(p.seed);
  let rate = (.05 + r()*.08) * (LEVEL[a.level] || 1);
  if (r() < .12) rate *= 2 + r()*3.5;
  const L = Math.round(followersAt(a, p.publishAt) * Math.min(rate, 2.5));
  const C = Math.max(3, Math.round(L * (.03 + r()*.03)));
  return { L, C, V: Math.round(L * (5 + r()*9)), r2: r() };
}
function engage(p){
  const t = totals(p);
  const age = Math.max(0, now() - p.publishAt);
  return { likes: Math.round(t.L * curve(age, 4*H)), comments: Math.round(t.C * curve(age, 6*H)), views: Math.round(t.V * curve(age, 5*H)), ...t };
}
function likerSample(p, n){
  const r = rng(p.seed ^ 0x5bd1e995); const out = new Set();
  while (out.size < Math.min(n, POOL)) out.add(Math.floor(r()*POOL));
  return [...out];
}
const followMap = () => (S.misc.follows[A().id] ||= {});
function baseFollowing(i){ return rng(hashStr("fol"+i+A().seed))() < .35; }
function isFollowing(i){ const m = followMap(); return (i in m) ? m[i] : baseFollowing(i); }
function followsYou(i, o){ return rng(hashStr("fy"+i+(o || A()).seed))() < .8; }

/* ================= lines (Reel's, plus explicit ones) ================= */
// Her voice: what the owner writes about herself. Men: what the fans say to her and about her.
const THIRST = ["caught you looking 👀","you're welcome","thought you could use a distraction","not my fault you're staring","dangerous in the best way","your new favorite view","don't fall in love","too late, you already looked twice","behave. or don't 😈","come closer","woke up dangerous","the audacity of this angle","you can look. touching is negotiable","mind if i ruin your focus for a sec","careful, i bite 😏","ask me what i'm doing later","felt cute, might ruin your day","this is your sign to text me","not a thirst trap. ok it is.","hydrate. you'll need it 💦","bet you zoomed in","zoom in, i dare you","rate the view 1-10, wrong answers only","dm me your excuses","one more scroll and you're mine","keep staring, it's free","the reason you're still awake","distract me","come find out","i look innocent, don't i","not a snack. the whole meal 🍽️","if you're reading this, you looked too long","good lighting, bad intentions","sweet face, sinful thoughts","your ex is typing…","late night content 🌙","it's giving dangerous","you up?","lights low, standards high","dress code: optional","i don't do subtle","i'll be in your thoughts tonight","not sorry 💋","admit it, you saved it","this post is a test. you failed 😏","🫠","👀","anyway","be honest","which one, 1 or 2","mirror said yes","pov: you swiped","no context","ok last one","i'll stop posting when you stop looking","be honest is this a 10","posting this before i chicken out","the cropped version was safer","replies are open. behave","should i post the other one 👀","if this gets enough love i post the other angle","didn't have to go this hard. did anyway"];
const HER_VOICE = ["come watch me play", "wet just thinking about it", "who's coming over to fix this", "bet you can't handle me", "my ass in your face would cure you", "i need it rough tonight", "guess what i'm not wearing", "be honest, would you fuck me", "touching myself to your comments", "ruin me", "your turn to beg"];
const HER_EXPLICIT = ["soaked and nobody's home to fix it","took this right after i came. twice.","my fingers aren't enough tonight","who wants a taste","bend me over this counter already","i want to be used tonight. properly.","my nipples have been hard since i woke up","tell me exactly how you'd fuck me. details.","no panties under this. you're welcome","i need a cock in me and i'm not being subtle about it","this is what i look like right before i get railed","rate my ass then tell me what you'd do to it","edged for an hour and posted this instead of finishing","fresh out of the shower and already wet again","spread me","my pussy's been aching all day, help","cum on my tits or my face, pick one","i want to be on my knees for somebody tonight","guess which hole i'm thinking about","touched myself to your comments again. keep going","sitting on your face would cure what's wrong with you","wearing this until someone takes it off me","i moan loud. ask the neighbors","i want to feel it in my throat","slide in. not talking about the dms","i'd ride you until you can't walk straight","be honest, would you cum fast","fuck me like you're mad at me","someone come eat this","dripping. that's the caption.","ok fine i'm horny, come fix it","still thinking about last night's dick","first one to make me cum gets the rest of the set","i love being watched. keep looking","my ass needs attention and so do i","bite marks welcome","choke me a little","want to see how wet i am rn","spit on it first","i came so hard to the thought of you watching this"];
const MEN_SOFT = ["who allowed this","down bad rn","the audacity 😳","CALM DOWN","respectfully… wow","not me zooming in","the internet isn't ready","i need a minute","stop it right now 😩","saving this for research","this should be illegal","my screen is fogging up","help 🫠","threat 😮‍💨","be serious rn","you did this on purpose","hydrating rn 💦","the way i gasped","sinful","dangerous behavior","i'm not okay","okay but WHO took this","have mercy 😭","my type exactly","i'd risk it all","feeling unwell after this","rent free in my head now","what's your number","drop the location 📍","i'd do unspeakable things for this","you can't just post this and expect me to function","come over","dm me, i won't tell","ok you have my full attention","i'd let you ruin my life","stop being this fine, it's rude","praying for strength 🙏","need you to post the rest","who's taking you home","my phone is overheating","asking for a friend: are you single","SIR 😮‍💨","pause","who let you post this","hello?????","nah this is unfair","ATE","i screamed","oh {she} KNOWS","screenshotted for science","post the other one coward","liked, saved, prayed","this should come with a warning","my jaw is on the floor","that's illegal in 4 states","😍🔥😈","🥵🥵🥵","🫦","😮‍💨😮‍💨","👀👀👀","💦💦"];
const MEN_EXPLICIT = ["i'd eat that pussy for hours","fuck, i need to be inside you","jerking off to this right now, not even sorry","the things i'd do to that ass","bend over and let me ruin you","i'd cum in 30 seconds and go again","sit on my face please","those tits need my cum on them","god i want to fuck you so bad","i'd fill you up and watch it drip out","my cock is so hard right now","spread those legs for me","i'd fuck you until you can't walk","that body was made to get railed","i'd worship every inch of you","let me taste you","on your knees, mouth open","i'd pull your hair and pound you from behind","i want to hear you moan my name","came twice to this already","you need a real man to use that body","i'd lick you clean","fuck me, that ass is perfect","dm me, i'll make you cum harder than your toys do","i'd eat you out while you post the next one","need to see those tits bounce","i'd stretch you out so good","you'd be screaming by the time i'm done with you","i'm so hard it hurts","let me cum on that face","wrap those legs around me","i'd fuck that pussy raw","the way i'd pin you down…","come sit on this dick","i'd finger you until you squirt","show us the rest and i'll show you mine","i'd fuck you on that counter","need you riding me right now","my cum would look so good on you","i'd kiss down your stomach and not stop","you're making me stroke it slow","i want to taste every drop of you","bend you over and fuck you stupid","goddamn i'd pound that","edging to this thread","let me suck on those nipples","i'd fuck you in every room of that house","post the one without the towel","my dick is twitching rn","i'd cum deep inside that","holy fuck, those curves","i'd have you dripping in two minutes","where do i sign up to eat that","going to have to jerk off again, thanks","i'd make you squirt all over me","get on all fours for me","the sounds you'd make with my face between your legs","i'd fuck that mouth first","your pussy would be the best thing i've ever tasted","i'd cum on those tits and make you rub it in"];
// Men talking to other men in the thread, and men answering her when she replies.
const MEN_BANTER = ["bro's down horrendous and honestly same","get in line","we're all jerking off to the same post, be nice","she's not reading this but i am and i agree","100% she knows exactly what she's doing","sir this is a public forum. anyway same","you said what we're all thinking","he's not wrong tho","i'd let him watch tbh","the restraint it took me not to comment this myself","touch grass. after i'm done here","rip your inbox my guy","found the guy who finished first","nah you're too polite about it. i'd ruin her","say it louder for the ones in the back","down bad brotherhood checking in","we lost another one","this comment section is a crime scene","no notes","stop being this horny in public. said while being horny in public","upvoted so hard my phone cracked","the dedication","he's been here since the first post, respect","she replied to him?? fuck","+1 and i'm not ashamed","her replies are somehow hotter than the photo","this is the most honest comment here","speak for yourself. ok no you're right","both of you shut up and let me finish","we are not the same. i'd last longer","he said it with his whole chest","the guy who comments under every post is here, as expected","respectfully this is why her dms are full","same hand same post same result","my man typed this one-handed","you're going to make her post less, be chill. jk post more"];
const MEN_TO_HER = ["omg she replied","wait you actually answered","ok now i'm REALLY hard","say less, i'm coming over","you're going to kill me","fuck. ok. where","she's a menace and i'm here for it","the way my heart dropped","i'd do anything you say and you know it","marry me. or just ruin me, whichever","yes ma'am","you can't say that and leave","i'm shaking lol","screenshotting this forever","anything for you honestly","ok you win. hi","holy shit she's real and she's talking to me","that's it, i'm done, you have me","my dick heard that","say it again slower","fuck, you're going to make me cum from a comment","okay okay okay. checking my dms","this is the best thing that's happened to me all week","i'll beg, tell me how","you're even worse than the photo, i love it"];
// Her, answering under her own post: short, teasing, filthy when she feels like it.
const OP_REPLIES = ["good boy","you first","prove it","that's the plan 😏","dms are open","wet already? me too","keep talking, it's working","how fast is fast","i'd let you","that's a lot of promises for a guy who hasn't dm'd me","mm say more","come find out","beg","oh i know","you'd tap out first","i love when you're honest","the rest is in my dms, be nice","noted. in both senses","yes. louder.","i post for exactly this","cute. harder.","took you long enough","which hole","ok you've earned the next one","still touching myself btw","don't stop now","patience, baby","and then what","💦","😈","lol you'd last two minutes","i was hoping someone would say that","you talk like you could handle me","mmm. keep going","this is why i post","be careful what you ask for","that one made me squeeze my thighs together","i read every one of these in bed","fine. come over. bring snacks and stamina","you're my favorite today"];
// Fans' DMs: openers, follow-ups, lines about a post, what the owner's account answers, and what they say back.
const DM_OPEN = ["hey 👀","hiii","you're actually so fine","ok i have to say it… wow","can we talk?","been following a while and wow","you up?","ur pics are dangerous","be honest are you single","heyyy stranger","not me sliding in rn 🙈","you don't know how long i've wanted to message you","hey cutie","your last post?? 😮‍💨","we should hang out fr","how are you this attractive","hey :)","is it weird i saved your last post","do you ever reply 🥺","hi from your biggest fan","you have no idea what that post did to me","free this weekend? 👀","you're my favorite account fr","i think about your pics way too much","you can't post that and expect me to behave","lowkey obsessed with your page","not to be weird but","so are you gonna let me take you out or","wyd","is this a bad time to say hi","ok you win, hi","i just came to your last post and felt like you should know","what would it take to see more","i'd eat you out for breakfast lunch and dinner","be honest do you read these while you touch yourself","i'm hard just from your profile pic","tell me what you're wearing","i want to fuck you so bad it's a problem","do you ever meet up with fans","can i send you something 👀","i'd pay to watch you cum"];
const DM_FOLLOW = ["hello??","😳","sorry that was forward","ok ignore me then 😔","pls notice me","just saying hi again","still thinking about that post","?","👀👀","no pressure lol","i'll wait","still hard btw","ok i'll behave. maybe"];
const DM_POST = ["this one 😮‍💨","ok THIS pic","why'd you post this 😭","saved this one","the fit in this","can't stop looking at this","you know what you did here","this angle tho","explain yourself 😳","been staring at this for 10 min","10/10","be fr this is unfair","this one lives in my head now","came to this one twice","i need the uncropped version of this","this one broke me"];
const DM_OWNER = ["haha thank you 😌","stop it 😭","maybe 👀","hey you","appreciate you","lol you're sweet","you're trouble","what are you up to","hii 🙂","guess you'll have to wait and see","😏","thank uu","shy? you don't seem shy 😂","ok you're cute","no comment 🤐","lol you're bold","keep talking","and what would you do about it","prove it","ask nicer 😏","we'll see","hmm convince me","earn it","mm i read that one twice","you can send it. i'll decide if i'm impressed","i'm in bed. your move","that depends how good you are with your mouth"];
const DM_BACK = ["omg you replied","😭😭 hi","ok i'm dead","wait really?","you made my day","nothing much, you?","i'm blushing","you're even nicer than i thought","🥹","ok now i'm nervous","fuck ok. hi","i was not ready for you to answer","you're going to get me in so much trouble","so… what are you wearing","i'd be so good to you","ok that made me harder than the post did","tell me when and i'm there","give me a chance to show you","i'd worship you","say the word"];
// Lines in the wrong voice: a comment that sounds like her, or a line of hers that sounds like a guy talking about her.
const MINORISH = /\b(teens?|schoolgirl|school|underage|minor|barely legal|little girl|young girl|daddy'?s little|jailbait|loli|high ?school)\b/i;
// Ages: any tag or age under 21 is thrown out ([19F], f20, 18 yo).
const AGEBAD = /[\[(]\s*(0?[1-9]|1\d|20)\s*[fFmM]?\s*[\])]|\b(0?[1-9]|1\d|20)\s*[fFmM]\b|\b[fFmM]\s*(0?[1-9]|1\d|20)\b|\b(0?[1-9]|1\d|20)\s*(yo|y\/o|yrs?|years? old)\b/;
const badAge = t => AGEBAD.test(String(t || ""));
function wrongVoice(t, a, part){
  if (MINORISH.test(t) || badAge(t)) return true;
  if (/\b(ai|bot|language model|as an ai)\b/i.test(t) && /\b(i am|i'm|as an?)\b/i.test(t)) return true;
  if (!isShe(a)) return false;
  if (part === "comments") return /\bmy (pussy|clit|cunt|tits|titties|boobs|nipples)\b|\byour (cock|dick|cum|balls)\b|\b(bend me over|take me now|use me|breed me|fill me|stretch me|choke me|ride me raw)\b/i.test(t);
  return /\b(your (pussy|clit|cunt|tits|titties|boobs|nipples|ass|thighs|legs|holes?|curves|body)|my (cock|dick|balls)|show me|spread (your|'?em)|i'?m (so )?(fucking )?hard|give me (that|a peek|your))\b/i.test(t);
}
// Everything the style on the PC lists, when there is one, joins the built-in lines.
const PC = () => S.settings.pcStyle || LIB.settings.pcStyle || null;
const poolOf = part => { const st = PC(); const l = st && st.pool && st.pool[part]; return Array.isArray(l) ? l : []; };
// A mix of mild and explicit, the way a real adult account reads: about a third of hers and half of the men's go all the way.
function herLine(a, r, extra){
  const pool = [...poolOf("captions"), ...(extra || [])];
  const x = r();
  let t = pool.length && x < .5 ? pick(pool, r) : x < .7 ? pick(HER_EXPLICIT, r) : x < .78 ? pick(HER_VOICE, r) : pick(THIRST, r);
  t = genderize(t, a.pronouns);
  return wrongVoice(t, a, "caption") ? pick(HER_EXPLICIT, r) : t;
}
function menLine(a, r, extra){
  const pool = [...poolOf("comments"), ...(extra || [])];
  const x = r();
  let t = pool.length && x < .4 ? pick(pool, r) : x < .72 ? pick(MEN_EXPLICIT, r) : pick(MEN_SOFT, r);
  t = genderize(t, a.pronouns);
  return wrongVoice(t, a, "comments") ? pick(MEN_EXPLICIT, r) : t;
}

/* ================= the writer (Ollama on the owner's PC, address from Reel) ================= */
const DEFAULT_MODEL = "rp";
const ollamaURL = () => (LIB.secret.url || "").trim().replace(/\/+$/, "");
const ollamaModel = () => (LIB.secret.model || "").trim() || DEFAULT_MODEL;
function aiError(kind, message){ const e = new Error(message); e.kind = kind; return e; }
const errKind = e => (e && e.kind) || "";
async function ask(system, content, schema, max, model){
  const base = ollamaURL(); if (!base) return null;
  const body = {
    // Streamed, so the phone keeps hearing from the PC: iPhone drops a request that's silent for about a minute.
    model: model || ollamaModel(), stream: true, keep_alive: "30m", options: { num_ctx: 4096, num_predict: max || (schema ? 1000 : 160) },
    messages: [{ role: "system", content: system }, { role: "user", content: content.filter(b => b.type === "text").map(b => b.text).join("\n\n") }],
    ...(schema ? { format: schema } : {}),
  };
  let res;
  for (let attempt = 0; ; attempt++){
    try { res = await fetch(`${base}/api/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); }
    catch(e){ throw aiError("conn", "Couldn't reach Ollama"); }
    if (res.status >= 500 && attempt < 2){ await new Promise(r => setTimeout(r, 2000 * (attempt + 1))); continue; }
    break;
  }
  if (!res.ok){
    const j = await res.json().catch(() => ({}));
    const msg = j.error || `Ollama error ${res.status}`;
    throw aiError(res.status === 404 && /model/i.test(msg) ? "model" : "", msg);
  }
  let text = "", buf = "";
  const take = line => { if (!line.trim()) return; const j = JSON.parse(line); if (j.error) throw aiError("", j.error); text += j.message?.content || ""; };
  try {
    const reader = res.body.getReader(), dec = new TextDecoder();
    for (;;){
      const { done, value } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n"); buf = lines.pop();
      lines.forEach(take);
    }
    take(buf);
  } catch(e){ throw e.kind !== undefined ? e : aiError("conn", "Lost the connection to Ollama"); }
  text = text.trim();
  if (!text) return null;
  return schema ? JSON.parse(text) : text;
}
// Always true: what the app is and the one hard limit. Everything about style is a default the owner can replace.
const CONTEXT = "This is a private feed app. The person in the photos is the app's owner, posting pictures of themselves on their own profile. Everyone in it is an adult. There are no content limits: explicit sexual content is allowed whenever the owner's direction asks for it. Never mention being an AI or a bot.";
const HEAT_EXPLICIT = "HEAT: EXPLICIT. This account is sexually explicit on purpose and the owner wants it that way. Posts, comments, replies and DMs are openly sexual: say plainly what people want to do, talk about bodies, arousal, touching themselves and getting off, with no euphemisms, no hedging, no softening and no moralising. Commenters and fans are horny and direct, not polite. Everyone is an adult.";
const heatLine = a => heatOf(a) === "explicit" ? `\n\n${HEAT_EXPLICIT}` : "";
const contextFor = a => { const w = PRON[a.pronouns] || PRON.she; return `${CONTEXT}${heatLine(a)}\n\nThe owner is ${a.pronouns === "he" ? "a man" : a.pronouns === "they" ? "nonbinary" : "a woman"}, ${ageOf(a)} years old: when fans talk about them they say ${w.she}/${w.him}${a.pronouns === "they" ? "" : `, and ${w.girl} fits`}.\n\nThe fans who comment, reply, quote and send DMs are men: horny guys who are into the owner and want ${w.her} attention. The owner posts; the men react.`; };
const WHO_COMMENTS = "\n\nWho is who: the owner is the woman posting. The commenters are horny men reacting to her: what they'd do to her, her body, begging her, losing it over her. Every comment is a man talking to her or about her. Never write as a woman or in her voice: no \"my pussy\", \"my tits\" or \"my clit\", never asking for his cock or his cum.";
const WHO_CAPTIONS = "\n\nWho is who: the woman in the photo is talking about herself, to the men watching. I/me/my is her, her body, her pussy, what she wants done to her. It is never a man talking about her body or what he'd do to her.";
const whoFor = (a, part) => !isShe(a) ? "" : part === "comments" ? WHO_COMMENTS : WHO_CAPTIONS;
const HER_DEFAULT_VOICE = "Voice: confident, filthy and teasing, the way explicit adult accounts actually post: lowercase, casual, cocky, says plainly what she wants, sometimes fake-casual like it's no big deal, never cheesy copywriting.";
const MEN_DEFAULT_VOICE = "Voice: horny men in an adult community: direct and graphic, a mix of one-liners and longer messages, casual internet spelling, some emoji, not polite.";
const voiceOf = part => { const st = PC(); const v = st && st[part === "comments" ? "comments" : "caption"] && st[part === "comments" ? "comments" : "caption"].voice; return v || (part === "comments" ? MEN_DEFAULT_VOICE : HER_DEFAULT_VOICE); };
function pickMode(modes, r){ const t = modes.reduce((s, m) => s + m.w, 0); let x = r() * t; for (const m of modes){ if ((x -= m.w) < 0) return m; } return modes[0]; }
// The mode for one piece of her writing: from the PC style when there is one, else a built-in mix (a third explicit).
function herMode(p, salt){
  const st = PC(), r = rng((p.seed ^ hashStr("mode" + salt + (p.textTry || 0))) >>> 0);
  if (st && st.caption && Array.isArray(st.caption.modes) && st.caption.modes.length) return pickMode(st.caption.modes, r);
  return r() < .35 ? { how: "openly explicit, dirty and short", explicit: true, ex: HER_EXPLICIT.slice(0, 6) } : { how: "teasing, fake-casual, saying little", explicit: false, ex: THIRST.slice(0, 6) };
}
function menModes(){
  const st = PC();
  if (st && st.comments && Array.isArray(st.comments.modes) && st.comments.modes.length) return st.comments.modes;
  return [{ how: "short hype, one to three words or just emoji", w: 2, explicit: false, ex: MEN_SOFT.slice(0, 4) }, { how: "what they'd do to her, spelled out", w: 3, explicit: true, ex: MEN_EXPLICIT.slice(0, 4) }, { how: "about her body, explicit", w: 2, explicit: true, ex: MEN_EXPLICIT.slice(10, 14) }, { how: "begging, asking her for more", w: 2, explicit: true, ex: MEN_EXPLICIT.slice(20, 24) }, { how: "funny or unhinged", w: 1, explicit: false, ex: MEN_SOFT.slice(10, 14) }];
}
const modeList = modes => modes.map(m => `- ${m.how}${m.explicit ? ", fully explicit with no softening" : ""}. Feel: ${[...(m.ex || [])].sort(() => Math.random() - .5).slice(0, 3).join(" / ")}`).join("\n");
// One batch of lines, asked for a few times until there are enough, each line checked for voice, age and repeats.
async function askLines(sys, prompt, want, part, a, max){
  const got = [], seen = new Set();
  for (let call = 0; call < 3 && got.length < want; call++){
    const out = await ask(sys, [{ type: "text", text: `${prompt}${got.length ? `\n\nAlready written (write different ones):\n${got.slice(-15).map(c => "- " + c).join("\n")}` : ""}\n\nWrite ${want - got.length} more, one per line, nothing else.` }], undefined, max || 700);
    const fresh = listLines(out).filter(x => { const k = normT(x); return k && x.length <= 240 && !/:$/.test(x) && !seen.has(k) && !wrongVoice(x, a, part); });
    if (!fresh.length) break;
    for (const x of fresh){ seen.add(normT(x)); got.push(x); }
  }
  return got;
}
// The style file on the owner's PC, served next to Ollama. A new version is picked up the next time the app opens and
// every post is written again, newest first. Kept in this app's own settings (Reel's copy is only read).
async function loadPcStyle(){
  const base = ollamaURL(); if (!base) return false;
  let j;
  try {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 6000);
    const r = await fetch(`${base}/reel/style.json`, { cache: "no-store", signal: ctl.signal }); clearTimeout(t);
    if (!r.ok) return false; j = await r.json();
  } catch(e){ return false; }
  if (!j || !j.ver || !j.pool || !j.caption || !j.comments) return false;
  if (S.settings.pcStyle && S.settings.pcStyle.ver === j.ver) return false;
  S.settings.pcStyle = j; await saveSettings();
  let n = 0;
  for (const p of S.posts) if (p.textWritten || p.commentsWritten){ p.textWritten = false; p.commentsWritten = false; p.textTry = (p.textTry || 0) + 1; p.comTry = (p.comTry || 0) + 1; await savePost(p); n++; }
  treeCache.clear();
  if (n) toast("New style from your PC. Rewriting every post, newest first.");
  return true;
}
const WRITERS = 3;
let writing = false;
function setWriter(msg){ S.writerMsg = msg; for (const el of document.querySelectorAll("[data-wstatus]")) el.textContent = msg; }
const needsWriting = p => !p.textWritten || !p.commentsWritten;
// Writes everything that's waiting, a few at a time, live and next-up posts first. The app's writeOne does one post.
async function writerRun(){
  if (writing || !ollamaURL() || !APP.writeOne) return;
  writing = true;
  try {
    const jobs = S.posts.filter(p => needsWriting(p) && acctSet(acctOf(p)).on);
    const when = p => Math.abs((p.publishAt || now() + 30*D) - now());
    jobs.sort((x, y) => when(x) - when(y));
    let next = 0, done = 0, failure = null;
    const worker = async () => {
      while (!failure && next < jobs.length){
        const p = jobs[next++];
        try { await APP.writeOne(p); } catch(e){ failure = failure || e; return; }
        done++; setWriter(`Writing ${done} of ${jobs.length}…`);
      }
    };
    if (jobs.length) setWriter(`Writing 0 of ${jobs.length}…`);
    await Promise.all(Array.from({ length: Math.min(WRITERS, jobs.length) }, worker));
    if (failure) throw failure;
    setWriter(jobs.length ? "Everything is written." : "");
    if (jobs.length) safeRender();
  } catch(e){
    const k = errKind(e);
    if (k === "conn") setWriter("Couldn't reach Ollama. Check that your PC is on and Tailscale is connected on this phone. It tries again next time you open the app.");
    else if (k === "model") setWriter(`Ollama doesn't have ${ollamaModel()} yet. On the PC, run: ollama pull ${ollamaModel()}`);
    else setWriter("Writing stopped: " + (e && e.message ? e.message.slice(0, 160) : "unknown error"));
  } finally { writing = false; }
}
function writerLine(){
  if (!ollamaURL()) return "Off: Reel has no Ollama address. Set it in Reel's Settings and it's used here too. The built-in lines fill in meanwhile.";
  if (S.writerMsg) return S.writerMsg;
  const n = S.posts.filter(needsWriting).length;
  return n ? `${n} ${n === 1 ? "post" : "posts"} waiting for the writer.` : `Everything is written with ${ollamaModel()}.`;
}
// What the text of a post reads as right now: what the writer wrote, else a built-in line picked by the post's seed.
function textOf(p){ if (hasText(p.text)) return p.text; return APP.fallbackText ? APP.fallbackText(p) : herLine(acctOf(p), rng(p.seed ^ 0x51ed27 ^ ((p.textTry || 0) * 977))); }

/* ================= the thread under a post ================= */
// Comments from fans, replies under them 2 to 4 deep, some from her (OP). The shape comes from the post's seed and never
// changes; the words come from what the writer wrote for the post when there is any, else from the built-in lines.
// The owner's own replies (and the fans' answers to them) are kept on the post and merged in.
const treeCache = new Map();
const TREE_TOP = () => APP.defaults.topComments || 14;
function commentTree(p){
  const a = acctOf(p);
  const key = [p.id, p.seed, (p.aiComments||[]).length, (p.aiReplies||[]).length, (p.aiOp||[]).length, p.comTry, S.settings.seed, (p.thread||[]).length, (p.hiddenC||[]).length, (PC() || {}).ver].join("|");
  if (treeCache.has(key)) return treeCache.get(key);
  const r = rng((p.seed ^ 0x9e3779b9 ^ ((p.comTry || 0) * 0x85ebca6b)) >>> 0);
  const { C, L } = totals(p);
  const n = clamp(Math.round(C * .6), 3, TREE_TOP());
  const reg = regularsOf(a), used = new Set();
  const fan = () => { let i = r() < .3 ? reg[Math.floor(r()*reg.length)] : Math.floor(r()*POOL); let g = 0; while (used.has(i) && g++ < POOL) i = (i+1)%POOL; used.add(i); return i; };
  const aiC = (p.aiComments || []).filter(t => !wrongVoice(t, a, "comments")), aiR = (p.aiReplies || []).filter(t => !wrongVoice(t, a, "comments")), aiO = (p.aiOp || []).filter(t => !wrongVoice(t, a, "caption"));
  let ci = 0, ri = 0, oi = 0;
  const cText = () => aiC.length && ci < aiC.length ? aiC[ci++] : (APP.bank && APP.bank.comment ? APP.bank.comment(a, r) : menLine(a, r));
  const rText = (toHer) => aiR.length && ri < aiR.length ? aiR[ri++] : toHer ? pick(MEN_TO_HER, r) : (APP.bank && APP.bank.reply ? APP.bank.reply(a, r) : (r() < .5 ? pick(MEN_BANTER, r) : menLine(a, r)));
  const oText = () => aiO.length && oi < aiO.length ? aiO[oi++] : (APP.bank && APP.bank.op ? APP.bank.op(a, r) : pick(OP_REPLIES, r));
  const maxDepth = 2 + Math.floor(r()*3);
  const score = (at, top) => Math.round(Math.pow(r(), top ? 2.2 : 3) * Math.max(4, L * (top ? .03 : .008)) * curve(Math.max(1, now() - at), 3*H)) + 1;
  const hidden = new Set(p.hiddenC || []);
  const build = (parent, depth, from, afterOp) => {
    const m = depth === 1 ? (r() < .5 ? 1 : r() < .8 ? 2 : 3) : (r() < .65 ? 1 : 2);
    for (let j = 0; j < m; j++){
      const at = from + (2 + r()*300) * MIN;
      const op = !afterOp && r() < (depth === 1 ? .22 : .14);
      const node = { id: parent.id + "." + j, acct: op ? -1 : fan(), op, text: op ? oText() : rText(afterOp), at, score: score(at, false), replies: [], depth };
      parent.replies.push(node);
      if (depth < maxDepth && r() < (op ? .65 : .32)) build(node, depth + 1, at, op);
    }
  };
  const out = [];
  for (let k = 0; k < n; k++){
    const off = k < 3 ? (30 + r()*600) * 1000 : -6*H*Math.log(1 - r()*.97) + r()*120e3;
    const at = p.publishAt + off;
    const c = { id: "c" + k, acct: fan(), text: cText(), at, score: score(at, true), replies: [], depth: 0 };
    if (r() < .55) build(c, 1, at, false);
    out.push(c);
  }
  // the owner's own replies, and the fans' answers to them
  const byId = new Map(); const walk = x => { byId.set(x.id, x); x.replies.forEach(walk); }; out.forEach(walk);
  for (const t of (p.thread || []).slice().sort((x, y) => x.at - y.at)){
    const node = { id: t.id, acct: t.mine ? -1 : t.acct, op: !!t.mine, mine: !!t.mine, text: t.text, at: t.at, score: Math.round(curve(now() - t.at, 2*H) * (3 + (hashStr(t.id) % 40))) + 1, replies: [], depth: 0 };
    const parent = t.parent && byId.get(t.parent);
    if (parent){ node.depth = parent.depth + 1; parent.replies.push(node); } else out.push(node);
    byId.set(node.id, node);
  }
  const prune = list => list.filter(x => x.at <= now() && !hidden.has(x.id)).map(x => ({ ...x, replies: prune(x.replies) }));
  const res = prune(out);
  if (treeCache.size > 60) treeCache.clear();
  treeCache.set(key, res); return res;
}
const countTree = list => list.reduce((n, c) => n + 1 + countTree(c.replies), 0);
// Everything in the thread at any depth, each with its parent, oldest first.
const flattenTree = (list, parent = null, out = []) => { for (const c of list){ out.push({ ...c, parent }); flattenTree(c.replies, c, out); } return out; };
// The owner answers something in the thread; a fan answers back a little later (written by Ollama when it's on).
async function ownerReply(p, parentId, text){
  const id = uid("m");
  p.thread = [...(p.thread || []), { id, parent: parentId || "", mine: true, text, at: now() }];
  const r = Math.random(), delay = r < .6 ? 20e3 + Math.random() * 3*MIN : r < .9 ? 3*MIN + Math.random() * 25*MIN : H + Math.random() * 3*H;
  const parentNode = parentId ? flattenTree(commentTree(p)).find(c => c.id === parentId) : null;
  const who = parentNode && parentNode.acct >= 0 ? parentNode.acct : regularsOf(acctOf(p))[Math.floor(Math.random() * 15)];
  p.pending = [...(p.pending || []), { id: uid("f"), parent: id, at: now() + delay, acct: who, to: text }];
  p.kept = true;
  treeCache.clear();
  await savePost(p);
}
let threadBusy = false;
async function threadTick(){
  if (threadBusy) return; threadBusy = true;
  try {
    for (const p of S.posts){
      if (!p.pending || !p.pending.length) continue;
      const due = p.pending.filter(x => x.at <= now()); if (!due.length) continue;
      const a = acctOf(p);
      for (const x of due){
        let text = "";
        if (ollamaURL() && APP.fanReplyPrompt){
          try {
            const [sys, prompt] = APP.fanReplyPrompt(p, acct(x.acct), x.to);
            const out = await ask(sys, [{ type: "text", text: prompt }], undefined, 120);
            text = listLines(out).filter(t => !wrongVoice(t, a, "comments"))[0] || "";
          } catch(e){ if (errKind(e) === "conn") break; }
        }
        if (!text) text = pick(MEN_TO_HER, rng(hashStr(x.id)));
        p.thread = [...(p.thread || []), { id: x.id, parent: x.parent, mine: false, acct: x.acct, text, at: x.at }];
        p.pending = p.pending.filter(y => y !== x);
      }
      treeCache.clear(); await savePost(p);
      if (route().name === APP.postRoute) safeRender();
    }
  } finally { threadBusy = false; }
}

/* ================= fan DMs ================= */
const dmCache = new Map();
// Fans message each account every day; the account answers some of them, and they answer back.
// A chat the owner has typed in is a saved conversation (S.misc.convos) and replaces the made-up lines for that fan.
function dmTemplate(a){
  const key = a.id + "|" + Math.floor(now() / 60e3) + "|" + S.posts.length;
  if (dmCache.has(key)) return dmCache.get(key);
  const T = new Map();
  const add = (i, m) => { if (m.at > now()) return; if (!T.has(i)) T.set(i, { i, msgs: [] }); T.get(i).msgs.push(m); };
  const perDay = clamp(Math.round((2 + followersNow(a) / 1500) * (LEVEL[a.level] || 1)), 2, 20);
  const posted = live(a.id);
  const start = now() - 14*D;
  for (let d = Math.floor(start / D); d <= Math.floor(now() / D); d++){
    const r = rng(hashStr("dm" + a.seed + "|" + d + "|" + APP.id));
    const n = Math.round(perDay * (.6 + r() * .8));
    for (let k = 0; k < n; k++){
      const t = d * D + r() * D; const i = Math.floor(r() * POOL);
      const recent = posted.filter(x => x.publishAt <= t && t - x.publishAt < 7*D);
      if (recent.length && r() < .4) add(i, { me:false, text: pick(DM_POST, r), at: t, post: recent[Math.floor(r() * Math.min(3, recent.length))].id });
      else add(i, { me:false, text: genderize(pick(DM_OPEN, r), a.pronouns), at: t });
      if (r() < .35) add(i, { me:false, text: pick(DM_FOLLOW, r), at: t + (1 + r() * 40) * 60e3 });
      if (r() < .3){
        const t2 = t + (10 + r() * 170) * 60e3; add(i, { me:true, text: pick(DM_OWNER, r), at: t2 });
        if (r() < .6) add(i, { me:false, text: pick(DM_BACK, r), at: t2 + (2 + r() * 25) * 60e3 });
      }
    }
  }
  for (const t of T.values()) t.msgs.sort((x, y) => x.at - y.at);
  if (dmCache.size > 30) dmCache.clear(); dmCache.set(key, T);
  return T;
}
function dmThreads(a){
  const T = new Map(dmTemplate(a));
  for (const [i, c] of Object.entries(S.misc.convos[a.id] || {})){ const msgs = c.msgs.filter(m => m.at <= now()); if (msgs.length) T.set(+i, { i: +i, msgs }); }
  return [...T.values()].map(t => ({ ...t, last: t.msgs[t.msgs.length - 1] })).sort((x, y) => y.last.at - x.last.at);
}
const dmReadAt = (a, i) => { const m = (S.misc.dmRead[a.id] ||= { __base: now() - 6*H }); return m[i] || m.__base || 0; };
const dmUnread = (a, t) => !t.last.me && t.last.at > dmReadAt(a, t.i);
const dmUnreadCount = a => dmThreads(a).filter(t => dmUnread(a, t)).length;
const convoOf = (a, i) => (S.misc.convos[a.id] || {})[i];
function startConvo(a, i){
  const box = (S.misc.convos[a.id] ||= {});
  if (box[i]) return box[i];
  const t = dmTemplate(a).get(i);
  return box[i] = { msgs: t ? t.msgs.map(m => ({ ...m })) : [], next: null, started: now() };
}
// Mostly quick when someone's chatting, sometimes they take a while, now and then they go quiet for hours.
function replyDelay(){ const r = Math.random(); return r < .75 ? 15e3 + Math.random() * 165e3 : r < .95 ? 3*MIN + Math.random() * 20*MIN : H + Math.random() * 4*H; }
async function ownerSend(a, i, text){
  const c = startConvo(a, i);
  c.msgs.push({ me: true, text, at: now() });
  const d = replyDelay(); c.next = { at: now() + d, seenAt: now() + Math.min(d * .5, 10e3 + Math.random() * 80e3) };
  await saveMisc(); dmTick();
}
const DM_FAN_RULES = "He has a crush on the owner: flirty, eager, horny. Casual internet spelling, short texts like real DMs, react to what the owner just said.";
async function writeFanTurn(a, i, c){
  const f = acct(i);
  const recent = c.msgs.slice(-20).map(m => `@${m.me ? handleOf(a) : f.handle}: ${m.text}`).join("\n");
  const sys = `${contextFor(a)}\n\nThis is a DM chat on ${APP.name} between @${handleOf(a)}, the owner's account, and @${f.handle}, a fan. Write the next message or messages from @${f.handle}: 1 to 2 short texts, the way people really text. Answer what was just said, keep it going, and never repeat an earlier line.\n\nWHO @${f.handle} IS\n${fanPersona(f)}\n\nHOW FANS TEXT\n${DM_FAN_RULES}${WHO_COMMENTS}`;
  const out = await ask(sys, [{ type: "text", text: `The chat so far, oldest first:\n${recent}\n\nWrite @${f.handle}'s next message(s), one per line, nothing else.` }], undefined, 120);
  return listLines(out).map(t => t.replace(/^\s*@[\w.]+\s*:\s*/, "")).filter(t => t && !wrongVoice(t, a, "comments")).slice(0, 2);
}
let dmBusy = false;
// A reply shows up when it's due; it is written a little early so "typing…" is honest. With the PC off, a built-in line.
async function dmTick(){
  if (dmBusy) return; dmBusy = true; let changed = false;
  try {
    for (const a of LIB.accounts) for (const [k, c] of Object.entries(S.misc.convos[a.id] || {})){
      const n = c.next; if (!n) continue;
      if (!n.ready){
        if (now() < n.at - 25e3) continue;
        let lines = [];
        if (ollamaURL()){ try { lines = await writeFanTurn(a, +k, c); S.dmErr = ""; } catch(e){ const kind = errKind(e); S.dmErr = kind === "conn" ? "Waiting for your PC. Replies come in once Ollama can be reached." : kind === "model" ? `Ollama doesn't have ${ollamaModel()} yet.` : ""; if (kind === "conn" && now() < n.at + 2*MIN) continue; } }
        if (!lines.length) lines = [pick(DM_BACK, rng(hashStr(a.id + k + n.at)))];
        n.ready = lines; changed = true;
      }
      if (now() < n.at) continue;
      let t = n.at;
      n.ready.forEach((text, j) => { if (j) t += 3e3 + text.length * 250 + Math.random() * 6e3; c.msgs.push({ me: false, text, at: t }); });
      c.next = null; changed = true;
    }
  } finally {
    dmBusy = false;
    if (changed){ await saveMisc(); APP.dmRepaint ? APP.dmRepaint() : safeRender(); }
  }
}

/* ================= the bot ================= */
const isLive = p => !!p.publishAt && p.publishAt <= now();
const postsOf = aid => S.posts.filter(p => p.acct === aid);
const live = aid => postsOf(aid).filter(isLive).sort((a, b) => b.publishAt - a.publishAt);
const queued = aid => postsOf(aid).filter(p => p.publishAt && p.publishAt > now()).sort((a, b) => a.publishAt - b.publishAt);
const allLive = () => S.posts.filter(isLive).sort((a, b) => b.publishAt - a.publishAt);
const postersOn = () => LIB.accounts.filter(a => acctSet(a).on && photosOf(a.id).length);
// Posts go up between 9 AM and midnight only; a time that lands in the night moves to the morning.
function humanize(t){
  const d = new Date(t);
  if (d.getHours() < 9){ d.setHours(9, 0, 0, 0); return d.getTime() + Math.floor(rng(hashStr("q"+t))()*150)*MIN; }
  return t;
}
const inWindow = t => new Date(t).getHours() >= 9;
function nextSlot(a, from){
  const step = D / Math.max(.2, acctSet(a).perDay) * 15 / 24;
  // Bursty like a real person: sometimes two or three posts close together, sometimes a long quiet stretch; same average.
  const r = rng(hashStr("j" + from + a.seed + APP.id)), x = r();
  const gap = step * (x < .25 ? .05 + r() * .2 : x < .75 ? .6 + r() * .8 : 1.5 + r() * 1.1);
  return humanize(Math.max(now() + 5*MIN, from + gap));
}
const countsOf = a => (S.misc.postedCount[a.id] ||= {});
// Photos never posted here go first (in a random order), then reposts, the least posted first, mixed into new combos
// (a different first photo, different neighbours). Nothing already waiting in the queue is picked again.
function pickFiles(a, r, n){
  const photos = photosOf(a.id); if (!photos.length) return [];
  const cnt = countsOf(a), inQueue = new Set(queued(a.id).flatMap(p => p.files.map(f => f.key)));
  const ranked = photos.map(f => ({ f, c: cnt[f.key] || 0, q: inQueue.has(f.key) ? 1 : 0, r: r() })).sort((x, y) => x.q - y.q || x.c - y.c || x.r - y.r);
  const first = ranked[0];
  const tier = ranked.filter(x => x.q === first.q && x.c === first.c);
  const rest = ranked.filter(x => !tier.includes(x));
  const out = [...shuffleInPlace(tier.slice()), ...rest].slice(0, clamp(n, 1, photos.length)).map(x => x.f);
  return out;
}
function makePost(a, files, at, r, kind){
  const cnt = countsOf(a);
  const p = { id: uid("p_"), acct: a.id, kind: kind || "photo", files, publishAt: at, seed: hashStr(uid("s") + at), createdAt: now(), text: "", textWritten: false, commentsWritten: false, thread: [], hiddenC: [], cVotes: {}, cycled: files.length && files.every(f => cnt[f.key]) ? 1 : 0 };
  for (const f of files) cnt[f.key] = (cnt[f.key] || 0) + 1;
  if (APP.decorate) APP.decorate(p, a, r);
  return p;
}
// How many photos one post gets: mostly one, sometimes a small set.
function pickCount(r){ const x = r(); const m = APP.defaults.maxFiles || 4; return x < .7 ? 1 : x < .88 ? 2 : x < .96 ? Math.min(3, m) : Math.min(4, m); }
// The first time an account posts here, about three days of posts are already up, so the feed isn't empty.
async function backfill(a){
  if (postsOf(a.id).length || S.misc.backfilled && S.misc.backfilled[a.id]) return;
  const per = acctSet(a).perDay, photos = photosOf(a.id).length;
  const n = clamp(Math.round(per * 3), 3, Math.max(4, photos * 2));
  const r = rng(hashStr("bf" + a.id + now()));
  let t = now() - (.3 + r() * 2) * H;
  const times = [];
  for (let k = 0; k < n; k++){ times.push(humanize(t)); t -= (D / per) * (.4 + r() * 1.4) * 15 / 24 * (24 / 15); }
  for (const at of times.sort((x, y) => x - y)){
    const kind = APP.kindFor ? APP.kindFor(a, r) : "photo";
    const files = kind === "text" ? [] : pickFiles(a, r, pickCount(r));
    if (kind !== "text" && !files.length) break;
    await savePost(makePost(a, files, Math.min(at, now() - 60e3), r, kind));
  }
  (S.misc.backfilled ||= {})[a.id] = now();
  await saveMisc();
}
// Keeps about two days of posts queued per account.
async function fillQueue(a){
  let Q = queued(a.id);
  let last = Q.length ? Q[Q.length - 1].publishAt : (live(a.id)[0] && live(a.id)[0].publishAt) || now() - H;
  let guard = 0;
  while (last < now() + 2*D && guard++ < 80){
    last = nextSlot(a, last);
    const r = rng(hashStr("pk" + last + a.id));
    const kind = APP.kindFor ? APP.kindFor(a, r) : "photo";
    const files = kind === "text" ? [] : pickFiles(a, r, pickCount(r));
    if (kind !== "text" && !files.length) break;
    await savePost(makePost(a, files, last, r, kind));
  }
  await saveMisc();
}
// Posts the owner voted on, liked, saved, replied to or opened stay up for good. Everything else comes down after a
// random while and its photos go back into the mix: some within hours, most after a day or three, some stay most of a week.
const CYCLE_KEEP_MIN = 6, CYCLE_KEEP_MAX = 40;
function lifeOf(p){
  const r = rng(hashStr("life" + p.id)), x = r();
  return x < .15 ? (.5 + r() * 7.5) * H : x < .6 ? (12 + r() * 60) * H : (3 + r() * 5) * D;
}
const keeps = p => !!(p.vote || p.liked || p.saved || p.kept || p.pinned || (p.thread || []).some(t => t.mine) || (APP.keeps && APP.keeps(p)));
async function cyclePosts(force = {}){
  for (const a of LIB.accounts){
    const L = live(a.id);
    let up = L.length, forced = 0;
    for (const p of L.slice().reverse()){
      if (up <= CYCLE_KEEP_MIN) break;
      if (keeps(p)) continue;
      const over = L.filter(x => !keeps(x)).length - (L.length - up) > CYCLE_KEEP_MAX;
      if (!over && now() - p.publishAt < lifeOf(p)){ if (forced >= (force[a.id] || 0)) continue; forced++; }
      await delPost(p); up--;
    }
  }
}
// Posts of accounts that no longer post here, or whose photos Reel no longer has, come down.
async function pruneGone(){
  for (const p of S.posts.slice()){
    const a = accountById(p.acct);
    if (!a || !acctSet(a).on){ await delPost(p); continue; }
    if (p.files.length && p.files.some(f => !LIB.mediaKeys.has(f.key))) await delPost(p);
  }
}
async function botRun(){
  await pruneGone();
  for (const a of postersOn()) await backfill(a);
  await cyclePosts();
  for (const a of postersOn()) await fillQueue(a);
  if (APP.afterBot) await APP.afterBot();
}
// Refreshing changes the feed like it would on a real app: a few of the next queued posts go up now, and as many
// older posts you haven't kept come down (their photos return later in new combos).
let lastAdvance = 0;
async function refreshAdvance(){
  if (Date.now() - lastAdvance < 20e3) return 0;
  lastAdvance = Date.now();
  const force = {}; let n = 0;
  for (const a of postersOn()){
    const next = queued(a.id).sort((x, y) => (x.cycled ? 1 : 0) - (y.cycled ? 1 : 0) || x.publishAt - y.publishAt);
    for (const p of next.slice(0, 1 + Math.floor(Math.random() * 3))){
      p.publishAt = now() - Math.floor(Math.random() * 20) * 60e3 - 30e3; await savePost(p);
      force[a.id] = (force[a.id] || 0) + 1; n++;
    }
  }
  await cyclePosts(force);
  return n;
}
// Coming back to the app after a couple of minutes away changes the feed by itself, the same as a refresh.
const markLeft = () => { try { localStorage.setItem(APP.id + "-left-at", String(now())); } catch(e){} };
async function comeBack(){
  let left = 0; try { left = +localStorage.getItem(APP.id + "-left-at") || 0; localStorage.removeItem(APP.id + "-left-at"); } catch(e){}
  if (!left || now() - left < 2*MIN) return;
  await loadLibrary();
  if (!LIB.ok){ renderEmpty(); return; }
  if (!(await refreshAdvance())) return;
  await botRun();
  APP.feedReset && APP.feedReset();
  if (route().name === "home"){ window.scrollTo(0, 0); safeRender(); }
}

/* ================= router, rendering, gestures ================= */
function go(h){ if (location.hash === h) render(); else location.hash = h; }
function route(){ const h = location.hash.replace(/^#\/?/, ""); const [name, a, b, c] = h.split("/").map(x => { try { return decodeURIComponent(x); } catch(e){ return x; } }); return { name: name || "home", a, b, c }; }
const scrollMem = {}; let curHash = location.hash, navN = (history.state && history.state.n) || 0;
if (!history.state || typeof history.state.n !== "number") history.replaceState({ n: navN }, "");
window.addEventListener("scroll", () => { scrollMem[curHash] = window.scrollY; }, { passive:true });
window.addEventListener("hashchange", () => {
  const st = history.state; let back = false;
  if (st && typeof st.n === "number"){ back = st.n < navN; navN = st.n; } else { navN++; history.replaceState({ n: navN }, ""); }
  curHash = location.hash;
  if (!back && APP.feedReset) APP.feedReset();
  render();
  if (back && scrollMem[curHash]){ const y = scrollMem[curHash]; window.scrollTo(0, y); setTimeout(() => window.scrollTo(0, y), 60); }
  else window.scrollTo(0, 0);
});
function setTop(html){ $("#top").innerHTML = html; }
const I_BACK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5 8 12l7 7"/></svg>';
const backBtn = `<button class="iconbtn" type="button" data-back aria-label="Back">${I_BACK}</button>`;
let lastInteract = 0, renderLater = 0;
for (const ev of ["scroll","touchstart","touchmove","wheel"]) window.addEventListener(ev, () => { lastInteract = Date.now(); }, { passive:true });
function safeRender(){
  const wait = 3000 - (Date.now() - lastInteract);
  if (wait > 0){ clearTimeout(renderLater); renderLater = setTimeout(safeRender, wait + 50); return; }
  if (!LIB.ok) return;
  if (!$("#layer").innerHTML && !["INPUT","TEXTAREA"].includes(document.activeElement?.tagName)) render();
}
function render(){
  if (!LIB.ok){ renderEmpty(); return; }
  const r = route();
  APP.renderTabs && APP.renderTabs(r);
  const v = $("#view");
  (APP.views[r.name] || APP.views.home)(v, r);
  Promise.all([hydrate(v), hydrate($("#top")), hydrate(document.querySelector(".tabbar"))]);
}
// Reel hasn't fetched anything yet (no accounts, or no photos): nothing to post from.
function renderEmpty(){
  document.querySelector(".tabbar").hidden = true;
  setTop(`<h1 class="logo">${esc(APP.name)}</h1>`);
  $("#view").innerHTML = `<div class="empty"><div class="emptymark">${APP.mark || ""}</div><h2>Open Reel first</h2><p>${esc(APP.name)} posts the photos Reel fetched from your Drive folders, for the same accounts. Open Reel first so it can fetch your photos, then come back here.</p><p class="hint">On iPhone, an app added to the Home Screen can't see another one's photos. Open ${esc(APP.name)} from inside Reel instead: Reel → Settings → Open ${esc(APP.name)}.</p><a class="btn primary" href="../">Open Reel</a><button class="btn" type="button" data-recheck>Check again</button></div>`;
}
// Pull the feed down from the top (or tap Home) and it reloads with whatever is new, like Instagram.
let refreshing = false, pull = null;
async function refreshFeed(){
  if (refreshing || !LIB.ok) return; refreshing = true;
  const ptr = $("#ptr"); ptr.classList.add("spin"); ptr.style.transition = "opacity .15s, transform .15s"; ptr.style.opacity = "1"; ptr.style.transform = "scale(1)";
  window.scrollTo({ top: 0, behavior: "smooth" });
  const started = Date.now();
  try { await loadLibrary(); await refreshAdvance(); await botRun(); APP.feedReset && APP.feedReset(); await new Promise(r => setTimeout(r, Math.max(0, 600 - (Date.now() - started)))); render(); writerRun(); }
  finally { refreshing = false; ptr.style.opacity = "0"; ptr.style.transform = "scale(.6)"; setTimeout(() => { if (!refreshing) ptr.classList.remove("spin"); }, 200); }
}
document.addEventListener("touchstart", e => {
  pull = (e.touches.length === 1 && (APP.pullRoutes || ["home"]).includes(route().name) && window.scrollY <= 0 && !refreshing && !$("#layer").innerHTML) ? { y: e.touches[0].clientY, d: 0 } : null;
}, { passive:true });
document.addEventListener("touchmove", e => {
  if (!pull) return;
  pull.d = e.touches[0].clientY - pull.y;
  if (pull.d < 0 || window.scrollY > 0){ pull.d = 0; }
  const k = Math.min(1, pull.d / 90), ptr = $("#ptr");
  ptr.style.transition = "none"; ptr.style.opacity = String(k); ptr.style.transform = `translateY(${k * 24}px) scale(${.6 + k * .4}) rotate(${k * 270}deg)`;
}, { passive:true });
document.addEventListener("touchend", () => {
  const p = pull; pull = null; if (!p) return;
  if (p.d >= 90) refreshFeed();
  else { const ptr = $("#ptr"); ptr.style.transition = "opacity .15s, transform .15s"; ptr.style.opacity = "0"; ptr.style.transform = "scale(.6)"; }
}, { passive:true });
// Swipe sideways on any page you opened (a post, a profile, a chat) to go back.
let swipe = null;
document.addEventListener("touchstart", e => {
  if (e.touches.length !== 1){ swipe = null; return; }
  const t = e.touches[0];
  swipe = { x:t.clientX, y:t.clientY, at:Date.now(), inner: !!e.target.closest(".slides, input, textarea, .seg, .gallery") };
}, { passive:true });
document.addEventListener("touchend", e => {
  const s = swipe; swipe = null; if (!s) return;
  const t = e.changedTouches[0], dx = t.clientX - s.x, dy = t.clientY - s.y;
  if (Math.abs(dx) < 70 || Math.abs(dy) > Math.abs(dx) * .6 || Date.now() - s.at > 800) return;
  if (s.inner && s.x > 30) return;
  if ($("#layer").innerHTML) return;
  if ((APP.roots || ["home"]).includes(route().name)) return;
  const vw = $("#view"); vw.style.transition = "transform .18s ease-out, opacity .18s"; vw.style.transform = `translateX(${dx > 0 ? 40 : -40}%)`; vw.style.opacity = "0";
  setTimeout(() => { vw.style.transition = ""; vw.style.transform = ""; vw.style.opacity = ""; if (history.length > 1) history.back(); else go("#/"); }, 170);
}, { passive:true });
for (const ev of ["gesturestart","gesturechange","gestureend"]) document.addEventListener(ev, e => e.preventDefault(), { passive:false });

/* ================= sheets ================= */
function sheet(html, onClick){
  $("#layer").innerHTML = `<div class="scrim" id="scrim"><div class="sheet pad" role="dialog"><div class="grab"></div>${html}</div></div>`;
  $("#scrim").addEventListener("click", e => { if (e.target.id === "scrim") return closeSheet(); onClick && onClick(e.target); });
  hydrate($("#layer"));
}
function closeSheet(){ $("#layer").innerHTML = ""; }
function accountSwitcher(onPick){
  sheet(`<h3>Accounts</h3>${LIB.accounts.map(a => `<button type="button" class="arow" data-acc="${esc(a.id)}">${myAv(44, a)}<div class="who"><b>${esc(APP.handleStyle ? APP.handleStyle(a) : handleOf(a))}</b><div class="hint">${fmt(followersNow(a))} ${APP.followersWord || "followers"} · ${live(a.id).length} posts · ${photosOf(a.id).length} photos in Reel${acctSet(a).on ? "" : " · not posting here"}</div></div>${a.id === A().id ? `<span class="check">✓</span>` : ""}</button>`).join("")}`, async el => {
    const b = el.closest("[data-acc]"); if (!b) return;
    closeSheet(); await switchTo(b.dataset.acc); onPick ? onPick() : render(); window.scrollTo(0, 0);
  });
}
// Photos shown blurred until tapped; what was revealed stays revealed while the app is open.
const revealed = new Set();
const blurOn = () => S.settings.blur !== false;

/* ================= shared clicks ================= */
document.addEventListener("click", async e => {
  const t = e.target.closest("button,[data-href]"); if (!t || t.closest("#scrim")) return;
  const d = t.dataset;
  if (d.href !== undefined){ e.preventDefault(); go(d.href); return; }
  if ("back" in d){ if (history.length > 1) history.back(); else go("#/"); return; }
  if ("recheck" in d){ t.textContent = "Checking…"; await loadLibrary(); if (LIB.ok){ await afterLibrary(); render(); } else { t.textContent = "Still nothing. Open Reel first."; } return; }
  if (d.reveal !== undefined){ e.preventDefault(); revealed.add(d.reveal); const box = t.closest(".nsfw"); if (box){ box.classList.remove("nsfw"); const o = box.querySelector(".nsfwcover"); if (o) o.remove(); } return; }
  if ("switch" in d){ accountSwitcher(d.switchto ? () => go(d.switchto) : null); return; }
  if (d.accgo !== undefined){ await switchTo(d.accgo); render(); window.scrollTo(0, 0); return; }
  if (d.dmsend !== undefined){ const inp = $("#dmin"); const text = inp && inp.value.trim(); if (!text) return; const a = accountById(d.acct) || A(); inp.value = ""; await ownerSend(a, +d.dmsend, text); APP.dmRepaint ? APP.dmRepaint() : render(); window.scrollTo(0, document.body.scrollHeight); return; }
  if (d.postnow !== undefined){ const p = S.posts.find(x => x.id === d.postnow); if (p){ p.publishAt = now(); await savePost(p); toast("Posted"); writerRun(); render(); } return; }
  if (d.perday !== undefined){ const a = accountById(d.acct) || A(); await setAcct(a, { perDay: +d.perday }); for (const p of queued(a.id)) await delPost(p); await fillQueue(a); toast(`${APP.handleStyle ? APP.handleStyle(a) : handleOf(a)} posts about ${d.perday} a day`); render(); return; }
  if (d.acton !== undefined){ const a = accountById(d.acton); const on = !acctSet(a).on; await setAcct(a, { on }); await botRun(); toast(on ? `${handleOf(a)} posts here now` : `${handleOf(a)} doesn't post here`); render(); writerRun(); return; }
  if ("blur" in d){ S.settings.blur = !blurOn(); await saveSettings(); render(); return; }
  if ("newworld" in d){ S.settings.seed = Math.floor(Math.random()*1e9); acctCache.clear(); usedHandles.clear(); pfpCache.clear(); pfpPerm = null; treeCache.clear(); dmCache.clear(); S.misc.follows = {}; await saveSettings(); await saveMisc(); toast("New set of fans"); render(); return; }
  if ("rewrite" in d){ if (!ollamaURL()){ toast("Reel has no Ollama address yet"); return; } for (const p of S.posts){ p.textWritten = false; p.commentsWritten = false; p.textTry = (p.textTry || 0) + 1; p.comTry = (p.comTry || 0) + 1; await savePost(p); } treeCache.clear(); toast("Rewriting. Newest and next-up posts go first."); writerRun(); return; }
  if ("reset" in d){
    if (d.armed !== "1"){ d.armed = "1"; t.textContent = `Tap again: this erases everything ${APP.name} made on this phone`; return; }
    await DB.clear("posts"); await DB.clear("media"); await DB.clear("kv"); try { localStorage.removeItem(APP.id + "-dims"); } catch(_){}
    location.replace(location.pathname); return;
  }
  if (APP.onClick) await APP.onClick(t, d, e);
});
document.addEventListener("keydown", e => { if (e.key === "Enter" && e.target.id === "dmin"){ document.querySelector("[data-dmsend]")?.click(); } if (e.key === "Enter" && e.target.id === "cin"){ document.querySelector("[data-addc]")?.click(); } if (e.key === "Escape") closeSheet(); });

/* ================= boot ================= */
async function afterLibrary(){
  document.querySelector(".tabbar").hidden = false;
  if (!accountById(S.current)){ S.current = accountById(LIB.current) ? LIB.current : LIB.accounts[0].id; await saveCurrent(); }
  if (APP.onBoot) await APP.onBoot();
  await botRun();
}
async function boot(){
  await DB.open();
  S.settings = { seed: 0, blur: true, acct: {}, ...(await DB.get("kv","settings") || {}) };
  S.misc = { convos: {}, dmRead: {}, seenAt: {}, postSeen: {}, postedCount: {}, follows: {}, ...(await DB.get("kv","misc") || {}) };
  S.posts = await DB.all("posts");
  S.current = (await DB.get("kv","current")) || "";
  await loadLibrary();
  if (!S.settings.seed){ S.settings.seed = LIB.settings.seed || Math.floor(Math.random()*1e9); await saveSettings(); }
  if (navigator.storage?.persist) navigator.storage.persist().catch(()=>{});
  loadPfps();
  if (LIB.ok) await afterLibrary();
  render();
  setTimeout(async () => { if (LIB.ok){ await loadPcStyle(); writerRun(); } }, 400);
  setInterval(writerRun, 4*MIN);
  setInterval(async () => { if (LIB.ok){ await botRun(); if ((APP.liveRoutes || ["home"]).includes(route().name)) safeRender(); } }, 60e3);
  setInterval(() => { if (LIB.ok){ dmTick(); threadTick(); } }, 20e3);
  dmTick(); threadTick();
  document.addEventListener("visibilitychange", async () => {
    if (document.visibilityState === "hidden"){ markLeft(); return; }
    if (!LIB.ok){ await loadLibrary(); if (LIB.ok){ await afterLibrary(); render(); } return; }
    comeBack(); dmTick();
  });
  window.addEventListener("pagehide", markLeft);
  comeBack();
  if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js", { updateViaCache: "none" }).then(reg => document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") reg.update().catch(()=>{}); })).catch(()=>{});
}
