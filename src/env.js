'use strict';
const fs = require('fs');
const path = require('path');

/** Loads .env (no dependency) and validates required variables with actionable errors. */
function loadDotenv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if (!m || line.trim().startsWith('#')) continue;
    if (process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
function loadEnv({ root = path.join(__dirname, '..'), overrides = {} } = {}) {
  loadDotenv(path.join(root, '.env'));
  const e = { ...process.env, ...overrides };
  const errors = [];
  const isProd = e.NODE_ENV === 'production';
  let encKey = null;
  if (!e.ENCRYPTION_KEY) errors.push('ENCRYPTION_KEY is missing. Generate one: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"  (or run: npm run setup)');
  else { encKey = Buffer.from(e.ENCRYPTION_KEY, 'base64'); if (encKey.length !== 32) errors.push('ENCRYPTION_KEY must be 32 random bytes, base64-encoded (got ' + encKey.length + ' bytes).'); }
  if (!e.AUTH_SECRET || e.AUTH_SECRET.length < 32) errors.push('AUTH_SECRET is missing or shorter than 32 characters. Run: npm run setup');
  const mock = e.DEV_MOCK === '1';
  if (mock && isProd) errors.push('DEV_MOCK=1 is not allowed when NODE_ENV=production (mock responses must never mix with real ones).');
  if (e.ALLOW_INSECURE_LOCAL === '1' && isProd) errors.push('ALLOW_INSECURE_LOCAL=1 is not allowed in production.');
  const dbUrl = (e.DATABASE_URL || 'file:./data/maxmind.db').replace(/^file:/, '');
  const num = (k, d) => { const v = e[k] === undefined || e[k] === '' ? d : Number(e[k]); if (!Number.isFinite(v)) errors.push(`${k} must be a number`); return v; };
  const cfg = {
    root, isProd, mock, port: num('PORT', 3000), encKey, authSecret: e.AUTH_SECRET,
    dbPath: dbUrl === ':memory:' ? ':memory:' : path.resolve(root, dbUrl),
    allowInsecureLocal: e.ALLOW_INSECURE_LOCAL === '1', cookieSecure: e.COOKIE_SECURE ? e.COOKIE_SECURE === '1' : isProd,
    healthTtlMs: num('HEALTH_TTL_MINUTES', 30) * 60000, healthMaxModels: num('HEALTHCHECK_MAX_MODELS', 40), maxUploadBytes: num('MAX_UPLOAD_MB', 10) * 1048576,
    uploadDir: path.resolve(root, e.UPLOAD_DIR || 'data/uploads'), sessionHours: num('SESSION_HOURS', 24 * 7), defaultPassword: 'MaxMind AI 2026'
  };
  if (errors.length) { const err = new Error('Invalid configuration:\n  - ' + errors.join('\n  - ')); err.config = true; throw err; }
  return cfg;
}
module.exports = { loadEnv };
