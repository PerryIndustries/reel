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

  // ---- a long scroll: the page never holds more than 24 cards or 3 loaded videos --------------------------------
  let sampled = 0; let maxCards = 0; let maxVideos = 0; let maxReal = 0; let loadedCards = 0;
  await check('Scrolling through 200 cards keeps DOM cards <= 24 and <video src> <= 3 at every sample', async () => {
    const bad = [];
    const sample = async () => {
      const s = await page.evaluate(() => ({
        cards: document.querySelectorAll('article.post').length,
        vids: document.querySelectorAll('video[src]').length,
        items: FS.home.items.length,
      }));
      sampled++; maxCards = Math.max(maxCards, s.cards); maxVideos = Math.max(maxVideos, s.vids); loadedCards = s.items;
      if (s.cards > 24) bad.push(`cards ${s.cards}`);
      if (s.vids > 3) bad.push(`videos ${s.vids}`);
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
    return `${sampled} samples, ${loadedCards} cards loaded, max ${maxCards} cards and ${maxVideos} videos in the page`;
  });

  await check('The long scroll really did put cards and a video in the page', async () => {
    if (maxCards < 2) throw new Error(`never more than ${maxCards} cards in the page`);
    if (maxVideos < 1) throw new Error('no video ever got a src');
  });

  // ---- a feed that is only reels: three videos loaded at once, never a fourth -----------------------------------
  await check('A run of reels loads exactly 3 videos at the most (reaches 3, never 4)', async () => {
    await page.goto(base + `#/p/${seeded.reelsPost}/more`);
    await page.waitForSelector('article.post', { timeout: 10000 });
    let max = 0; let maxCards = 0; let steps = 0; let still = 0; let lastY = -1; let over = null;
    for (;;) {
      await page.evaluate(() => window.scrollBy(0, 300));
      await sleep(60);
      const s = await page.evaluate(() => ({
        v: document.querySelectorAll('video[src]').length,
        all: document.querySelectorAll('article.post video').length,
        cards: document.querySelectorAll('article.post').length,
        y: Math.round(window.scrollY),
      }));
      if (s.v > max) max = s.v;
      if (s.v > 3 && !over) over = s.v;
      maxCards = Math.max(maxCards, s.cards);
      steps++;
      still = s.y === lastY ? still + 1 : 0; lastY = s.y;
      if (still > 12 || steps > 400) break;
    }
    if (over) throw new Error(`${over} videos had a src at once`);
    if (max !== 3) throw new Error(`the most videos with a src was ${max}, expected it to reach exactly 3`);
    await page.goto(base + '#/');
    await page.waitForSelector('article.post', { timeout: 10000 });
    return `${steps} scroll steps, ${maxCards} cards at most, max ${max} videos`;
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

  await check('Reels tab shows tiles and the viewer reuses a pool of 3 videos', async () => {
    await page.goto(base + '#/reels');
    await page.waitForSelector('#rgrid .tile', { timeout: 8000 });
    await page.locator('#rgrid .tile').first().click();
    await page.waitForSelector('#full .rv video', { timeout: 8000, state: 'attached' });
    await sleep(500);
    for (let i = 0; i < 6; i++) { await page.evaluate(() => { const rv = document.getElementById('rv'); rv.scrollTop += rv.clientHeight; }); await sleep(450); }
    const r = await page.evaluate(() => ({ els: document.querySelectorAll('#full video').length, src: document.querySelectorAll('video[src]').length }));
    if (r.els !== 3) throw new Error(`${r.els} video elements in the viewer`);
    if (r.src > 3) throw new Error(`${r.src} videos with a src`);
    await page.evaluate(() => document.querySelector('#rv [data-closefull]').click());
    return `${r.els} pooled videos`;
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
