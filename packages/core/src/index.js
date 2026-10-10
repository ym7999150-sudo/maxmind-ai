'use strict';
/** @maxmind-ai/core — shared primitives. No provider-specific logic lives here. */

const HEALTH = Object.freeze({
  HEALTHY: 'HEALTHY', DEGRADED: 'DEGRADED', RATE_LIMITED: 'RATE_LIMITED', AUTH_FAILED: 'AUTH_FAILED',
  UNAVAILABLE: 'UNAVAILABLE', TIMEOUT: 'TIMEOUT', UNKNOWN: 'UNKNOWN'
});
const PROVIDER_HEALTH = Object.freeze({
  CONNECTED: 'CONNECTED', HEALTHY: 'HEALTHY', DEGRADED: 'DEGRADED', RATE_LIMITED: 'RATE_LIMITED',
  AUTH_FAILED: 'AUTH_FAILED', OFFLINE: 'OFFLINE', UNKNOWN: 'UNKNOWN'
});

/** Returned by adapter functions a provider does not implement. Never fake a result. */
const UNSUPPORTED = Object.freeze({ supported: false, status: 'UNSUPPORTED' });
const isUnsupported = (v) => v === UNSUPPORTED || (v && v.status === 'UNSUPPORTED' && v.supported === false);

class MaxMindError extends Error {
  constructor(code, message, { status = 500, details = null, cause } = {}) {
    super(message);
    this.name = this.constructor.name;
    this.code = code; this.status = status; this.details = details;
    if (cause) this.cause = cause;
  }
}
/** kind: AUTH_FAILED | RATE_LIMITED | TIMEOUT | UNAVAILABLE | INVALID_REQUEST | NETWORK | SERVER | UNSUPPORTED | ABORTED */
class ProviderError extends MaxMindError {
  constructor(kind, message, { httpStatus = null, retryAfterMs = null, details = null } = {}) {
    super('PROVIDER_' + kind, message, { status: 502, details });
    this.kind = kind; this.httpStatus = httpStatus; this.retryAfterMs = retryAfterMs;
  }
  get retryable() { return ['RATE_LIMITED', 'TIMEOUT', 'NETWORK', 'SERVER'].includes(this.kind); }
}

function redact(text, secrets = []) {
  let s = String(text == null ? '' : text);
  for (const k of secrets) if (k && k.length > 5) s = s.split(k).join('[REDACTED]');
  return s.replace(/(sk-[A-Za-z0-9_-]{8,}|AIza[0-9A-Za-z_-]{20,}|gsk_[A-Za-z0-9]{10,}|xai-[A-Za-z0-9]{10,})/g, '[REDACTED]');
}

/** Keys may only be sent over HTTPS (loopback http allowed only when allowInsecureLocal is set — dev/tests). */
function assertSafeUrl(url, { allowInsecureLocal = false } = {}) {
  let u;
  try { u = new URL(url); } catch { throw new MaxMindError('BAD_URL', 'Invalid URL', { status: 400 }); }
  if (u.protocol === 'https:') return u;
  const loop = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(u.hostname);
  if (u.protocol === 'http:' && loop && allowInsecureLocal) return u;
  throw new MaxMindError('INSECURE_URL', 'Credentials are only sent over HTTPS', { status: 400 });
}

function classifyHttp(status, bodyMsg, retryAfter) {
  const retryAfterMs = retryAfter && !isNaN(+retryAfter) ? +retryAfter * 1000 : null;
  if (status === 401 || status === 403) return new ProviderError('AUTH_FAILED', bodyMsg || 'Authentication failed', { httpStatus: status });
  if (status === 429) return new ProviderError('RATE_LIMITED', bodyMsg || 'Rate limited', { httpStatus: status, retryAfterMs });
  if (status === 404) return new ProviderError('UNAVAILABLE', bodyMsg || 'Not found / model unavailable', { httpStatus: status });
  if (status === 408 || status === 504) return new ProviderError('TIMEOUT', bodyMsg || 'Upstream timeout', { httpStatus: status });
  if (status >= 500) return new ProviderError('SERVER', bodyMsg || 'Provider server error', { httpStatus: status });
  return new ProviderError('INVALID_REQUEST', bodyMsg || `HTTP ${status}`, { httpStatus: status });
}

function extractMessage(data) {
  if (!data) return '';
  const e = data.error;
  if (typeof e === 'string') return e;
  if (e && typeof e === 'object') return String(e.message || e.status || JSON.stringify(e)).slice(0, 400);
  if (data.message) return String(data.message).slice(0, 400);
  if (data.raw) return String(data.raw).slice(0, 200);
  return '';
}

const sleep = (ms, signal) => new Promise((res, rej) => {
  const t = setTimeout(res, ms);
  if (signal) signal.addEventListener('abort', () => { clearTimeout(t); rej(new ProviderError('ABORTED', 'Aborted')); }, { once: true });
});

/**
 * Single HTTP request with timeout, normalized errors and bounded retry
 * (exponential backoff + jitter). Auth/invalid-request errors are NEVER retried.
 * Returns { data, headers, status } ; with opts.stream returns the raw Response.
 */
async function request(url, { method = 'GET', headers = {}, body, timeoutMs = 30000, retries = 2, baseDelayMs = 400,
  signal, stream = false, allowInsecureLocal = false, secrets = [] } = {}) {
  assertSafeUrl(url, { allowInsecureLocal });
  let attempt = 0;
  for (;;) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new Error('timeout')), timeoutMs);
    let timedOut = false;
    ac.signal.addEventListener('abort', () => { if (!(signal && signal.aborted)) timedOut = true; }, { once: true });
    const onAbort = () => ac.abort(new Error('aborted'));
    if (signal) { if (signal.aborted) throw new ProviderError('ABORTED', 'Aborted'); signal.addEventListener('abort', onAbort, { once: true }); }
    try {
      let resp;
      try {
        resp = await fetch(url, { method, headers, body, signal: ac.signal, redirect: 'error' });
      } catch (e) {
        if (signal && signal.aborted) throw new ProviderError('ABORTED', 'Aborted');
        if (timedOut) throw new ProviderError('TIMEOUT', `Request timed out after ${timeoutMs}ms`);
        throw new ProviderError('NETWORK', 'Network error: ' + redact(e.cause?.code || e.message, secrets));
      }
      if (resp.ok && stream) { clearTimeout(timer); return resp; }
      const text = await resp.text();
      let data; try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text.slice(0, 500) }; }
      if (resp.ok) return { data, headers: resp.headers, status: resp.status };
      throw classifyHttp(resp.status, redact(extractMessage(data), secrets), resp.headers.get('retry-after'));
    } catch (err) {
      if (!(err instanceof ProviderError) || !err.retryable || attempt >= retries) throw err;
      const wait = err.retryAfterMs != null ? Math.min(err.retryAfterMs, 8000) : baseDelayMs * 2 ** attempt + Math.random() * 150;
      attempt++;
      await sleep(wait, signal);
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }
}

module.exports = { HEALTH, PROVIDER_HEALTH, UNSUPPORTED, isUnsupported, MaxMindError, ProviderError, redact, assertSafeUrl, request, classifyHttp, sleep };
