'use strict';
const { DEFAULT_WEIGHTS } = require('@maxmind-ai/router');

const DEFAULTS = {
  language: 'en', theme: 'system', accent: '#6d8bff',
  chat: { mode: 'auto', systemPrompt: '', maxOutputTokens: 2048, showRequestDetails: true },
  team: { teamMode: 'automatic', maxTeamSize: 3, maxCalls: 5, reviewOnMedium: false, multiModel: true, selectedTeam: [], manualModelKey: null },
  tokens: { maxInputTokens: 6000, priority: 'normal', cacheEnabled: true, cacheThreshold: 0.92, cacheTtlHours: 24, keepLast: 4 },
  router: { weights: { ...DEFAULT_WEIGHTS } },
  memory: { enabled: true },
  files: { maxDocTokens: 1500 },
  voice: { lang: 'auto' },
  notifications: { toasts: true },
  advanced: { healthTtlMinutes: 30 }
};
const RULES = { // key path -> validator/clamp
  language: (v) => ['en', 'ar'].includes(v) ? v : undefined, theme: (v) => ['dark', 'light', 'system'].includes(v) ? v : undefined,
  accent: (v) => /^#[0-9a-fA-F]{6}$/.test(v) ? v : undefined,
  'chat.mode': (v) => ['auto', 'manual', 'team', 'smart'].includes(v) ? v : undefined, 'chat.systemPrompt': (v) => typeof v === 'string' ? v.slice(0, 4000) : undefined,
  'chat.maxOutputTokens': (v) => num(v, 16, 32000), 'chat.showRequestDetails': bool,
  'team.teamMode': (v) => ['automatic', 'manual', 'hybrid'].includes(v) ? v : undefined, 'team.maxTeamSize': (v) => num(v, 1, 6), 'team.maxCalls': (v) => num(v, 1, 10),
  'team.reviewOnMedium': bool, 'team.multiModel': bool, 'team.selectedTeam': (v) => Array.isArray(v) ? v.slice(0, 8).filter((x) => x && typeof x.key === 'string').map((x) => ({ key: x.key, role: String(x.role || 'worker').slice(0, 20) })) : undefined,
  'team.manualModelKey': (v) => v === null || typeof v === 'string' ? v : undefined,
  'tokens.maxInputTokens': (v) => num(v, 500, 200000), 'tokens.priority': (v) => ['low', 'normal', 'high'].includes(v) ? v : undefined, 'tokens.cacheEnabled': bool,
  'tokens.cacheThreshold': (v) => num(v, 0.5, 1), 'tokens.cacheTtlHours': (v) => num(v, 1, 720), 'tokens.keepLast': (v) => num(v, 1, 12),
  'router.weights': (v) => { if (!v || typeof v !== 'object') return; const o = {}; for (const k of Object.keys(DEFAULT_WEIGHTS)) { const n = num(v[k], 0, 100); o[k] = n === undefined ? DEFAULT_WEIGHTS[k] : n; } return o; },
  'memory.enabled': bool, 'files.maxDocTokens': (v) => num(v, 200, 20000), 'voice.lang': (v) => typeof v === 'string' && v.length <= 12 ? v : undefined,
  'notifications.toasts': bool, 'advanced.healthTtlMinutes': (v) => num(v, 1, 1440)
};
function num(v, a, b) { v = Number(v); return Number.isFinite(v) ? Math.min(b, Math.max(a, v)) : undefined; }
function bool(v) { return typeof v === 'boolean' ? v : undefined; }

const clone = (o) => JSON.parse(JSON.stringify(o));
function getSettings(db, userId) {
  const row = db.get('SELECT json FROM user_settings WHERE user_id=?', userId);
  const stored = row ? JSON.parse(row.json) : {};
  const s = clone(DEFAULTS);
  for (const [k, v] of Object.entries(stored)) { if (v && typeof v === 'object' && !Array.isArray(v) && s[k] && typeof s[k] === 'object') Object.assign(s[k], v); else if (k in s) s[k] = v; }
  return s;
}
/** patch: nested object. Unknown keys and invalid values are ignored; returns list of applied paths. */
function updateSettings(db, userId, patch) {
  const cur = getSettings(db, userId); const applied = [];
  const walk = (obj, prefix, target) => {
    for (const [k, v] of Object.entries(obj || {})) {
      const p = prefix ? `${prefix}.${k}` : k;
      if (RULES[p]) { const nv = RULES[p](v); if (nv !== undefined) { target[k] = nv; applied.push(p); } }
      else if (v && typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object') walk(v, p, target[k]);
    }
  };
  walk(patch, '', cur);
  db.run('INSERT INTO user_settings(user_id,json) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET json=excluded.json', userId, JSON.stringify(cur));
  return { settings: cur, applied };
}
module.exports = { getSettings, updateSettings, DEFAULTS };
