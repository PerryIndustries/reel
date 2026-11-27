// Phone check for the thin Reel app (docs/index.html): seeds a made-up world, starts the real engine on a temp
// data dir (port 0) serving docs/ and the API on one origin, opens Chromium at an iPhone size and checks the things
// that keep iOS from killing the app (page size, videos, no object URLs) plus the main taps.
//   node tools/phone-check.mjs [--site <docs dir>] [--keep]
// Prints PASS n/n and exits 0 only when every check holds; otherwise lists the failures and exits 1.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const args = process.argv.slice(2);
const argOf = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const siteDir = path.resolve(argOf('--site') || path.join(root, 'docs'));

const kit = process.env.PLAYWRIGHT_DIR || 'C:/Users/Perry/hyperframes-student-kit/node_modules/playwright';
const { chromium } = await import(pathToFileURL(path.join(kit, 'index.mjs')).href);

function findChrome() {
  if (process.env.CHROME_EXE) return process.env.CHROME_EXE;
  const base = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright', 'chromium-1208');
  const hit = ['chrome-win64/chrome.exe', 'chrome-win/chrome.exe'].map((p) => path.join(base, p)).find((p) => fs.existsSync(p));
  if (!hit) throw new Error(`no chrome.exe under ${base}`);
  return hit;
}

const { seedFixtures } = await import(pathToFileURL(path.join(root, 'server', 'tools', 'seed-fixtures.js')).href);
const { startEngine } = await import(pathToFileURL(path.join(root, 'server', 'main.js')).href);

const results = [];
const note = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`); };
async function check(name, fn) {
  try {
    const detail = await fn();
    note(name, true, typeof detail === 'string' ? detail : '');
  } catch (e) {
    note(name, false, String(e && e.message || e).split('\n')[0]);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 8000, what = 'condition') {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(60);
  }
}

// ---- the world and the engine ------------------------------------------------------------------------------
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-phone-'));
const seeded = seedFixtures(dataDir);
const env = {};
for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('REEL_')) env[k] = v;
Object.assign(env, {
  REEL_DATA: dataDir,
  REEL_PORT: '0',
  REEL_SITE: siteDir,
  REEL_RCLONE: JSON.stringify(['reel-phone-check-no-such-rclone']),
  REEL_OLLAMA: 'http://127.0.0.1:9',
  REEL_STYLE: path.join(dataDir, 'no-style.json'),
});
let engine = await startEngine(env);
const base = `http://127.0.0.1:${engine.server.address().port}/reel/`;
let engineUp = true;
const stopEngine = async () => { if (engineUp) { engineUp = false; await engine.stop(); } };

let browser;
let exitCode = 1;
const overall = setTimeout(() => { console.error('phone-check: overall timeout'); process.exit(1); }, 170_000);
try {
  browser = await chromium.launch({ executablePath: findChrome(), headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  // count every object-URL call the page makes
  await ctx.addInitScript(() => {
    window.__objUrls = 0;
    const orig = URL.createObjectURL;
    URL.createObjectURL = function (...a) { window.__objUrls++; return orig.apply(this, a); };
  });
  const page = await ctx.newPage();
  const posts = [];
  const pageErrors = [];
  page.on('request', (r) => { if (r.method() !== 'GET') posts.push({ method: r.method(), url: new URL(r.url()).pathname, body: r.postData() || '' }); });
  page.on('pageerror', (e) => pageErrors.push(String(e && e.message || e)));
  const sawPost = (method, tail, pred) => posts.find((p) => p.method === method && p.url.endsWith(tail) && (!pred || pred(p.body ? JSON.parse(p.body) : {})));

  await page.goto(base, { waitUntil: 'domcontentloaded' });

  await check('Home loads cards and the story tray', async () => {
    await page.waitForSelector('article.post', { timeout: 10000 });
    await waitFor(() => page.evaluate(() => document.querySelectorAll('.tray .st').length > 0), 6000, 'story tray');
    const n = await page.evaluate(() => document.querySelectorAll('article.post').length);
    if (n < 1) throw new Error('no cards');
    return `${n} cards, ${await page.evaluate(() => document.querySelectorAll('.tray .st').length)} stories`;
  });

  await check('Home pages in more cards while scrolling', async () => {
    const before = await page.evaluate(() => FS.home.items.length);
    await page.evaluate(() => window.scrollBy(0, 4000));
    await waitFor(() => page.evaluate((b) => FS.home.items.length > b, before), 8000, 'a second page');
    await page.evaluate(() => window.scrollTo(0, 0));
    return `${before} -> ${await page.evaluate(() => FS.home.items.length)}`;
  });

  // ---- a long scroll: the page never holds more than 24 cards, 3 loaded videos and 3 openings ---------------------
  let sampled = 0; let maxCards = 0; let maxVideos = 0; let maxReal = 0; let loadedCards = 0; let maxOpen = 0;
  await check('Scrolling through 200 cards keeps DOM cards <= 24, full <video src> <= 3 and openings <= 3 at every sample', async () => {
    const bad = [];
    const sample = async () => {
      const s = await page.evaluate(() => ({
        cards: document.querySelectorAll('article.post').length,
        vids: document.querySelectorAll('video[src]:not(.ov)').length,
        open: document.querySelectorAll('video.ov[src]').length,
        items: FS.home.items.length,
      }));
      sampled++; maxCards = Math.max(maxCards, s.cards); maxVideos = Math.max(maxVideos, s.vids); maxOpen = Math.max(maxOpen, s.open); loadedCards = s.items;
      if (s.cards > 24) bad.push(`cards ${s.cards}`);
      if (s.vids > 3) bad.push(`videos ${s.vids}`);
      if (s.open > 3) bad.push(`openings ${s.open}`);
    };
    let stuck = 0; let lastItems = 0;
    const deadline = Date.now() + 100_000;
    while (loadedCards < 205 && Date.now() < deadline) {
      await page.evaluate(() => window.scrollBy(0, 620));
      await sleep(45);
      await sample();
      if (loadedCards === lastItems) { stuck++; if (stuck > 400) break; } else { stuck = 0; lastItems = loadedCards; }
    }
    // keep sampling while it settles, and walk back up too
    for (let i = 0; i < 25; i++) { await page.evaluate(() => window.scrollBy(0, -2500)); await sleep(40); await sample(); }
    if (loadedCards < 200) throw new Error(`only ${loadedCards} cards were loaded`);
    if (bad.length) throw new Error(`${bad.length} bad samples, e.g. ${bad[0]}`);
    return `${sampled} samples, ${loadedCards} cards loaded, max ${maxCards} cards, ${maxVideos} videos and ${maxOpen} openings in the page`;
  });

  await check('The long scroll really did put cards and a video in the page', async () => {
    if (maxCards < 2) throw new Error(`never more than ${maxCards} cards in the page`);
    if (maxVideos < 1) throw new Error('no video ever got a src');
  });

  // ---- a feed that is only reels: three videos loaded at once, never a fourth -----------------------------------
  await check('A run of reels: at most 3 full videos and 3 openings; a neighbour with an opening holds only that', async () => {
    await page.goto(base + `#/p/${seeded.reelsPost}/more`);
    await page.waitForSelector('article.post', { timeout: 10000 });
    let max = 0; let maxCards = 0; let steps = 0; let still = 0; let lastY = -1; let over = null; let onlyOpen = 0; let maxO = 0;
    for (;;) {
      await page.evaluate(() => window.scrollBy(0, 300));
      await sleep(60);
      const s = await page.evaluate(() => ({
        v: document.querySelectorAll('video[src]:not(.ov)').length,
        o: document.querySelectorAll('video.ov[src]').length,
        // a feed video that has an opening ready next to it but no full file of its own (the full file waits for its turn)
        only: [...document.querySelectorAll('#view video[data-osrc]')].filter((v) => !v.getAttribute('src') && v._ov && v._ov.getAttribute('src')).length,
        all: document.querySelectorAll('article.post video').length,
        cards: document.querySelectorAll('article.post').length,
        y: Math.round(window.scrollY),
      }));
      if (s.v > max) max = s.v;
      if (s.o > maxO) maxO = s.o;
      onlyOpen = Math.max(onlyOpen, s.only);
      if ((s.v > 3 || s.o > 3) && !over) over = `${s.v} videos and ${s.o} openings`;
      maxCards = Math.max(maxCards, s.cards);
      steps++;
      still = s.y === lastY ? still + 1 : 0; lastY = s.y;
      if (still > 12 || steps > 400) break;
    }
    await page.goto(base + '#/');
    await page.waitForSelector('article.post', { timeout: 10000 });
    if (over) throw new Error(`${over} had a src at once`);
    if (max < 1) throw new Error('no video ever got a src');
    if (!onlyOpen) throw new Error('no neighbour ever held just its opening: every nearby video fetched its full file');
    return `${steps} scroll steps, ${maxCards} cards at most, max ${max} videos and ${maxO} openings, up to ${onlyOpen} neighbours on their opening only`;
  });

  await check('No blob: addresses anywhere in the page', async () => {
    const r = await page.evaluate(() => ({
      calls: window.__objUrls,
      html: document.documentElement.outerHTML.includes('blob:'),
      srcs: [...document.querySelectorAll('img,video,source')].filter((e) => /^blob:/.test(e.currentSrc || e.src || '')).length,
    }));
    if (r.calls) throw new Error(`URL.createObjectURL was called ${r.calls} times`);
    if (r.html) throw new Error('blob: found in the document');
    if (r.srcs) throw new Error(`${r.srcs} elements point at a blob:`);
  });

  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(400);

  await check('Seen cards are batched into POST seen', async () => {
    await waitFor(() => sawPost('POST', '/api/seen'), 9000, 'POST seen');
    const p = sawPost('POST', '/api/seen'); const b = JSON.parse(p.body);
    if (!Array.isArray(b.items) || !b.items.length) throw new Error('empty seen batch');
    return `${b.items.length} items`;
  });

  await check('Heart sends POST like and POST taste up', async () => {
    await page.evaluate(() => window.scrollTo(0, 0));
    await waitFor(() => page.evaluate(() => !!document.querySelector('article.post [data-up]')), 5000, 'a heart button');
    const id = await page.evaluate(() => document.querySelector('article.post [data-up]').dataset.up);
    await page.locator(`article.post[data-post="${id}"] [data-up]`).first().click();
    await waitFor(() => sawPost('POST', '/api/like', (b) => b.post === id && b.on === true) && sawPost('POST', '/api/taste', (b) => b.vote === 'up'), 6000, 'like + taste');
    const t = sawPost('POST', '/api/taste', (b) => b.vote === 'up');
    if (!t || !/^d_seed/.test(JSON.parse(t.body).item)) throw new Error('taste did not name an item');
  });

  await check('Thumbs-down sends taste down and Undo sends taste undo', async () => {
    const id = await page.evaluate(() => document.querySelector('article.post [data-down]').dataset.down);
    await page.locator(`article.post[data-post="${id}"] [data-down]`).first().click();
    await waitFor(() => sawPost('POST', '/api/taste', (b) => b.vote === 'down'), 5000, 'taste down');
    await page.locator(`article.post[data-post="${id}"] [data-undown]`).first().click();
    await waitFor(() => sawPost('POST', '/api/taste', (b) => b.vote === 'undo'), 5000, 'taste undo');
  });

  await check('A thumbs-down card stays folded after another tab, and Undo still brings it back', async () => {
    const id = await page.evaluate(() => document.querySelector('article.post [data-down]').dataset.down);
    await page.locator(`article.post[data-post="${id}"] [data-down]`).first().click();
    await page.evaluate(() => { location.hash = '#/activity'; });
    await page.waitForSelector('#view article.post', { state: 'detached', timeout: 5000 });
    await page.evaluate(() => { location.hash = '#/'; });
    await page.waitForSelector(`article.post[data-post="${id}"]`, { timeout: 5000 });
    const fold = await page.evaluate((p) => { const el = document.querySelector(`article.post[data-post="${p}"]`); return { bar: !!el.querySelector('.lessbar'), btn: !!el.querySelector('[data-down]') }; }, id);
    if (!fold.bar || fold.btn) throw new Error(`card came back: ${JSON.stringify(fold)}`);
    await page.locator(`article.post[data-post="${id}"] [data-undown]`).first().click();
    await page.waitForSelector(`article.post[data-post="${id}"] [data-down]`, { timeout: 5000 });
  });

  await check('The reels viewer has a thumbs-down that votes and moves to the next video', async () => {
    await page.goto(base + '#/reels');
    await page.waitForSelector('#rgrid .tile', { timeout: 8000 });
    await page.locator('#rgrid .tile').first().click();
    await page.waitForSelector('#rv [data-rdown]', { timeout: 5000, state: 'attached' });
    const before = posts.filter((p) => p.url.endsWith('/api/taste')).length;
    await page.locator('#rv .r [data-rdown]').first().click();
    await waitFor(() => posts.filter((p) => p.url.endsWith('/api/taste')).length > before, 5000, 'taste down from the viewer');
    const body = JSON.parse(posts.filter((p) => p.url.endsWith('/api/taste')).at(-1).body);
    if (body.vote !== 'down' || !body.item) throw new Error(`sent ${JSON.stringify(body)}`);
    await waitFor(async () => (await page.evaluate(() => document.getElementById('rv').scrollTop)) > 0, 5000, 'next video');
    await page.evaluate(() => document.querySelector('#rv [data-closefull]').click());
  });

  await check('Reels tab shows tiles and the viewer reuses a pool of 3 videos', async () => {
    await page.goto(base + '#/reels');
    await page.waitForSelector('#rgrid .tile', { timeout: 8000 });
    await page.locator('#rgrid .tile').first().click();
    await page.waitForSelector('#full .rv video', { timeout: 8000, state: 'attached' });
    await sleep(500);
    for (let i = 0; i < 6; i++) { await page.evaluate(() => { const rv = document.getElementById('rv'); rv.scrollTop += rv.clientHeight; }); await sleep(450); }
    const r = await page.evaluate(() => ({ els: document.querySelectorAll('#full video:not(.ov)').length, src: document.querySelectorAll('video[src]:not(.ov)').length, open: document.querySelectorAll('video.ov').length }));
    if (r.els !== 3) throw new Error(`${r.els} video elements in the viewer`);
    if (r.src > 3) throw new Error(`${r.src} videos with a src`);
    if (r.open > 3) throw new Error(`${r.open} openings in the page`);
    await page.evaluate(() => document.querySelector('#rv [data-closefull]').click());
    return `${r.els} pooled videos`;
  });

  await check('Tapping a video in a feed or on Explore opens it full screen in the reels viewer', async () => {
    await page.goto(base + `#/p/${seeded.reelsPost}/more`);
    await page.waitForSelector('#view article.post .slides video', { timeout: 8000, state: 'attached' });
    await page.locator('#view article.post .slides').first().tap();
    await page.waitForSelector('#full .rv .scrub', { timeout: 5000, state: 'attached' });
    const hash = await page.evaluate(() => location.hash);
    await page.evaluate(() => document.querySelector('#rv [data-closefull]').click());
    await page.goto(base + '#/explore');
    await page.waitForSelector('.xt', { timeout: 8000 });
    const href = await page.evaluate(() => { const a = document.querySelector('.xt.big'); return a && a.getAttribute('href'); });
    if (!href || !href.startsWith('#/reels/')) throw new Error(`explore video tile goes to ${href}`);
    await page.locator('.xt.big').first().tap();
    await page.waitForSelector('#full .rv video', { timeout: 5000, state: 'attached' });
    const ex = await page.evaluate(() => ({ hash: location.hash, xt: !!document.querySelector('#view .xt') }));
    await page.evaluate(() => document.querySelector('#rv [data-closefull]').click());
    if (ex.hash !== '#/explore' || !ex.xt) throw new Error(`explore tile left Explore: ${JSON.stringify(ex)}`);
    return `feed tap stays on ${hash}, explore video tile opens over Explore`;
  });

  await check('The reels viewer shows the whole video instead of zooming in to fill the screen', async () => {
    await page.goto(base + '#/reels');
    await page.waitForSelector('#rgrid .tile', { timeout: 8000 });
    await page.locator('#rgrid .tile').first().tap();
    await page.waitForSelector('#rv .r video', { timeout: 5000, state: 'attached' });
    const fit = await page.evaluate(() => getComputedStyle(document.querySelector('#rv .r video')).objectFit);
    await page.evaluate(() => document.querySelector('#rv [data-closefull]').click());
    if (fit !== 'contain') throw new Error(`object-fit is ${fit}`);
    return `object-fit ${fit}`;
  });

  await check('Dragging the reel scrub bar shows a big preview with the time, then jumps there on release', async () => {
    await page.goto(base + '#/reels');
    await page.waitForSelector('#rgrid .tile', { timeout: 8000 });
    await page.locator('#rgrid .tile').first().click();
    await page.waitForSelector('#full .rv video', { timeout: 8000, state: 'attached' });
    await page.waitForFunction(() => { const s = [...document.querySelectorAll('#rv .r')].find((x) => x.dataset.built && x.querySelector('video')); const v = s && s.querySelector('video'); return v && v.duration > 1; }, null, { timeout: 10000 });
    const box = await page.evaluate(() => {
      const s = [...document.querySelectorAll('#rv .r')].find((x) => x.querySelector('video[data-pool]') && x.querySelector('video[data-pool]').dataset.want === '1');
      s.id = 'cur'; const r = s.querySelector('.scrub .bar').getBoundingClientRect();
      return { x: r.left, y: r.top + r.height / 2, w: r.width, bottomGap: innerHeight - r.bottom };
    });
    if (box.bottomGap < 12) throw new Error(`scrub bar sits ${box.bottomGap}px from the bottom edge`);
    await page.mouse.move(box.x + box.w * 0.1, box.y);
    await page.mouse.down();
    await page.mouse.move(box.x + box.w * 0.6, box.y, { steps: 6 });
    await sleep(300);
    const mid = await page.evaluate(() => {
      const s = document.getElementById('cur'), pv = s.querySelector('.pv');
      return { shown: getComputedStyle(pv).display !== 'none', t: pv.querySelector('.t').textContent, pvVid: !!pv.querySelector('video'), w: pv.querySelector('.frame').getBoundingClientRect().width };
    });
    await page.mouse.up();
    const after = await page.evaluate(() => { const s = document.getElementById('cur'), v = s.querySelector('video[data-pool]'); return { at: v.currentTime / v.duration, pvGone: !s.querySelector('.pv video'), hidden: getComputedStyle(s.querySelector('.pv')).display === 'none', vids: document.querySelectorAll('#full video:not(.ov)').length }; });
    if (!mid.shown || !mid.pvVid) throw new Error(`preview not shown: ${JSON.stringify(mid)}`);
    if (!/^\d+:\d\d \/ \d+:\d\d$/.test(mid.t)) throw new Error(`time label "${mid.t}"`);
    if (mid.w < 120) throw new Error(`preview only ${mid.w}px wide`);
    if (Math.abs(after.at - 0.6) > 0.12) throw new Error(`reel at ${after.at.toFixed(2)} after release, wanted ~0.6`);
    if (!after.pvGone || !after.hidden || after.vids > 3) throw new Error(`after release: ${JSON.stringify(after)}`);
    await page.evaluate(() => document.querySelector('#rv [data-closefull]').click());
    return `preview ${Math.round(mid.w)}px "${mid.t}", reel at ${after.at.toFixed(2)} after release, ${after.vids} videos`;
  });

  // ---- a video opens where it was left ---------------------------------------------------------------------
  // Puts a loaded video at time t the way watching would (a seek, then the timeupdate after it).
  const putAt = (sel, t) => page.evaluate(async ([sel, t]) => {
    const v = document.querySelector(sel);
    await new Promise((r) => { const on = () => { if (!v.seeking) { v.removeEventListener('timeupdate', on); r(); } }; v.addEventListener('timeupdate', on); v.currentTime = t; });
  }, [sel, t]);
  const curReel = '#rv video[data-pool][data-want="1"]';
  // a video whose file has loaded and been put back in place
  const loadedAt = (sel, ms = 10000) => page.waitForFunction((sel) => { const v = document.querySelector(sel); return v && v.readyState >= 1 && v.duration > 1 && !v.seeking && v._vposSrc === v.currentSrc; }, sel, { timeout: ms })
    .catch(async () => { const st = await page.evaluate((sel) => { const v = document.querySelector(sel); return v ? { rs: v.readyState, d: v.duration, seeking: v.seeking, src: v.getAttribute('src'), cur: v.currentSrc, vp: v._vposSrc, hash: location.hash } : { none: true, hash: location.hash }; }, sel); throw new Error(`${sel} never loaded: ${JSON.stringify(st)}`); });
  const onDisk = (k) => page.evaluate((k) => { try { return !!JSON.parse(localStorage.getItem('reel2-vpos') || '{}')[k]; } catch (e) { return false; } }, k);
  let resumeItem = null;
  await check('A feed video opened full screen starts where the feed had it, and closing hands the time back', async () => {
    await page.goto(base + `#/p/${seeded.reelsPost}/more`);
    const feedVid = '#view article.post .slides video[data-item]';
    await page.waitForSelector(feedVid, { timeout: 8000, state: 'attached' });
    resumeItem = await page.evaluate((s) => document.querySelector(s).dataset.item, feedVid);
    const mine = `#view video[data-item="${resumeItem}"]`;
    await loadedAt(mine);
    await putAt(mine, 5);
    const hash0 = await page.evaluate((s) => { window.__feedVid = document.querySelector(s); window.__feedCard = window.__feedVid.closest('article'); window.__reelsGrid = 0; new MutationObserver(() => { if (document.getElementById('rgrid')) window.__reelsGrid++; }).observe(document.getElementById('view'), { childList: true, subtree: true }); return location.hash; }, mine);
    await page.locator('#view article.post .slides').first().tap();
    await loadedAt(curReel);
    const under = await page.evaluate(() => ({ hash: location.hash, card: window.__feedCard.isConnected, grid: window.__reelsGrid }));
    if (under.hash !== hash0 || !under.card || under.grid) throw new Error(`opening left the page: ${JSON.stringify(under)} (was ${hash0})`);
    const opened = await page.evaluate((s) => { const v = document.querySelector(s); return { t: v.currentTime, item: v.dataset.item, same: v === window.__feedVid }; }, curReel);
    if (!opened.same) throw new Error('the viewer downloaded the video again instead of taking the loaded copy from the feed');
    if (opened.item !== resumeItem) throw new Error(`viewer opened ${opened.item}, not ${resumeItem}`);
    if (Math.abs(opened.t - 5) > 1) throw new Error(`viewer started at ${opened.t.toFixed(2)}s, the feed was at 5s`);
    await putAt(curReel, 8);
    await page.evaluate(() => document.querySelector('#rv [data-closefull]').click());
    await page.waitForFunction(() => location.hash.startsWith('#/p/'), null, { timeout: 5000 });
    await loadedAt(mine);
    const after = await page.evaluate(() => ({ hash: location.hash, card: window.__feedCard.isConnected, grid: window.__reelsGrid }));
    if (after.hash !== hash0 || !after.card || after.grid) throw new Error(`closing redrew the page or showed the Reels tab: ${JSON.stringify(after)}`);
    const backSame = await page.evaluate((s) => document.querySelector(s) === window.__feedVid, mine);
    if (!backSame) throw new Error('closing downloaded the video again instead of handing the loaded copy back to the feed');
    const back = await page.evaluate((s) => document.querySelector(s).currentTime, mine);
    if (back < 7.5 || back > 11.5) throw new Error(`feed card back at ${back.toFixed(2)}s, the viewer was at 8s`);
    return `feed 5s -> viewer ${opened.t.toFixed(1)}s; viewer 8s -> feed ${back.toFixed(1)}s; same loaded video both ways; page never left`;
  });

  await check('A video left part way in the viewer opens there after a reload; one watched to the end starts over', async () => {
    if (!resumeItem) throw new Error('no item from the check before');
    await waitFor(() => onDisk(resumeItem), 5000, 'the spot saved on the phone');
    await page.goto(base + '#/');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.goto(base + `#/reels/${seeded.reelsPost}`);
    await loadedAt(curReel);
    const t1 = await page.evaluate((s) => document.querySelector(s).currentTime, curReel);
    if (t1 < 7.5 || t1 > 11.5) throw new Error(`after a reload the viewer started at ${t1.toFixed(2)}s, left at 8s`);
    const dur = await page.evaluate((s) => document.querySelector(s).duration, curReel);
    await putAt(curReel, dur - 0.4);
    await page.evaluate(() => document.querySelector('#rv [data-closefull]').click());
    await waitFor(async () => !(await onDisk(resumeItem)), 5000, 'the spot dropped');
    await page.goto(base + '#/');
    await page.goto(base + `#/reels/${seeded.reelsPost}`);
    await loadedAt(curReel);
    const t2 = await page.evaluate((s) => document.querySelector(s).currentTime, curReel);
    await page.evaluate(() => document.querySelector('#rv [data-closefull]').click());
    if (t2 > 1.5) throw new Error(`a finished video opened at ${t2.toFixed(2)}s instead of the start`);
    return `reload -> ${t1.toFixed(1)}s; finished -> ${t2.toFixed(1)}s`;
  });

  // ---- openings: a video starts on its small first seconds, the full file takes over underneath ------------------
  // reels whose video has an opening (fixtures v0-v2 have one, v3 not), from the end of the list so no earlier check watched them
  // every reel in the stream (the first page is a random few), paged through like the app does
  const allReels = await (async () => {
    const out = []; let stream; let cursor;
    for (let i = 0; i < 40; i++) {
      const qs = new URLSearchParams(); if (stream) qs.set('stream', stream); if (cursor != null) qs.set('cursor', cursor);
      const p = await (await fetch(base + 'api/reels?' + qs)).json();
      for (const c of p.cards || []) if (c.media[0] && !out.some((x) => x.id === c.id)) out.push({ id: c.id, item: c.media[0].item, open: !!c.media[0].open });
      stream = p.stream || stream; cursor = p.cursor;
      if (cursor == null) break;
    }
    return out;
  })();
  const openReels = allReels.filter((x) => x.open).reverse();
  // the full files answer late (a thin connection), so the opening has to carry the start
  const slowFull = async (ms) => page.route('**/video.mp4', async (route) => { await sleep(ms); route.continue().catch(() => {}); });
  const fastFull = () => page.unroute('**/video.mp4');
  // what the screen shows for the current reel: the stand-in's time while it is up, the real video's after
  const watchCur = () => page.evaluate(() => {
    window.__seen = [];
    clearInterval(window.__seenT);
    window.__seenT = setInterval(() => {
      const v = document.querySelector('#rv video[data-pool][data-want="1"]'); if (!v) return;
      const o = v._ov, on = !!(o && o.isConnected && o.classList.contains('on'));
      window.__seen.push({ ph: on ? 'ov' : 'v', t: on ? o.currentTime : v.currentTime, vm: v.muted, om: o ? o.muted : null, orate: o ? o.playbackRate : null, ovs: document.querySelectorAll(`#rv section[data-k="${v.dataset.idx}"] video.ov`).length, paused: v.paused });
    }, 30);
  });
  const seenOf = () => page.evaluate(() => { clearInterval(window.__seenT); return window.__seen; });
  const forget = (item) => page.evaluate((k) => { VPOS.clear(k); VPOS.flush(); }, item);
  await check('A reel with an opening starts on it at once, then the full file takes over at the same moment (no jump back, no restart)', async () => {
    if (openReels.length < 3) throw new Error(`only ${openReels.length} reels with an opening in the fixtures`);
    const it = openReels[0];
    await page.goto(base + '#/settings'); // no video plays here, so nothing writes the spot back
    await forget(it.item);
    await slowFull(1500);
    try {
      await page.goto(base + `#/reels/${it.id}`);
      await page.waitForSelector('#rv video[data-pool][data-want="1"]', { timeout: 8000, state: 'attached' });
      await watchCur();
      await waitFor(() => page.evaluate(() => window.__seen.some((x) => x.ph === 'v' && x.t > 1) && window.__seen.some((x) => x.ph === 'ov')), 12000, 'the full file to take over');
      await sleep(400);
    } finally { await fastFull(); }
    const seen = await seenOf();
    const first = seen.findIndex((x) => x.ph === 'ov');
    const ov = seen.filter((x) => x.ph === 'ov');
    const handAt = seen.findIndex((x, i) => i > first && x.ph === 'v');
    if (first < 0) throw new Error('the opening never showed');
    if (ov[ov.length - 1].t - ov[0].t < 0.8) throw new Error(`the opening only moved ${(ov[ov.length - 1].t - ov[0].t).toFixed(2)}s before the hand-over`);
    let back = 0;
    for (let i = first + 1; i < seen.length; i++) back = Math.max(back, seen[i - 1].t - seen[i].t);
    if (back > 0.15) throw new Error(`the picture jumped back ${back.toFixed(2)}s at the hand-over`);
    const after = seen.slice(handAt + 3);
    if (after.some((x) => x.ph === 'ov')) throw new Error('the opening came back after the hand-over');
    if (after.some((x) => x.ovs)) throw new Error('the stand-in stayed in the page after the hand-over');
    if (after[after.length - 1].paused) throw new Error('the full file is paused after the hand-over');
    if (ov.some((x) => !x.om)) throw new Error('the opening played with sound');
    await page.evaluate(() => document.querySelector('#rv [data-closefull]').click());
    return `opening up ${ov.length * 30} ms (${ov[0].t.toFixed(2)}-${ov[ov.length - 1].t.toFixed(2)} s), full file from ${seen[handAt].t.toFixed(2)} s, worst step back ${back.toFixed(2)} s`;
  });

  await check('With sound on, the full file stays silent under the opening and the sound starts with it; 2x follows the opening', async () => {
    const it = openReels[1];
    await page.goto(base + '#/settings'); // no video plays here, so nothing writes the spot back
    await forget(it.item);
    await page.evaluate(() => { LS.set('muted', false); setMuted(false); });
    await slowFull(1500);
    let seen;
    try {
      await page.goto(base + `#/reels/${it.id}`);
      await page.waitForSelector('#rv video[data-pool][data-want="1"]', { timeout: 8000, state: 'attached' });
      await watchCur();
      await waitFor(() => page.evaluate(() => window.__seen.some((x) => x.ph === 'ov')), 6000, 'the opening');
      await page.evaluate(() => { document.querySelector('#rv video[data-pool][data-want="1"]').playbackRate = 2; });
      await sleep(200);
      await waitFor(() => page.evaluate(() => window.__seen.some((x) => x.ph === 'v' && x.t > 1)), 12000, 'the full file to take over');
      await sleep(300);
      seen = await seenOf();
    } finally {
      await fastFull();
      await page.evaluate(() => { const v = document.querySelector('#rv video[data-pool][data-want="1"]'); if (v) v.playbackRate = 1; LS.set('muted', true); setMuted(true); });
    }
    const ov = seen.filter((x) => x.ph === 'ov');
    if (ov.some((x) => !x.vm)) throw new Error('the full file played its sound while the opening was showing');
    if (ov.some((x) => !x.om)) throw new Error('the opening itself had sound');
    if (!ov.some((x) => x.orate === 2)) throw new Error('2x on the reel did not reach the opening');
    const v = seen.filter((x) => x.ph === 'v').slice(-3);
    if (v.some((x) => x.vm)) throw new Error('the sound never came on after the hand-over');
    await page.evaluate(() => document.querySelector('#rv [data-closefull]').click());
    return `${ov.length} samples on the opening all silent underneath, sound on after`;
  });

  await check('A reel with a saved spot skips its opening and resumes at the spot', async () => {
    const it = openReels[2];
    await page.goto(base + '#/settings');
    await page.evaluate((k) => { VPOS.put(k, 7, true); VPOS.flush(); }, it.item);
    await slowFull(800);
    let seen;
    try {
      await page.goto(base + `#/reels/${it.id}`);
      await page.waitForSelector('#rv video[data-pool][data-want="1"]', { timeout: 8000, state: 'attached' });
      await watchCur();
      await waitFor(() => page.evaluate(() => window.__seen.some((x) => x.ph === 'v' && x.t > 7)), 12000, 'the reel at its spot');
      seen = await seenOf();
    } finally { await fastFull(); }
    if (seen.some((x) => x.ph === 'ov')) throw new Error('the opening showed for a reel that resumes part way');
    const t = await page.evaluate(() => document.querySelector('#rv video[data-pool][data-want="1"]').currentTime);
    await page.evaluate(() => document.querySelector('#rv [data-closefull]').click());
    await forget(it.item);
    if (t < 6.8) throw new Error(`resumed at ${t.toFixed(2)}s, saved 7s`);
    return `resumed at ${t.toFixed(1)}s, no opening`;
  });

  await check('The reel next in line that will resume part way loads its full file, not its opening', async () => {
    await page.goto(base + '#/reels');
    await page.waitForSelector('#rgrid .tile', { timeout: 8000 });
    // the next reel in line (first in the Reels list) is one with an opening and a saved spot
    const ids = await page.evaluate(() => {
      const st = FS.reels; const i = st.cards.findIndex((c) => c.media[0] && c.media[0].open);
      if (i < 0) return null;
      const [b] = st.cards.splice(i, 1); st.cards.unshift(b);
      const a = st.cards.find((c) => c.id !== b.id);
      VPOS.put(b.media[0].item, 6, true); VPOS.flush();
      return { a: a.id, b: b.id, item: b.media[0].item };
    });
    if (!ids) throw new Error('no reel with an opening in the Reels list');
    await page.evaluate((id) => openReelsFor(id), ids.a);
    await page.waitForFunction(() => document.querySelector('#rv section[data-k="1"] video[data-pool]'), null, { timeout: 8000 });
    await sleep(500);
    const n = await page.evaluate(() => { const s = document.querySelector('#rv section[data-k="1"]'), v = s.querySelector('video[data-pool]'); return { src: !!v.getAttribute('src'), ov: s.querySelectorAll('video.ov').length, item: v.dataset.item }; });
    await page.evaluate((k) => { VPOS.clear(k); VPOS.flush(); document.querySelector('#rv [data-closefull]').click(); }, ids.item);
    if (n.item !== ids.item) throw new Error(`the next reel is ${n.item}, set up ${ids.item}`);
    if (!n.src) throw new Error('the next reel holds no full file although it will resume part way');
    if (n.ov) throw new Error('the next reel holds an opening although it will resume part way');
    return 'next reel (saved at 6 s) has its full file and no opening';
  });

  // ---- 2x that outruns a thin connection --------------------------------------------------------------------------
  await check('2x that outruns the connection: a ring shows while the reel waits, and back at 1x the reel is nudged and moves again', async () => {
    // a reel without an opening, so nothing stands in over it
    const plain = allReels.filter((x) => !x.open);
    if (!plain.length) throw new Error('no reel without an opening in the fixtures');
    const it = plain[plain.length - 1];
    await page.goto(base + '#/settings');
    await page.evaluate((k) => { VPOS.clear(k); VPOS.flush(); }, it.item);
    const cdpN = await ctx.newCDPSession(page);
    await cdpN.send('Network.enable');
    await cdpN.send('Network.setCacheDisabled', { cacheDisabled: true });
    // the fixture plays at ~330 kbps: 1x keeps up, 2x does not
    await cdpN.send('Network.emulateNetworkConditions', { offline: false, latency: 40, downloadThroughput: 420e3 / 8, uploadThroughput: 1e6 / 8 });
    let ring = false; let seeks = 0; let moved = 0;
    try {
      await page.goto(base + `#/reels/${it.id}`);
      await page.waitForFunction(() => { const v = document.querySelector('#rv video[data-pool][data-want="1"]'); return v && v.currentTime > 0.5 && !v.paused; }, null, { timeout: 15000 });
      await page.evaluate(() => { const v = document.querySelector('#rv video[data-pool][data-want="1"]'); window.__seeks = 0; v.addEventListener('seeking', () => window.__seeks++); RV.lock2x = true; reelRate(); });
      ring = await page.waitForFunction(() => document.querySelector('#rv video[data-pool][data-want="1"]').closest('.r').classList.contains('wait'), null, { timeout: 20000 }).then(() => true, () => false);
      if (!ring) throw new Error('2x never stalled, or no ring showed while it waited');
      const stalled = await page.evaluate(() => { const v = document.querySelector('#rv video[data-pool][data-want="1"]'); return { rs: v.readyState, paused: v.paused, rate: v.playbackRate }; });
      if (stalled.rs >= 3 || stalled.paused) throw new Error(`ring without a stall: ${JSON.stringify(stalled)}`);
      await page.evaluate(() => { RV.lock2x = false; reelRate(); });
      seeks = await page.evaluate(() => window.__seeks);
      await cdpN.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
      moved = await page.evaluate(async () => { const v = document.querySelector('#rv video[data-pool][data-want="1"]'); const t0 = v.currentTime; await new Promise((r) => setTimeout(r, 2500)); return v.currentTime - t0; });
      const after = await page.evaluate(() => { const v = document.querySelector('#rv video[data-pool][data-want="1"]'); return { rate: v.playbackRate, paused: v.paused, ring: v.closest('.r').classList.contains('wait') }; });
      if (!seeks) throw new Error('back at 1x the stalled reel was not nudged');
      if (after.rate !== 1 || after.paused) throw new Error(`after 1x: ${JSON.stringify(after)}`);
      if (moved < 0.8) throw new Error(`the reel moved only ${moved.toFixed(2)}s in 2.5s after going back to 1x`);
      if (after.ring) throw new Error('the ring stayed up once the reel was moving');
    } finally {
      await cdpN.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }).catch(() => {});
      await cdpN.send('Network.setCacheDisabled', { cacheDisabled: false }).catch(() => {});
      await page.evaluate(() => { if (RV){ RV.lock2x = false; reelRate(); } const b = document.querySelector('#rv [data-closefull]'); if (b) b.click(); }).catch(() => {});
    }
    return `ring while stalled at 2x, ${seeks} nudge at 1x, then moved ${moved.toFixed(1)}s in 2.5s`;
  });

  // ---- the feed plays one video at a time, and the one playing holds on until it is mostly gone ------------------
  await check('Two feed videos on screen: only one plays, it keeps playing while half in view, the other takes over after', async () => {
    await page.setViewportSize({ width: 390, height: 1700 });
    try {
      await page.goto(base + `#/p/${seeded.reelsPost}/more`);
      await page.waitForSelector('#view video[data-auto]', { timeout: 10000, state: 'attached' });
      await page.evaluate(() => window.scrollTo(0, 0));
      await sleep(1500);
      // the state of the first two videos: how much is in view, how centred, whether each is the one playing
      const st = () => page.evaluate(() => {
        const vs = [...document.querySelectorAll('#view video[data-auto]')].slice(0, 2);
        return vs.map((v) => { const r = v.getBoundingClientRect(); const f = Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0)) / r.height; return { f: +f.toFixed(2), d: Math.abs((r.top + r.bottom) / 2 - innerHeight / 2), want: v.dataset.want === '1', playing: !v.paused, item: v.dataset.item }; });
      });
      const playingNow = () => page.evaluate(() => [...document.querySelectorAll('#view video')].filter((v) => !v.paused && !v.classList.contains('ov') && v.closest('#view')).length);
      let s = await st();
      if (s.length < 2 || s[0].f < 0.6 || s[1].f < 0.6) throw new Error(`need two videos in view: ${JSON.stringify(s)}`);
      await waitFor(async () => (await st()).some((x) => x.playing), 6000, 'a video playing');
      s = await st();
      if (await playingNow() !== 1) throw new Error(`${await playingNow()} videos playing with two on screen`);
      const P = s.findIndex((x) => x.want), Q = 1 - P;
      const dir = Q > P ? 1 : -1;
      // move until the other one is the more centred, while the playing one is still more than half in view
      for (let i = 0; i < 200; i++) { s = await st(); if (s[Q].d < s[P].d - 40 && s[P].f >= 0.55) break; await page.evaluate((y) => window.scrollBy(0, y), dir * 15); await sleep(30); }
      if (!(s[Q].d < s[P].d - 40 && s[P].f >= 0.55)) throw new Error(`could not set up the challenge: ${JSON.stringify(s)}`);
      await sleep(600);
      s = await st();
      if (!s[P].want || s[Q].want) throw new Error(`a small scroll flipped the playing video: ${JSON.stringify(s)}`);
      const held = s[P].f;
      if (await playingNow() !== 1) throw new Error(`${await playingNow()} videos playing`);
      // now the playing one leaves the screen: the other takes over
      for (let i = 0; i < 300; i++) { s = await st(); if (s[P].f < 0.4 && s[Q].f >= 0.6) break; await page.evaluate((y) => window.scrollBy(0, y), dir * 15); await sleep(30); }
      await waitFor(async () => { const x = await st(); return x[Q].want && !x[P].want; }, 4000, 'the other video to take over');
      await waitFor(async () => (await st())[Q].playing, 6000, 'the other video playing');
      s = await st();
      if (s[P].playing) throw new Error('the old video kept playing after the new one took over');
      return `video ${P + 1} kept playing at ${held} in view with video ${Q + 1} more centred; video ${Q + 1} took over at ${s[P].f}`;
    } finally {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(base + '#/');
      await page.waitForSelector('article.post', { timeout: 10000 }).catch(() => {});
    }
  });

  await check('Nothing selects or tints blue: a double-tap or long press on a card selects no text, typing boxes still do', async () => {
    await page.goto(base + '#/');
    await page.waitForSelector('article.post', { timeout: 10000 });
    const r = await page.evaluate(() => {
      const cap = document.querySelector('article.post .cap, article.post .caption, article.post .clamp, article.post .phead');
      const cs = (el) => getComputedStyle(el);
      return { user: cs(cap).userSelect || cs(cap).webkitUserSelect, tap: cs(document.documentElement).webkitTapHighlightColor };
    });
    const dbl = await (async () => {
      const box = await page.locator('article.post .phead').first().boundingBox();
      await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2);
      return page.evaluate(() => { const t = getSelection().toString(); getSelection().removeAllRanges(); return t; });
    })();
    await page.goto(base + '#/c/' + (await page.evaluate(() => document.querySelector('article.post').dataset.post)));
    const box = await page.waitForSelector('#view input, #view textarea', { timeout: 8000 });
    const typing = await box.evaluate((el) => getComputedStyle(el).userSelect || getComputedStyle(el).webkitUserSelect);
    if (r.user !== 'none') throw new Error(`card text is selectable (user-select ${r.user})`);
    if (dbl.trim()) throw new Error(`a double-tap selected "${dbl.trim().slice(0, 30)}"`);
    if (!/rgba\(0, 0, 0, 0\)|transparent/.test(r.tap)) throw new Error(`tap highlight ${r.tap}`);
    if (typing !== 'text' && typing !== 'auto') throw new Error(`the comment box can't select text (${typing})`);
    return `card text user-select none, double-tap selected nothing, tap highlight ${r.tap}, comment box ${typing}`;
  });

  // ---- photos: tap opens full screen, double-tap / pinch zoom, drag pans, swipe down closes --------------------
  await check('A photo opens full screen on a tap; double-tap and pinch zoom in (sharper copy), drag pans, swipe down closes', async () => {
    const cdp = await ctx.newCDPSession(page);
    const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], id) => ({ x, y, id })) });
    const drag = async (from, to, steps = 8) => {
      await touch('touchStart', from);
      for (let i = 1; i <= steps; i++) { await touch('touchMove', from.map(([x, y], k) => [x + (to[k][0] - x) * i / steps, y + (to[k][1] - y) * i / steps])); await sleep(16); }
      await touch('touchEnd', []);
    };
    const tapAt = async (x, y) => { await touch('touchStart', [[x, y]]); await touch('touchEnd', []); };
    const scaleOf = () => page.evaluate(() => { const im = document.querySelectorAll('#pz img')[0]; const m = /scale\(([\d.]+)\)/.exec(im.style.transform || ''); return m ? +m[1] : 1; });
    const zoomAsks = [];
    page.on('response', (r) => { if (r.url().endsWith('/zoom.jpg')) zoomAsks.push(r.status()); });
    await page.goto(base + '#/');
    await page.waitForSelector('#view article.post .slide img', { timeout: 10000 });
    await page.evaluate(() => { document.querySelector('#view article.post .slide img').closest('article').scrollIntoView(); });
    await sleep(300);
    await page.locator('#view article.post .slide img').first().tap();
    await page.waitForSelector('#pz img', { timeout: 3000 });
    const { w, h } = await page.evaluate(() => ({ w: innerWidth, h: innerHeight }));
    const cx = w / 2, cy = h / 2;
    await tapAt(cx, cy); await sleep(60); await tapAt(cx, cy); await sleep(400);
    const s1 = await scaleOf();
    if (Math.abs(s1 - 2.5) > 0.05) throw new Error(`double-tap zoomed to ${s1}`);
    await waitFor(() => page.evaluate(() => document.querySelector('#pz img').getAttribute('src').endsWith('/zoom.jpg')), 5000, 'the sharper copy');
    const t0 = await page.evaluate(() => document.querySelector('#pz img').style.transform);
    await drag([[cx, cy]], [[cx + 60, cy + 40]]); await sleep(350);
    const t1 = await page.evaluate(() => document.querySelector('#pz img').style.transform);
    if (t0 === t1) throw new Error('dragging a zoomed photo did not move it');
    if (!(await page.$('#pz'))) throw new Error('dragging a zoomed photo closed the viewer');
    await tapAt(cx, cy); await sleep(60); await tapAt(cx, cy); await sleep(400);
    if (await scaleOf() !== 1) throw new Error(`second double-tap left it at ${await scaleOf()}`);
    await drag([[cx - 40, cy], [cx + 40, cy]], [[cx - 120, cy], [cx + 120, cy]]); await sleep(350);
    const s2 = await scaleOf();
    if (s2 < 2.4 || s2 > 3.6) throw new Error(`pinching 80px -> 240px apart zoomed to ${s2}`);
    await tapAt(cx, cy); await sleep(60); await tapAt(cx, cy); await sleep(400);
    await drag([[cx, cy - 100]], [[cx, cy + 150]]); await sleep(300);
    if (await page.$('#pz')) throw new Error('swiping down did not close the viewer');
    if (!zoomAsks.length || zoomAsks.some((s) => s !== 200)) throw new Error(`zoom.jpg answers: ${JSON.stringify(zoomAsks)}`);
    return `double-tap x${s1}, pinch x${s2.toFixed(2)}, zoom.jpg ${zoomAsks.join(',')}, swipe down closed`;
  });

  await check('Pinching a photo on Home zooms it in place over the page and it springs back on release (no viewer opens)', async () => {
    const cdp = await ctx.newCDPSession(page);
    const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], id) => ({ x, y, id })) });
    await page.goto(base + '#/');
    await page.waitForSelector('#view article.post .slide img', { timeout: 10000 });
    const r = await page.evaluate(() => { const im = document.querySelector('#view article.post .slide img'); im.scrollIntoView({ block: 'center' }); const b = im.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2, w: b.width }; });
    await page.waitForFunction(() => { const im = document.querySelector('#view article.post .slide img'); return im.naturalWidth > 0; }, null, { timeout: 5000 });
    const hash0 = await page.evaluate(() => location.hash);
    const a0 = [[r.x - 30, r.y], [r.x + 30, r.y]], a1 = [[r.x - 90, r.y], [r.x + 90, r.y]];
    await touch('touchStart', a0);
    for (let i = 1; i <= 8; i++) { await touch('touchMove', a0.map(([x, y], k) => [x + (a1[k][0] - x) * i / 8, y])); await sleep(16); }
    const mid = await page.evaluate(() => { const p = document.getElementById('pinch'); const cl = p && p.querySelector('img'); const m = cl && /scale\(([\d.]+)\)/.exec(cl.style.transform); return { on: !!p, scale: m ? +m[1] : 0, hidden: document.querySelector('#view article.post .slide img').style.visibility }; });
    await touch('touchEnd', []);
    await sleep(450);
    const after = await page.evaluate(() => ({ gone: !document.getElementById('pinch'), shown: document.querySelector('#view article.post .slide img').style.visibility === '', viewer: !!document.getElementById('pz'), hash: location.hash }));
    if (!mid.on || mid.scale < 2.6 || mid.scale > 3.4) throw new Error(`mid-pinch: ${JSON.stringify(mid)}`);
    if (!after.gone || !after.shown) throw new Error(`after release: ${JSON.stringify(after)}`);
    if (after.viewer || after.hash !== hash0) throw new Error(`a pinch opened something: ${JSON.stringify(after)}`);
    return `x${mid.scale.toFixed(2)} while pinching, back in place after`;
  });

  // ---- reels viewer touches: hold a side = 2x, hold + drag down locks / up unlocks, hold middle pauses, drag right closes
  await check('Reels: holding a side plays 2x, hold-drag down locks it across reels, drag up unlocks, middle hold pauses, drag right closes', async () => {
    const cdp = await ctx.newCDPSession(page);
    const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], id) => ({ x, y, id })) });
    const move = async (from, to, steps = 8) => { for (let i = 1; i <= steps; i++) { await touch('touchMove', [[from[0] + (to[0] - from[0]) * i / steps, from[1] + (to[1] - from[1]) * i / steps]]); await sleep(16); } };
    const cur = () => page.evaluate(() => { const v = document.querySelector('#rv video[data-pool][data-want="1"]'); const b = document.getElementById('rvfast'); return v && { rate: v.playbackRate, paused: v.paused, badge: b.hidden ? '' : b.textContent, idx: v.dataset.idx }; });
    await page.goto(base + '#/reels');
    await page.waitForSelector('#rgrid .tile', { timeout: 8000 });
    // the first tile whose post is still up (the made-up world takes posts down as the check runs)
    const ids = await page.evaluate(() => [...document.querySelectorAll('#rgrid .tile')].map((t) => t.dataset.reelopen));
    let pick = -1;
    for (let i = 0; i < ids.length && pick < 0; i++) if ((await fetch(base + 'api/post/' + encodeURIComponent(ids[i]))).status === 200) pick = i;
    if (pick < 0) throw new Error('no reel tile with a live post');
    await page.locator('#rgrid .tile').nth(pick).scrollIntoViewIfNeeded();
    await page.locator('#rgrid .tile').nth(pick).tap();
    await page.waitForFunction(() => { const v = document.querySelector('#rv video[data-pool][data-want="1"]'); return v && v.readyState >= 2 && !v.paused; }, null, { timeout: 10000 });
    const { w, h } = await page.evaluate(() => ({ w: innerWidth, h: innerHeight }));
    const right = [w - 30, h * 0.45], mid = [w / 2, h * 0.45];
    const out = [];
    // hold the right side: 2x while held, 1x after
    await touch('touchStart', [right]); await sleep(450);
    const held = await cur();
    await touch('touchEnd', []); await sleep(120);
    const let1 = await cur();
    if (held.rate !== 2 || !held.badge.startsWith('2x')) throw new Error(`holding the right side: ${JSON.stringify(held)}`);
    if (let1.rate !== 1 || let1.badge) throw new Error(`after letting go: ${JSON.stringify(let1)}`);
    if (let1.paused) throw new Error('a hold paused the reel (the click after it counted as a tap)');
    out.push('hold 2x');
    // hold, drag down: locked; still 2x on the next reel
    await touch('touchStart', [right]); await sleep(400); await move(right, [right[0], right[1] + 90]); await touch('touchEnd', []); await sleep(150);
    const locked = await cur();
    if (locked.rate !== 2 || !/locked/.test(locked.badge)) throw new Error(`hold + drag down: ${JSON.stringify(locked)}`);
    await page.evaluate(() => { const rv = document.getElementById('rv'); rv.scrollTop += rv.clientHeight; });
    await page.waitForFunction((i) => { const v = document.querySelector('#rv video[data-pool][data-want="1"]'); return v && v.dataset.idx !== i; }, locked.idx, { timeout: 4000 });
    await sleep(200);
    const next = await cur();
    if (next.rate !== 2) throw new Error(`the next reel plays at ${next.rate}x with 2x locked`);
    out.push('lock carries to next reel');
    // hold, drag up: unlocked
    await touch('touchStart', [mid]); await sleep(400); await move(mid, [mid[0], mid[1] - 90]); await touch('touchEnd', []); await sleep(150);
    const unl = await cur();
    if (unl.rate !== 1 || unl.badge) throw new Error(`hold + drag up: ${JSON.stringify(unl)}`);
    out.push('unlock');
    // hold the middle: paused while held, playing after
    await touch('touchStart', [mid]); await sleep(450);
    const hp = await cur();
    await touch('touchEnd', []); await sleep(250);
    const ha = await cur();
    if (!hp.paused || ha.paused) throw new Error(`middle hold: during ${JSON.stringify(hp)}, after ${JSON.stringify(ha)}`);
    out.push('middle hold pauses');
    // drag left to right: closes
    const from = [40, h * 0.5];
    await touch('touchStart', [from]); await move(from, [w * 0.8, h * 0.52], 10); await touch('touchEnd', []);
    await waitFor(() => page.evaluate(() => !document.getElementById('rv')), 3000, 'the viewer to close');
    out.push('drag right closes');
    return out.join(', ');
  });

  // iPhone refuses sound outside a tap: the app must play muted for now but keep "sound on" saved
  await check('A blocked autoplay with sound on leaves the saved choice alone (muted stays false)', async () => {
    const c2 = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    try {
      await c2.addInitScript(() => {
        try { localStorage.setItem('reel2-muted', 'false'); } catch { /* storage */ }
        window.__blocked = 0;
        const orig = HTMLMediaElement.prototype.play;
        HTMLMediaElement.prototype.play = function (...a) {
          if (!this.muted) { window.__blocked++; return Promise.reject(new DOMException('blocked', 'NotAllowedError')); }
          return orig.apply(this, a);
        };
      });
      const p2 = await c2.newPage();
      await p2.goto(base + `#/p/${seeded.reelsPost}/more`, { waitUntil: 'domcontentloaded' });
      await p2.waitForSelector('article.post', { timeout: 10000 });
      for (let i = 0; i < 40; i++) {
        if (await p2.evaluate(() => window.__blocked > 0)) break;
        await p2.evaluate(() => window.scrollBy(0, 250)); await sleep(150);
      }
      await sleep(300);
      const r = await p2.evaluate(() => ({ blocked: window.__blocked, saved: localStorage.getItem('reel2-muted'), playing: [...document.querySelectorAll('video')].some((v) => !v.paused) }));
      if (!r.blocked) throw new Error('no autoplay was ever blocked, so the check proved nothing');
      if (r.saved !== 'false') throw new Error(`saved muted is ${r.saved} after a blocked autoplay`);
      return `${r.blocked} blocked plays, saved muted ${r.saved}, a video playing muted: ${r.playing}`;
    } finally { await c2.close(); }
  });

  await check('Stories open from the tray', async () => {
    await page.goto(base + '#/');
    await page.waitForSelector('.tray .st', { timeout: 8000 });
    await page.locator('.tray .st').first().click();
    await page.waitForSelector('#sv .fg', { timeout: 5000 });
    const bars = await page.evaluate(() => document.querySelectorAll('#sv .bar').length);
    await page.evaluate(() => document.querySelector('#sv [data-sclose]').click());
    return `${bars} bars`;
  });

  await check('Explore loads a grid and search finds an account', async () => {
    await page.goto(base + '#/explore');
    await page.waitForSelector('#xgrid .xt', { timeout: 8000 });
    await page.fill('#xq', 'yoru');
    await waitFor(() => page.evaluate(() => document.querySelectorAll('#xresults .row').length > 0), 4000, 'search results');
  });

  await check('Profile shows posts, a grid and tabs', async () => {
    await page.goto(base + '#/me');
    await page.waitForSelector('#pgrid .tile', { timeout: 8000 });
    const t = await page.evaluate(() => ({ tiles: document.querySelectorAll('#pgrid .tile').length, stats: document.querySelectorAll('.pstats b').length }));
    if (t.stats !== 3) throw new Error('profile numbers missing');
  });

  await check('Profile shows the highlights row and a tap opens the stories viewer on it', async () => {
    await page.goto(base + '#/me');
    await page.waitForSelector('.hls .hlb', { timeout: 8000 });
    const n = await page.evaluate(() => document.querySelectorAll('.hls .hlb').length);
    if (n !== 2) throw new Error(`${n} highlights shown, expected 2`);
    await page.locator('.hls .hlb').first().click();
    await page.waitForSelector('#sv .fg', { timeout: 5000 });
    const r = await page.evaluate(() => ({ bars: document.querySelectorAll('#sv .bar').length, reply: !!document.querySelector('#sv [data-sreply], #sv .reply') }));
    if (r.reply) throw new Error('the stories viewer has a reply control');
    await page.evaluate(() => document.querySelector('#sv [data-sclose]').click());
    return `${n} highlights, viewer opened`;
  });

  await check('Comments page lists comments and posting one sends POST comment', async () => {
    await page.waitForSelector('#pgrid .tile', { timeout: 8000 });
    const id = await page.evaluate(() => document.querySelector('#pgrid .tile').getAttribute('href').split('/')[2]);
    await page.goto(base + '#/c/' + id);
    await page.waitForSelector('.cmt', { timeout: 8000 });
    await page.fill('#cin', 'phone check hello');
    await page.click('[data-addc]');
    await waitFor(() => sawPost('POST', '/api/comment', (b) => b.text === 'phone check hello'), 5000, 'POST comment');
  });

  await check('Messages list a chat and sending sends POST dm', async () => {
    await page.goto(base + '#/dm/' + seeded.ownAccount);
    await page.waitForSelector('.dmrow', { timeout: 8000 });
    await page.locator('.dmrow').first().click();
    await page.waitForSelector('.bub', { timeout: 6000 });
    await page.fill('#dmin', 'hi from the phone check');
    await page.click('[data-dmsend]');
    await waitFor(() => sawPost('POST', '/api/dm', (b) => b.text === 'hi from the phone check' && b.acct === seeded.ownAccount), 5000, 'POST dm');
  });

  await check('Activity lists rows', async () => {
    await page.goto(base + '#/activity');
    await waitFor(() => page.evaluate(() => document.querySelectorAll('.act').length >= 3), 6000, 'activity rows');
  });

  await check('Settings posts/day round-trips through PUT settings', async () => {
    await page.goto(base + '#/settings');
    await page.waitForSelector('#sppd', { timeout: 8000 });
    await page.fill('#sppd', '80');
    await page.locator('#sppd').dispatchEvent('change');
    await waitFor(() => sawPost('PUT', '/api/settings', (b) => b.postsPerDay === 80), 5000, 'PUT settings');
    const s = await (await fetch(base + 'api/settings')).json();
    if (s.postsPerDay !== 80) throw new Error(`the engine has ${s.postsPerDay}`);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#sppd', { timeout: 8000 });
    const v = await page.inputValue('#sppd');
    if (v !== '80') throw new Error(`the page shows ${v} after reload`);
  });

  await check('Settings shows the engine, library and Writer cards', async () => {
    const txt = await page.evaluate(() => document.querySelector('#view').innerText);
    for (const want of ['Your PC', 'Library', 'Writer', 'Sync now', 'Version 102']) if (!txt.includes(want)) throw new Error(`missing "${want}"`);
    if (/\bAI\b/.test(await page.evaluate(() => document.body.innerText))) throw new Error('the word AI is on screen');
  });

  await check('Engine stopped: calm "Your PC is off or asleep" with Retry, last page stays', async () => {
    await page.goto(base + '#/');
    await page.waitForSelector('article.post', { timeout: 10000 });
    await stopEngine();
    await page.locator('.tabbar [data-tab="home"]').click();
    await waitFor(() => page.evaluate(() => { const e = document.getElementById('pcdown'); return e && !e.hidden && e.innerText.includes('Your PC is off or asleep'); }), 8000, 'the PC-off message');
    const r = await page.evaluate(() => ({ retry: !!document.querySelector('#pcdown [data-pcretry]'), cards: document.querySelectorAll('article.post').length }));
    if (!r.retry) throw new Error('no Retry button');
    if (r.cards < 1) throw new Error('the last page disappeared');
  });

  await check('Retry brings the page back when the PC is on again', async () => {
    engine = await startEngine({ ...env, REEL_PORT: new URL(base).port });
    engineUp = true;
    await page.locator('#pcdown [data-pcretry]').click();
    await waitFor(() => page.evaluate(() => document.getElementById('pcdown').hidden), 8000, 'the message to go away');
    await page.locator('.tabbar [data-tab="home"]').click();
    await waitFor(() => page.evaluate(() => document.querySelectorAll('article.post').length > 0), 8000, 'cards again');
  });

  await check('The page made no script errors', async () => {
    const real = pageErrors.filter((e) => !/Failed to fetch/.test(e));
    if (real.length) throw new Error(real[0]);
  });
} catch (e) {
  note('phone-check ran to the end', false, String(e && e.stack || e).split('\n').slice(0, 3).join(' | '));
} finally {
  clearTimeout(overall);
  try { if (browser) await browser.close(); } catch { /* closing */ }
  try { await stopEngine(); } catch { /* stopped */ }
  if (!args.includes('--keep')) { try { fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* temp dir */ } }
  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    console.log(`FAILED ${failed.length}/${results.length}:`);
    for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
    exitCode = 1;
  } else {
    console.log(`PASS ${results.length}/${results.length}`);
    exitCode = 0;
  }
}
process.exit(exitCode);
