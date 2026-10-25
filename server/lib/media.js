// Media serving: the derived files (thumb / full / poster / video) streamed with Range support, and the
// optional static site (REEL_SITE, local testing only). Nothing is ever read whole into memory.
import fs from 'node:fs';
import path from 'node:path';
import { sendError } from './router.js';

const FILES = Object.freeze({
  'thumb.jpg': 'image/jpeg',
  'full.jpg': 'image/jpeg',
  'poster.jpg': 'image/jpeg',
  'video.mp4': 'video/mp4',
});

const SITE_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.woff2': 'font/woff2',
});

// -> {start, end} | 'invalid' | null (no usable Range header: serve the whole file)
export function parseRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!m || (m[1] === '' && m[2] === '')) return null; // not a single byte range: serve the whole file
  let start;
  let end;
  if (m[1] === '') {
    const n = Number(m[2]);
    if (n === 0) return 'invalid';
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start >= size || start > end) return 'invalid';
  return { start, end };
}

// True when `target` is `root` itself or inside it.
function inside(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function sendFile(req, res, file, type, headers) {
  let st;
  try { st = fs.statSync(file); } catch { return sendError(res, 404, 'not found'); }
  if (!st.isFile()) return sendError(res, 404, 'not found');
  const size = st.size;
  const range = parseRange(req.headers.range, size);
  const base = { 'content-type': type, 'accept-ranges': 'bytes', ...headers };
  if (range === 'invalid') {
    res.writeHead(416, { ...base, 'content-range': `bytes */${size}`, 'content-length': 0 });
    return res.end();
  }
  let code = 200;
  let start = 0;
  let end = size - 1;
  if (range) {
    code = 206;
    ({ start, end } = range);
    base['content-range'] = `bytes ${start}-${end}/${size}`;
  }
  const len = size === 0 ? 0 : end - start + 1;
  base['content-length'] = len;
  res.writeHead(code, base);
  if (req.method === 'HEAD' || len === 0) return res.end();
  const stream = fs.createReadStream(file, { start, end });
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}

export function routes(router, ctx) {
  const root = path.resolve(ctx.cfg.derivedDir);

  const media = (req, res, params) => {
    const type = FILES[params.file];
    const s = params.slug;
    // the slug is one path segment; anything that could climb out of it is simply not found
    if (!type || !s || s === '.' || s === '..' || /[\\/:\0]/.test(s)) return sendError(res, 404, 'not found');
    const file = path.resolve(root, s, params.file);
    if (!inside(root, file) || path.dirname(path.dirname(file)) !== root) return sendError(res, 404, 'not found');
    return sendFile(req, res, file, type, { 'cache-control': 'public, max-age=31536000, immutable' });
  };
  router.add('GET', '/reel/media/:slug/:file', media);
  router.add('HEAD', '/reel/media/:slug/:file', media);

  if (!ctx.cfg.siteDir) return;
  const site = path.resolve(ctx.cfg.siteDir);
  const serveSite = (req, res, params) => {
    let rel = params['*'] || '';
    if (rel === 'api' || rel.startsWith('api/') || rel === 'media' || rel.startsWith('media/')) {
      return sendError(res, 404, 'not found');
    }
    if (/[\0\\:]/.test(rel)) return sendError(res, 404, 'not found');
    if (rel === '' || rel.endsWith('/')) rel += 'index.html';
    let file = path.resolve(site, rel);
    if (!inside(site, file)) return sendError(res, 404, 'not found');
    try { if (fs.statSync(file).isDirectory()) file = path.join(file, 'index.html'); } catch { /* 404 below */ }
    const type = SITE_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
    return sendFile(req, res, file, type, { 'cache-control': 'no-cache' });
  };
  router.add('GET', '/reel/*', serveSite);
  router.add('HEAD', '/reel/*', serveSite);
}
