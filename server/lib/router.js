// Tiny method + path router. Patterns are literal segments and `:name` params, plus an optional
// final `*` that captures the rest of the path as params['*'].
//   handler(req, res, params, query, body)
// `body` is the parsed JSON for POST/PUT/DELETE ({} when empty). A handler either writes the
// response itself (sendJson / sendError) or returns a value, which is sent as 200 JSON.
// A handler that throws answers 500 {error} and is logged; the engine keeps serving.

const BODY_LIMIT = 10 * 1024 * 1024;
const BODY_METHODS = new Set(['POST', 'PUT', 'DELETE', 'PATCH']);

export function sendJson(res, code, obj) {
  const data = JSON.stringify(obj);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(data),
    'cache-control': 'no-store',
  });
  res.end(data);
}

export function sendError(res, code, msg) {
  sendJson(res, code, { error: String(msg) });
}

export class HttpError extends Error {
  constructor(code, msg) { super(msg); this.code = code; }
}

function compile(pattern) {
  const segs = pattern.split('/').filter(Boolean);
  return segs.map((s, i) => {
    if (s === '*' && i === segs.length - 1) return { rest: true };
    if (s.startsWith(':')) return { param: s.slice(1) };
    return { lit: s };
  });
}

function match(segs, parts) {
  const params = {};
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (s.rest) { params['*'] = parts.slice(i).join('/'); return params; }
    if (i >= parts.length) return null;
    if (s.lit !== undefined) { if (s.lit !== parts[i]) return null; continue; }
    params[s.param] = parts[i];
  }
  return parts.length === segs.length ? params : null;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > BODY_LIMIT) { reject(new HttpError(413, 'body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text.trim()) return resolve({});
      try { resolve(JSON.parse(text)); } catch { reject(new HttpError(400, 'invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

export function makeRouter(log = () => {}) {
  const routes = [];

  function add(method, pattern, handler) {
    routes.push({ method: method.toUpperCase(), pattern, segs: compile(pattern), handler });
  }

  // -> Promise<boolean>: true when a route matched (and the response was handled)
  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    let parts;
    try { parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent); } catch { return false; }
    let route = null;
    let params = null;
    for (const r of routes) {
      if (r.method !== req.method) continue;
      params = match(r.segs, parts);
      if (params) { route = r; break; }
    }
    if (!route) return false;
    const query = Object.fromEntries(url.searchParams);
    try {
      const body = BODY_METHODS.has(req.method) ? await readBody(req) : undefined;
      const out = await route.handler(req, res, params, query, body);
      if (!res.headersSent && !res.writableEnded) {
        if (out === undefined) sendJson(res, 200, { ok: true });
        else sendJson(res, 200, out);
      }
    } catch (e) {
      const code = e instanceof HttpError ? e.code : 500;
      if (code === 500) log('error', `${req.method} ${url.pathname} failed: ${e.message}`, { stack: e.stack });
      if (!res.headersSent) sendError(res, code, e.message || 'internal error');
      else res.destroy();
    }
    return true;
  }

  return { add, handle, routes };
}
