'use strict';
const { MaxMindError } = require('@maxmind-ai/core');
/** Tiny sliding-window rate limiter (in-memory). */
function limiter({ windowMs, max, key = (req) => req.ip, message = 'Too many requests. Slow down.' }) {
  const hits = new Map();
  const t = setInterval(() => { const now = Date.now(); for (const [k, v] of hits) { const f = v.filter((x) => x > now - windowMs); if (f.length) hits.set(k, f); else hits.delete(k); } }, windowMs).unref();
  return (req, res, next) => {
    const k = key(req), now = Date.now(); const arr = (hits.get(k) || []).filter((x) => x > now - windowMs);
    if (arr.length >= max) { res.setHeader('Retry-After', Math.ceil(windowMs / 1000)); return res.status(429).json({ error: { code: 'RATE_LIMITED', message } }); }
    arr.push(now); hits.set(k, arr); next();
  };
}
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
function errorHandler(isProd) {
  // eslint-disable-next-line no-unused-vars
  return (err, req, res, next) => {
    if (err instanceof MaxMindError) return res.status(err.status || 400).json({ error: { code: err.code, message: err.message, details: err.details || undefined } });
    if (err && err.type === 'entity.too.large') return res.status(413).json({ error: { code: 'TOO_LARGE', message: 'Request body too large.' } });
    if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: { code: 'BAD_JSON', message: 'Invalid JSON.' } });
    console.error('[error]', req.method, req.path, err && err.stack ? err.stack.split('\n')[0] : err); // never log bodies/headers
    res.status(500).json({ error: { code: 'INTERNAL', message: 'Internal server error.' } });
  };
}
const sse = (res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' }); res.flushHeaders && res.flushHeaders(); return (event, data) => { if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }; };
module.exports = { limiter, wrap, errorHandler, sse };
