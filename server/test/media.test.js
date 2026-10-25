// Media serving: Range streaming from derivedDir, immutable caching, traversal rejected, optional static site.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { startTestEngine } from './helpers.js';
import { parseRange } from '../lib/media.js';

// A raw request: fetch() normalizes `..` and %2e%2e before sending, so traversal needs http.request.
function raw(base, method, p, headers = {}) {
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: u.hostname, port: u.port, method, path: p, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

function bytes(n) {
  const b = Buffer.alloc(n);
  for (let i = 0; i < n; i++) b[i] = i % 251;
  return b;
}

async function setup(t, extra = {}) {
  const e = await startTestEngine(extra);
  t.after(() => e.stop());
  const dir = path.join(e.ctx.cfg.derivedDir, 'p_1_2');
  fs.mkdirSync(dir, { recursive: true });
  const video = bytes(1000);
  fs.writeFileSync(path.join(dir, 'video.mp4'), video);
  fs.writeFileSync(path.join(dir, 'thumb.jpg'), bytes(50));
  fs.writeFileSync(path.join(e.ctx.cfg.dataDir, 'secret.txt'), 'top secret');
  fs.writeFileSync(path.join(e.ctx.cfg.derivedDir, 'thumb.jpg'), 'outside the slug dir');
  fs.writeFileSync(path.join(e.ctx.cfg.dataDir, 'thumb.jpg'), 'outside the derived dir');
  return { e, video };
}

test('Range bytes=0-99 answers 206 with the right Content-Range and exactly those bytes', async (t) => {
  const { e, video } = await setup(t);
  const r = await raw(e.base, 'GET', '/reel/media/p_1_2/video.mp4', { range: 'bytes=0-99' });
  assert.equal(r.status, 206);
  assert.equal(r.headers['content-range'], 'bytes 0-99/1000');
  assert.equal(r.headers['content-length'], '100');
  assert.equal(r.headers['content-type'], 'video/mp4');
  assert.equal(r.headers['accept-ranges'], 'bytes');
  assert.equal(r.headers['cache-control'], 'public, max-age=31536000, immutable');
  assert.deepEqual(r.body, video.subarray(0, 100));
  const open = await raw(e.base, 'GET', '/reel/media/p_1_2/video.mp4', { range: 'bytes=900-' });
  assert.equal(open.status, 206);
  assert.equal(open.headers['content-range'], 'bytes 900-999/1000');
  const suffix = await raw(e.base, 'GET', '/reel/media/p_1_2/video.mp4', { range: 'bytes=-10' });
  assert.equal(suffix.headers['content-range'], 'bytes 990-999/1000');
  assert.deepEqual(suffix.body, video.subarray(990));
  const clipped = await raw(e.base, 'GET', '/reel/media/p_1_2/video.mp4', { range: 'bytes=990-5000' });
  assert.equal(clipped.headers['content-range'], 'bytes 990-999/1000');
  const bad = await raw(e.base, 'GET', '/reel/media/p_1_2/video.mp4', { range: 'bytes=2000-3000' });
  assert.equal(bad.status, 416);
  assert.equal(bad.headers['content-range'], 'bytes */1000');
});

test('no Range gives the whole file, HEAD gives headers only, images are image/jpeg', async (t) => {
  const { e, video } = await setup(t);
  const all = await raw(e.base, 'GET', '/reel/media/p_1_2/video.mp4');
  assert.equal(all.status, 200);
  assert.deepEqual(all.body, video);
  const head = await raw(e.base, 'HEAD', '/reel/media/p_1_2/video.mp4');
  assert.equal(head.status, 200);
  assert.equal(head.headers['content-length'], '1000');
  assert.equal(head.body.length, 0);
  const img = await raw(e.base, 'GET', '/reel/media/p_1_2/thumb.jpg');
  assert.equal(img.headers['content-type'], 'image/jpeg');
  assert.equal((await raw(e.base, 'GET', '/reel/media/p_1_2/full.jpg')).status, 404, 'missing file');
  assert.equal((await raw(e.base, 'GET', '/reel/media/nope/thumb.jpg')).status, 404, 'missing slug');
  assert.equal((await raw(e.base, 'GET', '/reel/media/p_1_2/notes.txt')).status, 404, 'not a derived file name');
});

test('path traversal is a 404 and never leaks a file outside the slug directory', async (t) => {
  const { e } = await setup(t);
  const attempts = [
    '/reel/media/..%2f/thumb.jpg',
    '/reel/media/..%2f..%2fderived%2fp_1_2/thumb.jpg',
    '/reel/media/.%2f/thumb.jpg',
    '/reel/media/..%2f..%2fsecret.txt/thumb.jpg',
    '/reel/media/p_1_2/..%2f..%2fsecret.txt',
    '/reel/media/p_1_2/..%2fp_1_2%2fthumb.jpg',
    '/reel/media/..%5c..%5csecret.txt/thumb.jpg',
    '/reel/media/%2e%2e/thumb.jpg',
    '/reel/media/../thumb.jpg',
    '/reel/media/p_1_2/%00thumb.jpg',
  ];
  for (const p of attempts) {
    const r = await raw(e.base, 'GET', p);
    assert.equal(r.status, 404, p);
    assert.ok(!r.body.toString().includes('outside') && !r.body.toString().includes('secret'), p);
  }
});

test('parseRange handles the single-range forms and ignores the rest', () => {
  assert.deepEqual(parseRange('bytes=0-99', 1000), { start: 0, end: 99 });
  assert.deepEqual(parseRange('bytes=5-', 10), { start: 5, end: 9 });
  assert.deepEqual(parseRange('bytes=-3', 10), { start: 7, end: 9 });
  assert.equal(parseRange('bytes=10-12', 10), 'invalid');
  assert.equal(parseRange('bytes=5-2', 10), 'invalid');
  assert.equal(parseRange('bytes=0-1,4-5', 10), null);
  assert.equal(parseRange(undefined, 10), null);
});

test('the static site is served from siteDir only when it is set, with api and media kept apart', async (t) => {
  const none = await setup(t);
  assert.equal((await raw(none.e.base, 'GET', '/reel/')).status, 404);

  const site = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-site-'));
  t.after(() => fs.rmSync(site, { recursive: true, force: true }));
  fs.writeFileSync(path.join(site, 'index.html'), '<h1>reel</h1>');
  fs.mkdirSync(path.join(site, 'pfp'));
  fs.writeFileSync(path.join(site, 'pfp', 'r1.jpg'), 'jpegdata');
  fs.writeFileSync(path.join(path.dirname(site), 'reel-site-secret.txt'), 'nope');
  t.after(() => fs.rmSync(path.join(path.dirname(site), 'reel-site-secret.txt'), { force: true }));
  const { e } = await setup(t, { REEL_SITE: site });
  for (const p of ['/reel/', '/reel', '/reel/index.html']) {
    const r = await raw(e.base, 'GET', p);
    assert.equal(r.status, 200, p);
    assert.equal(r.body.toString(), '<h1>reel</h1>');
    assert.equal(r.headers['content-type'], 'text/html; charset=utf-8');
    assert.equal(r.headers['cache-control'], 'no-cache');
  }
  const pfp = await raw(e.base, 'GET', '/reel/pfp/r1.jpg');
  assert.equal(pfp.status, 200);
  assert.equal(pfp.headers['content-type'], 'image/jpeg');
  assert.equal((await raw(e.base, 'GET', '/reel/missing.js')).status, 404);
  assert.equal((await raw(e.base, 'GET', '/reel/..%2freel-site-secret.txt')).status, 404);
  assert.equal((await raw(e.base, 'GET', '/reel/pfp/..%2f..%2freel-site-secret.txt')).status, 404);
  const api = await raw(e.base, 'GET', '/reel/api/nothing-here');
  assert.equal(api.status, 404);
  assert.match(api.headers['content-type'], /json/);
  assert.equal((await raw(e.base, 'GET', '/reel/media/p_1_2/thumb.jpg')).headers['content-type'], 'image/jpeg');
  assert.equal((await raw(e.base, 'GET', '/reel/api/status')).status, 200);
});
