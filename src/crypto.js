'use strict';
const crypto = require('crypto');
/** Isolated secret handling: AES-256-GCM at rest (authenticated, per-record IV, AAD-bound to the connection id). */
function createVault(key32) {
  if (!Buffer.isBuffer(key32) || key32.length !== 32) throw new Error('vault key must be 32 bytes');
  return {
    encrypt(plain, aad) {
      const iv = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', key32, iv); c.setAAD(Buffer.from(String(aad)));
      const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
      return { ciphertext: ct.toString('base64'), iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), version: 1 };
    },
    decrypt(rec, aad) {
      const d = crypto.createDecipheriv('aes-256-gcm', key32, Buffer.from(rec.iv, 'base64')); d.setAAD(Buffer.from(String(aad))); d.setAuthTag(Buffer.from(rec.tag, 'base64'));
      return Buffer.concat([d.update(Buffer.from(rec.ciphertext, 'base64')), d.final()]).toString('utf8');
    }
  };
}
const maskKey = (k) => { k = String(k); return k.length <= 8 ? '*'.repeat(k.length) : k.slice(0, Math.min(3, k.length - 8)) + '*'.repeat(Math.min(14, k.length - 7)) + k.slice(-4); };
const hashPassword = (pw) => { const salt = crypto.randomBytes(16); const h = crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 }); return `scrypt$${salt.toString('base64')}$${h.toString('base64')}`; };
function verifyPassword(pw, stored) {
  try { const [, s, h] = stored.split('$'); const calc = crypto.scryptSync(pw, Buffer.from(s, 'base64'), 64, { N: 16384, r: 8, p: 1 }); return crypto.timingSafeEqual(calc, Buffer.from(h, 'base64')); } catch { return false; }
}
module.exports = { createVault, maskKey, hashPassword, verifyPassword };
