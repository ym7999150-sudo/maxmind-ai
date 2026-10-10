'use strict';
const crypto = require('crypto');
const { hashPassword, verifyPassword } = require('../crypto');
const { audit } = require('./audit');

const COOKIE = 'mm_sid';
function createAuth({ cfg, db }) {
  const hmac = (t) => crypto.createHmac('sha256', cfg.authSecret).update(t).digest('hex');
  const fails = new Map(); // `${ip}|${user}` -> {n, until}
  const MAX_FAILS = 6, LOCK_MS = 10 * 60000;

  function seedDefaultUser() {
    if (db.get('SELECT 1 x FROM users LIMIT 1')) return;
    db.run('INSERT INTO users(id,username,password_hash,must_change_password,created_at) VALUES(?,?,?,?,?)', db.id(), 'admin', hashPassword(cfg.defaultPassword), 1, Date.now());
  }
  const parseCookies = (h) => Object.fromEntries(String(h || '').split(';').map((c) => c.trim().split('=')).filter((p) => p[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
  function cookieHeader(token, maxAgeSec) {
    return `${COOKIE}=${token}; HttpOnly; Path=/; SameSite=Strict; Max-Age=${maxAgeSec}${cfg.cookieSecure ? '; Secure' : ''}`;
  }
  function login(username, password, ip, ua) {
    const key = `${ip}|${String(username).toLowerCase()}`; const f = fails.get(key);
    if (f && f.until > Date.now()) { audit(db, null, 'login_blocked', { username }, ip); return { error: 'RATE_LIMITED', retryAfterSec: Math.ceil((f.until - Date.now()) / 1000) }; }
    const u = db.get('SELECT * FROM users WHERE username=?', String(username));
    const ok = u ? verifyPassword(String(password), u.password_hash) : (verifyPassword('x', hashPassword('y')), false); // constant-ish time
    if (!ok) { const n = (f && f.until <= Date.now() ? 0 : (f ? f.n : 0)) + 1; fails.set(key, { n, until: n >= MAX_FAILS ? Date.now() + LOCK_MS : 0 }); audit(db, u && u.id, 'login_failed', { username }, ip); return { error: 'INVALID_CREDENTIALS' }; }
    fails.delete(key);
    const token = crypto.randomBytes(32).toString('base64url'); const csrf = crypto.randomBytes(24).toString('base64url');
    db.run('INSERT INTO sessions(id_hash,user_id,csrf,created_at,expires_at,ip,ua) VALUES(?,?,?,?,?,?,?)', hmac(token), u.id, csrf, Date.now(), Date.now() + cfg.sessionHours * 3600000, ip, String(ua || '').slice(0, 200));
    db.run('UPDATE users SET last_login_at=? WHERE id=?', Date.now(), u.id);
    audit(db, u.id, 'login', null, ip);
    return { token, cookie: cookieHeader(token, cfg.sessionHours * 3600), user: publicUser(u), csrf };
  }
  const publicUser = (u) => ({ id: u.id, username: u.username, mustChangePassword: !!u.must_change_password });
  function sessionFrom(req) {
    const t = parseCookies(req.headers.cookie)[COOKIE]; if (!t) return null;
    const s = db.get('SELECT s.*, u.username, u.must_change_password FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id_hash=?', hmac(t));
    if (!s) return null; if (s.expires_at < Date.now()) { db.run('DELETE FROM sessions WHERE id_hash=?', s.id_hash); return null; }
    return { hash: s.id_hash, userId: s.user_id, username: s.username, csrf: s.csrf, mustChangePassword: !!s.must_change_password };
  }
  /** Express middleware: attaches req.session. `allowPendingPasswordChange` lets the forced-change screen through. */
  function requireAuth({ allowPendingPasswordChange = false } = {}) {
    return (req, res, next) => {
      const s = sessionFrom(req);
      if (!s) return res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Please sign in.' } });
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
        const sent = req.headers['x-csrf-token'];
        if (!sent || sent.length !== s.csrf.length || !crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(s.csrf))) return res.status(403).json({ error: { code: 'CSRF', message: 'Invalid CSRF token.' } });
      }
      if (s.mustChangePassword && !allowPendingPasswordChange) return res.status(403).json({ error: { code: 'PASSWORD_CHANGE_REQUIRED', message: 'You must change the initial password first.' } });
      req.session = s; req.userId = s.userId; next();
    };
  }
  function changePassword(userId, current, next, ip, keepSessionHash) {
    const u = db.get('SELECT * FROM users WHERE id=?', userId);
    if (!u || !verifyPassword(String(current), u.password_hash)) return { error: 'INVALID_CURRENT_PASSWORD' };
    const problems = passwordProblems(next, u.username); if (problems) return { error: 'WEAK_PASSWORD', message: problems };
    if (String(next) === cfg.defaultPassword) return { error: 'WEAK_PASSWORD', message: 'The initial password cannot be reused.' };
    db.run('UPDATE users SET password_hash=?, must_change_password=0 WHERE id=?', hashPassword(String(next)), userId);
    db.run('DELETE FROM sessions WHERE user_id=? AND id_hash<>?', userId, keepSessionHash || '');
    audit(db, userId, 'password_change', null, ip); return { ok: true };
  }
  function passwordProblems(pw, username) {
    pw = String(pw || '');
    if (pw.length < 10) return 'Password must be at least 10 characters.';
    if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) return 'Password must contain letters and digits.';
    if (username && pw.toLowerCase().includes(String(username).toLowerCase())) return 'Password must not contain the username.';
    return null;
  }
  function logout(req) { const s = sessionFrom(req); if (s) { db.run('DELETE FROM sessions WHERE id_hash=?', s.hash); audit(db, s.userId, 'logout', null, req.ip); } return `${COOKIE}=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0`; }
  return { seedDefaultUser, login, logout, requireAuth, sessionFrom, changePassword, publicUser, COOKIE };
}
module.exports = { createAuth };
