// Headless check for Wire (docs/x/) and Thread (docs/r/), the two apps that post from the engine's library: seeds a
// made-up world, starts the real engine on a temp data dir (port 0) serving docs/ and the API on one origin, with a
// stand-in for Ollama at that origin's /api/chat, opens each app at an iPhone size and checks that posts with photos
// show up from the engine's files, that a like or upvote reaches the engine, and that nothing errors.
//   node tools/kit-check.mjs [--site <docs dir>] [--keep]
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
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-kit-'));
const seeded = seedFixtures(dataDir);
const env = {};
for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('REEL_')) env[k] = v;
Object.assign(env, {
  REEL_DATA: dataDir,
  REEL_PORT: '0',
  REEL_SITE: siteDir,
  REEL_RCLONE: JSON.stringify(['reel-kit-check-no-such-rclone']),
  REEL_OLLAMA: 'http://127.0.0.1:9',
  REEL_STYLE: path.join(dataDir, 'no-style.json'),
});
const engine = await startEngine(env);
// On the real PC the page's origin proxies Ollama at /api/chat and serves the style at /reel/style.json. Stand-ins:
// a writer that always answers the same neutral lines, and an empty style the apps ignore.
const LINES = ['be honest', 'ok last one', 'no context', 'anyway', 'mirror said yes', 'which one, 1 or 2', 'posting this before i chicken out', 'say less', 'down bad rn', 'respectfully, wow', 'not me zooming in', 'the audacity', 'help', 'pause', 'i screamed', 'W post'];
let chatCalls = 0;
engine.ctx.router.add('POST', '/api/chat', (req, res) => {
  chatCalls++;
  res.writeHead(200, { 'content-type': 'application/x-ndjson' });
  res.end(`${JSON.stringify({ message: { role: 'assistant', content: LINES.join('\n') } })}\n${JSON.stringify({ done: true })}\n`);
});
engine.ctx.router.add('GET', '/reel/style.json', () => ({}));
engine.ctx.router.routes.unshift(engine.ctx.router.routes.pop()); // ahead of the site's /reel/* catch-all
const origin = `http://127.0.0.1:${engine.server.address().port}`;
const base = `${origin}/reel/`;

let browser;
let exitCode = 1;
const overall = setTimeout(() => { console.error('kit-check: overall timeout'); process.exit(1); }, 170_000);
try {
  browser = await chromium.launch({ executablePath: findChrome(), headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });

  const APPS = [
    { dir: 'x', name: 'Wire', card: 'article[data-post]', likeSel: '[data-like]' },
    { dir: 'r', name: 'Thread', card: 'article[data-post]', likeSel: '[data-vote="1"]' },
  ];
  for (const app of APPS) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await ctx.addInitScript(() => {
      window.__objUrls = 0;
      const orig = URL.createObjectURL;
      URL.createObjectURL = function (...a) { window.__objUrls++; return orig.apply(this, a); };
    });
    const page = await ctx.newPage();
    const posts = [];
    const pageErrors = [];
    const consoleErrors = [];
    const media = { ok: 0, bad: [] };
    page.on('request', (r) => { if (r.method() !== 'GET') posts.push({ method: r.method(), url: new URL(r.url()).pathname, body: r.postData() || '' }); });
    page.on('response', (r) => {
      const u = new URL(r.url());
      if (!u.pathname.startsWith('/reel/media/')) return;
      if (r.status() === 200 || r.status() === 206) media.ok++; else media.bad.push(`${r.status()} ${u.pathname}`);
    });
    page.on('requestfailed', (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/reel/media/')) media.bad.push(`failed ${u.pathname}`); });
    page.on('pageerror', (e) => pageErrors.push(String(e && e.message || e)));
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    const sawPost = (method, tail, pred) => posts.find((p) => p.method === method && p.url.endsWith(tail) && (!pred || pred(p.body ? JSON.parse(p.body) : {})));
    const chatBefore = chatCalls;

    await page.goto(`${base}${app.dir}/`, { waitUntil: 'domcontentloaded' });

    await check(`${app.name}: the library came from the engine (no Reel storage on the phone)`, async () => {
      await waitFor(() => page.evaluate(() => typeof LIB !== 'undefined' && LIB.loadedAt > 0), 10000, 'the library');
      const r = await page.evaluate(async () => ({
        ok: LIB.ok, err: LIB.err, accounts: LIB.accounts.length, own: ownAccts().length, npc: npcAccts().length,
        photos: [...LIB.photos.values()].reduce((n, l) => n + l.length, 0), videos: [...LIB.photos.values()].reduce((n, l) => n + l.filter((f) => isVideo(f.mime)).length, 0),
        keys: LIB.mediaKeys.size, taste: Object.keys(LIB.taste).length,
        avatar: (LIB.accounts.find((a) => a.avatar) || {}).avatar || '',
        dbs: (await indexedDB.databases()).map((d) => d.name),
      }));
      if (!r.ok) throw new Error(`LIB.ok is false (err=${r.err})`);
      // the engine tops the others up to six at boot, so there may be one more than the seed made
      if (r.accounts < seeded.accounts || r.own !== 3 || r.npc < 5) throw new Error(`${r.accounts} accounts, ${r.own} own, ${r.npc} others`);
      if (r.photos < 100 || r.videos < 10) throw new Error(`${r.photos} files, ${r.videos} videos`);
      if (!/^url:\.\.\/pfp\//.test(r.avatar)) throw new Error(`profile picture key is ${r.avatar}`);
      if (r.dbs.includes('reel')) throw new Error("Reel's own storage was opened or created");
      return `${r.accounts} accounts (${r.own} yours), ${r.photos} files incl. ${r.videos} videos, ${r.keys} keys`;
    });

    await check(`${app.name}: home shows posts and their photos load from /reel/media/`, async () => {
      await page.waitForSelector(app.card, { timeout: 10000 });
      await waitFor(() => page.evaluate(() => [...document.querySelectorAll('img[data-media]')].filter((i) => i.complete && i.naturalWidth > 0).length >= 3), 10000, 'three loaded photos');
      await page.evaluate(() => window.scrollBy(0, 2500));
      await sleep(800);
      await page.evaluate(() => window.scrollBy(0, 2500));
      await sleep(800);
      const r = await page.evaluate(() => {
        // photos and videos only: a "url:" key is a profile picture served next to Reel, not an engine file
        const imgs = [...document.querySelectorAll('img[data-media]')].filter((i) => !i.dataset.media.startsWith('url:'));
        const loaded = imgs.filter((i) => i.complete && i.naturalWidth > 0);
        const broken = imgs.filter((i) => i.getAttribute('src') && i.complete && i.naturalWidth === 0);
        return {
          cards: document.querySelectorAll('article[data-post]').length, imgs: imgs.length, loaded: loaded.length, broken: broken.length,
          fromEngine: loaded.filter((i) => /\/reel\/media\/[^/]+\/(thumb|full|poster)\.jpg$/.test(i.currentSrc)).length,
          pfps: [...document.querySelectorAll('.av img')].filter((i) => i.complete && i.naturalWidth > 0).length,
          objUrls: window.__objUrls, blob: document.documentElement.outerHTML.includes('blob:'),
        };
      });
      if (r.cards < 1) throw new Error('no cards');
      if (r.loaded < 3) throw new Error(`only ${r.loaded} of ${r.imgs} photos loaded`);
      if (r.broken) throw new Error(`${r.broken} broken photos`);
      if (r.fromEngine !== r.loaded) throw new Error(`${r.loaded - r.fromEngine} loaded photos are not engine files`);
      if (r.objUrls || r.blob) throw new Error(`object URLs: ${r.objUrls}, blob: in the page: ${r.blob}`);
      if (media.bad.length) throw new Error(`${media.bad.length} media requests failed, e.g. ${media.bad[0]}`);
      return `${r.cards} cards, ${r.loaded}/${r.imgs} photos loaded (${r.pfps} profile pictures), ${media.ok} media requests all 200/206`;
    });

    await check(`${app.name}: a post page shows the full-size photo`, async () => {
      // a post with exactly one photo, so its page shows the full-size copy
      const id = await page.evaluate(() => { const a = [...document.querySelectorAll('article[data-post]')].find((el) => el.querySelectorAll('img[data-media]:not([data-media^="url:"])').length === 1); return a ? a.dataset.post : ''; });
      if (!id) throw new Error('no single-photo post on home');
      await page.goto(`${base}${app.dir}/#/p/${id}`);
      const sel = '#view img[data-media]:not([data-media^="url:"])';
      await waitFor(() => page.evaluate((q) => [...document.querySelectorAll(q)].some((i) => i.complete && i.naturalWidth > 0), sel), 10000, 'the post photo');
      const r = await page.evaluate((q) => { const i = [...document.querySelectorAll(q)].find((x) => x.complete && x.naturalWidth > 0); return { src: i.currentSrc, w: i.naturalWidth, h: i.naturalHeight, small: i.dataset.small !== undefined }; }, sel);
      if (!/\/reel\/media\/[^/]+\/full\.jpg$/.test(r.src) || r.small) throw new Error(`photo src is ${r.src}${r.small ? ' (a small copy)' : ''}`);
      return `full ${r.w}x${r.h}`;
    });

    await check(`${app.name}: a like/upvote reaches the engine as taste up, and taking it back as undo`, async () => {
      await page.goto(`${base}${app.dir}/#/`);
      await page.waitForSelector(app.card, { timeout: 10000 });
      const id = await page.evaluate((sel) => { const a = [...document.querySelectorAll('article[data-post]')].find((el) => el.querySelector('img[data-media]:not([data-media^="url:"])') && el.querySelector(sel)); return a ? a.dataset.post : ''; }, app.likeSel);
      if (!id) throw new Error('no post with a photo and a like button');
      const like = `article[data-post="${id}"] ${app.likeSel}`;
      await page.locator(like).first().click();
      await waitFor(() => sawPost('POST', '/reel/api/taste', (b) => b.vote === 'up' && /^d_seed/.test(b.item)), 6000, 'POST taste up');
      const before = posts.length;
      await page.locator(like).first().click();
      await waitFor(() => posts.slice(before).some((p) => p.url.endsWith('/reel/api/taste') && JSON.parse(p.body).vote === 'undo'), 6000, 'POST taste undo');
      const up = sawPost('POST', '/reel/api/taste', (b) => b.vote === 'up');
      const item = JSON.parse(up.body).item;
      const row = engine.ctx.db.prepare('SELECT up, down, last_vote FROM items WHERE key = ?').get(item);
      await sleep(300);
      const after = engine.ctx.db.prepare('SELECT up, down, last_vote FROM items WHERE key = ?').get(item);
      if (!row) throw new Error(`the engine has no item ${item}`);
      if (after.up !== 0 || after.down !== 0) throw new Error(`after undo the engine has up=${after.up} down=${after.down}`);
      return `${item}: up then undo, engine back to 0/0`;
    });

    await check(`${app.name}: the writer talks to Ollama at the page's own origin`, async () => {
      await waitFor(() => chatCalls > chatBefore, 15000, 'a POST /api/chat');
      await waitFor(() => page.evaluate(() => S.posts.some((p) => p.textWritten && p.text)), 20000, 'a written post');
      const n = await page.evaluate(() => S.posts.filter((p) => p.textWritten && p.text).length);
      return `${chatCalls - chatBefore} calls so far, ${n} posts written`;
    });

    await check(`${app.name}: no script errors and no console errors`, async () => {
      if (pageErrors.length) throw new Error(`script error: ${pageErrors[0]}`);
      if (consoleErrors.length) throw new Error(`console error: ${consoleErrors[0]}`);
      return `${posts.length} non-GET requests, ${media.ok} media responses`;
    });

    await ctx.close();
  }
} catch (e) {
  note('kit-check ran to the end', false, String(e && e.stack || e).split('\n').slice(0, 3).join(' | '));
} finally {
  clearTimeout(overall);
  try { if (browser) await browser.close(); } catch { /* closing */ }
  try { await engine.stop(); } catch { /* stopped */ }
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
