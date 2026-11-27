// Time to first moving frame for every place a video starts, on a copy of the real library.
//   node tools/video-start-measure.mjs --data <copied data dir> [--site <docs>] [--net lan|relay|slow] [--ios] [--json out.json]
// --data must be a COPY (reel.db made with VACUUM INTO plus a copied derived/): the engine runs its ticks on it.
// --net throttles every request through CDP (lan = 60 Mbps / 8 ms, relay = 4 Mbps / 100 ms like a Tailscale DERP relay,
// slow = 1.5 Mbps / 150 ms). --ios models iPhone Safari: preload="auto" is treated as "metadata" and the media cache is
// off, so a video that is not playing holds only its header. Chromium is not iPhone: the numbers rank the paths, they
// are not the phone's exact times.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const args = process.argv.slice(2);
const argOf = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const dataDir = argOf('--data');
if (!dataDir || !fs.existsSync(path.join(dataDir, 'reel.db'))) throw new Error('--data <copied data dir with reel.db> is required');
if (path.resolve(dataDir).toLowerCase() === 'c:\\users\\perry\\reellibrary') throw new Error('--data must be a copy, never the live library');
const siteDir = path.resolve(argOf('--site') || path.join(root, 'docs'));
const net = argOf('--net') || 'lan';
const ios = args.includes('--ios');
const NETS = { lan: [60e6, 8], relay: [4e6, 100], slow: [1.5e6, 150] };
if (!NETS[net]) throw new Error(`--net ${net}?`);

const kit = process.env.PLAYWRIGHT_DIR || 'C:/Users/Perry/hyperframes-student-kit/node_modules/playwright';
const { chromium } = await import(pathToFileURL(path.join(kit, 'index.mjs')).href);
const chromeExe = process.env.CHROME_EXE || path.join(process.env.LOCALAPPDATA || '', 'ms-playwright', 'chromium-1208', 'chrome-win64', 'chrome.exe');
const { startEngine } = await import(pathToFileURL(path.join(root, 'server', 'main.js')).href);

const env = {};
for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('REEL_')) env[k] = v;
Object.assign(env, {
  REEL_DATA: path.resolve(dataDir), REEL_PORT: '0', REEL_SITE: siteDir,
  REEL_RCLONE: JSON.stringify(['reel-measure-no-such-rclone']), REEL_OLLAMA: 'http://127.0.0.1:9',
  REEL_STYLE: path.join(dataDir, 'no-style.json'),
});
const engine = await startEngine(env);
const base = `http://127.0.0.1:${engine.server.address().port}/reel/`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ executablePath: chromeExe, headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
await ctx.addInitScript(({ ios }) => {
  // every video: when it is asked to play (data-want -> 1) and when its picture first moves after that
  window.__ev = [];
  const st = new WeakMap();
  let seq = 0;
  const ahead = (v) => { const b = v.buffered; for (let i = 0; i < b.length; i++) if (b.start(i) <= v.currentTime + 0.05 && b.end(i) > v.currentTime) return b.end(i) - v.currentTime; return 0; };
  const arm = (v) => {
    if (v.__arm) return; v.__arm = 1;
    const cb = (now, meta) => {
      const s = st.get(v);
      if (s && !s.done && !v.paused && meta.mediaTime > s.mt0 + 0.02) {
        s.done = true;
        window.__ev.push({ id: s.id, src: s.src, wantAt: s.wantAt, moveAt: performance.now(), ms: Math.round(performance.now() - s.wantAt), ahead: s.ahead, rs: s.rs, full: !!v.closest('#full'), opening: s.opening });
      }
      v.requestVideoFrameCallback(cb);
    };
    v.requestVideoFrameCallback(cb);
  };
  // an opening stand-in (video.ov) laid over a video: its first moving frame counts for the video it stands in for
  const armOv = (o) => {
    if (o.__arm) return; o.__arm = 1;
    const cb = (now, meta) => {
      const s = o._of && st.get(o._of);
      if (s && !s.done && !o.paused && o.classList.contains('on') && meta.mediaTime > (s.omt0 ?? 0) + 0.02) {
        s.done = true;
        window.__ev.push({ id: s.id, src: s.src, wantAt: s.wantAt, moveAt: performance.now(), ms: Math.round(performance.now() - s.wantAt), ahead: s.ahead, rs: s.rs, full: !!o.closest('#full'), opening: true });
      }
      if (o.isConnected) o.requestVideoFrameCallback(cb);
    };
    o.requestVideoFrameCallback(cb);
  };
  new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes) if (n instanceof HTMLVideoElement && n.classList.contains('ov')) armOv(n); })
    .observe(document, { subtree: true, childList: true });
  new MutationObserver((ms) => {
    for (const m of ms) {
      const v = m.target;
      if (!(v instanceof HTMLVideoElement)) continue;
      arm(v);
      const want = v.dataset.want === '1';
      const s = st.get(v);
      if (want && m.oldValue !== '1') st.set(v, { id: ++seq, wantAt: performance.now(), mt0: v.currentTime, omt0: v._ov ? v._ov.currentTime : 0, ahead: Math.round(ahead(v) * 10) / 10, rs: v.readyState, src: v.dataset.item || v.currentSrc || v.getAttribute('src') || v.dataset.vsrc || '', opening: !!v.dataset.open, done: false });
      else if (!want && m.oldValue === '1' && s && !s.done) { s.done = true; window.__ev.push({ id: s.id, src: s.src, wantAt: s.wantAt, gaveUp: Math.round(performance.now() - s.wantAt), ahead: s.ahead, rs: s.rs, full: !!v.closest('#full') }); }
    }
  }).observe(document, { subtree: true, attributes: true, attributeFilter: ['data-want'], attributeOldValue: true });
  if (ios) {
    // iPhone Safari does not buffer a video that is not playing, whatever preload says
    const d = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'preload');
    Object.defineProperty(HTMLMediaElement.prototype, 'preload', { get() { return d.get.call(this); }, set(x) { d.set.call(this, x === 'auto' ? 'metadata' : x); }, configurable: true });
  }
}, { ios });
const page = await ctx.newPage();
const cdp = await ctx.newCDPSession(page);
await cdp.send('Network.enable');
const [bps, rtt] = NETS[net];
await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: rtt, downloadThroughput: bps / 8, uploadThroughput: 2e6 / 8 });
if (ios) await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
let mediaBytes = 0;
cdp.on('Network.dataReceived', (e) => { mediaBytes += e.dataLength; });

const rows = []; // {path, ms|null, warm, note}
const evs = () => page.evaluate(() => window.__ev.slice());
const waitEv = async (pred, ms = 15000) => { const end = Date.now() + ms; for (;;) { const e = (await evs()).find(pred); if (e) return e; if (Date.now() > end) return null; await sleep(50); } };
const nowIn = () => page.evaluate(() => performance.now());
const warmOf = (e) => (e.opening ? 'opening' : e.ahead >= 1 ? 'warm' : 'cold');
const add = (p, e, extra = {}) => { const r = { path: p, ms: e ? (e.ms ?? null) : null, warm: e ? warmOf(e) : '?', ahead: e ? e.ahead : null, ...extra }; rows.push(r); console.log(`${p.padEnd(28)} ${r.ms == null ? 'never' : String(r.ms).padStart(6) + ' ms'} ${r.warm} ahead=${r.ahead}${extra.note ? ' ' + extra.note : ''}`); };

// scroll the page so `target` (a video) is centred, at `pxs` pixels a second
async function scrollToVid(sel, idx, pxs) {
  for (;;) {
    const d = await page.evaluate(({ sel, idx }) => { const v = document.querySelectorAll(sel)[idx]; if (!v) return null; const r = v.getBoundingClientRect(); return (r.top + r.bottom) / 2 - innerHeight / 2; }, { sel, idx });
    if (d == null) return false;
    if (Math.abs(d) < 4) return true;
    const step = Math.sign(d) * Math.min(Math.abs(d), pxs / 60);
    await page.evaluate((s) => window.scrollBy(0, s), step);
    await sleep(16);
  }
}
// scroll down until the page holds more than `k` matches (cards page in as the feed is scrolled)
async function ensureCount(sel, k) {
  for (let t = 0; t < 25; t++) {
    const c = await page.evaluate((sel) => [document.querySelectorAll(sel).length, document.querySelectorAll('article.post').length, Math.round(scrollY), document.body.scrollHeight], sel);
    if (process.env.MDEBUG) console.log('ensureCount', k, c.join(' '));
    if (c[0] > k) return true;
    await page.evaluate(() => window.scrollBy(0, 1800)); await sleep(500);
  }
  return false;
}
const used = new Set();
async function stepScroll(px, pxs) { for (let left = px; left > 0; left -= pxs / 60) { await page.evaluate((s) => window.scrollBy(0, s), Math.min(left, pxs / 60)); await sleep(16); } }
// the k-th video below the middle of the screen, tagged so it can be found again after cards page in or out
async function nextVid(sel, k, pxs) {
  for (let t = 0; t < 40; t++) {
    const hit = await page.evaluate(({ sel, k }) => {
      const mid = innerHeight / 2;
      const vs = [...document.querySelectorAll(sel)].filter((v) => { const r = v.getBoundingClientRect(); return (r.top + r.bottom) / 2 > mid + 20; }).sort((x, y) => x.getBoundingClientRect().top - y.getBoundingClientRect().top);
      const v = vs[k - 1]; if (!v) return null;
      v.dataset.mtag = v.dataset.mtag || String(Math.random()).slice(2);
      return { tag: v.dataset.mtag, src: v.dataset.item || v.dataset.vsrc || v.dataset.psrc };
    }, { sel, k });
    if (hit) return hit;
    await stepScroll(1200, pxs); await sleep(200);
  }
  return null;
}
async function feedRun(label, hash, n, skip, pxs, dwell) {
  await page.goto(base + hash, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('article.post', { timeout: 15000 }).catch(() => {});
  await sleep(1500);
  const sel = '#view video[data-auto], #view video[data-psrc]';
  const runAt = await nowIn();
  for (let i = 0; i < n; i++) {
    const hit = await nextVid(sel, skip, pxs);
    if (!hit) { console.log(`${label}: no more videos`); break; }
    if (!(await scrollToVid(`[data-mtag="${hit.tag}"]`, 0, pxs))) continue;
    const e = await waitEv((x) => !used.has(x.id) && x.src && (x.src === hit.src || hit.src.includes(x.src) || x.src.includes(hit.src)) && x.wantAt >= runAt && !x.full, dwell + 8000);
    if (e) used.add(e.id);
    if (!e && process.env.MDEBUG) console.log('no event for', hit.src, JSON.stringify((await evs()).slice(-3)));
    add(label, e && e.ms != null ? e : null, { note: e && e.gaveUp != null ? `gave up after ${e.gaveUp}` : '' });
    await sleep(dwell);
  }
}
const curReel = '#rv video[data-pool][data-want="1"]';
async function openRun(label, hash, tileSel, n, opts = {}) {
  for (let i = 0; i < n; i++) {
    await page.goto(base + hash, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector(tileSel, { timeout: 15000, state: 'attached' }).catch(() => {});
    await sleep(opts.settle ?? 1200);
    if (opts.scroll) await ensureCount(tileSel, i + (opts.from || 0));
    const ok = await page.evaluate(({ tileSel, i }) => { const t = document.querySelectorAll(tileSel)[i]; if (!t) return false; window.__tap = t; t.scrollIntoView({ block: 'center' }); return true; }, { tileSel, i: i + (opts.from || 0) });
    if (!ok) break;
    await sleep(opts.before ?? 300);
    const clickAt = await nowIn();
    const tapped = await page.evaluate(() => { const t = window.__tap; if (!t || !t.isConnected) return false; t.click(); return true; });
    if (!tapped) { console.log(`${label}: tile left the page before the tap, skipped`); continue; }
    const e = await waitEv((x) => x.full && x.wantAt >= clickAt - 5 && x.ms != null, 15000);
    if (e) add(label, { ...e, ms: Math.round(e.moveAt - clickAt) - (opts.tapWait || 0) }, opts.tapWait ? { note: `(+${opts.tapWait} ms double-tap wait not counted)` } : {}); else add(label, null);
    if (opts.swipes) {
      for (let s = 0; s < opts.swipes; s++) {
        await sleep(opts.dwell);
        const swAt = await nowIn();
        await page.evaluate(() => { const rv = document.getElementById('rv'); rv.scrollTop += rv.clientHeight; });
        const f = await waitEv((x) => x.full && x.wantAt >= swAt - 5 && x.ms != null, 15000);
        if (f) add(opts.swipeLabel, { ...f, ms: Math.round(f.moveAt - swAt) }); else add(opts.swipeLabel, null);
      }
    }
    await page.evaluate(() => { const b = document.querySelector('#rv [data-closefull]'); if (b) b.click(); });
    await sleep(400);
  }
}

const t0 = Date.now();
try {
  await feedRun('home scroll normal', '#/', 8, 1, 900, 3000);
  // fast = past ~4 cards at once (2 videos since Home alternates video and photo, 4 videos before that)
  await feedRun('home scroll fast', '#/', 6, 2, 3500, 2500);
  // feed tap -> viewer: a centred, playing feed video is tapped
  await openRun('feed tap -> viewer', '#/', '#view video[data-auto]', 5, { settle: 1500, before: 2500, scroll: true, tapWait: 330 });
  await openRun('reels grid tap', '#/reels', '#rgrid [data-reelopen]', 5, { swipes: 6, dwell: 3000, swipeLabel: 'viewer swipe (3 s each)' });
  await openRun('reels grid tap', '#/reels', '#rgrid [data-reelopen]', 2, { from: 6, swipes: 6, dwell: 800, swipeLabel: 'viewer swipe fast (0.8 s)' });
  await openRun('explore tile tap', '#/explore', '#view a.xt.big', 5);
  const acct = await (await fetch(base + 'api/feed')).json().then((p) => (p.cards || []).find((c) => c.media && c.media[0] && c.media[0].kind === 'video')?.acct?.id).catch(() => null);
  if (acct) await openRun('profile tile tap', `#/acct/${encodeURIComponent(acct)}`, '#view a.tile[href^="#/reels/"]', 5);
  else console.log('no account with a video found for the profile path');
} finally {
  await browser.close();
  await engine.stop();
}
const by = {};
for (const r of rows) (by[r.path] ||= []).push(r);
const med = (a) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };
console.log(`\nnet=${net} ios=${ios} media+api bytes=${(mediaBytes / 1e6).toFixed(1)} MB in ${Math.round((Date.now() - t0) / 1000)} s`);
console.log('path | n | median ms | max ms | never | warm/cold/opening');
const table = [];
for (const [p, rs] of Object.entries(by)) {
  const ms = rs.filter((r) => r.ms != null).map((r) => r.ms);
  const line = { path: p, n: rs.length, median: med(ms), max: ms.length ? Math.max(...ms) : null, never: rs.filter((r) => r.ms == null).length, warm: rs.filter((r) => r.warm === 'warm').length, cold: rs.filter((r) => r.warm === 'cold').length, opening: rs.filter((r) => r.warm === 'opening').length };
  table.push(line);
  console.log(`${p} | ${line.n} | ${line.median} | ${line.max} | ${line.never} | ${line.warm}/${line.cold}/${line.opening}`);
}
const out = argOf('--json');
if (out) fs.writeFileSync(out, JSON.stringify({ net, ios, rows, table }, null, 2));
process.exit(0);
