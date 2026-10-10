'use strict';
const { norm, tokens } = require('./text');
const { TYPE_TERMS, ROLE_FOR_TYPE } = require('./task');

const DEFAULT_WEIGHTS = Object.freeze({ capability: 30, userPreference: 20, expertise: 15, health: 10, performance: 10, cost: 5, latency: 5, history: 5 });
const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
const NON_CHAT = ['embedding', 'audio', 'image', 'moderation', 'other'];

/** Capability value after applying user declarations (profile.capabilityOverrides) — flagged so UI can say "user-declared". */
function capValue(c, cap) {
  const ov = c.profile && c.profile.capabilityOverrides && c.profile.capabilityOverrides[cap];
  if (ov === true) return { ok: true, via: 'user-declared' };
  const v = c.capabilities && c.capabilities[cap];
  return { ok: v === true, via: v === true ? 'provider' : (v === 'unknown' || v === undefined ? 'unknown' : 'unsupported') };
}

/** Hard gate: AVAILABLE + HEALTHY + USER-ENABLED (+ valid credential, chat-capable, required capabilities). */
function eligibility(c, task) {
  const why = [];
  if (!c.profile || !c.profile.enabled) why.push('disabled_by_user');
  if (c.connectionStatus !== 'VALID') why.push('credential_not_valid');
  if (!c.health || c.health.state !== 'HEALTHY') why.push('not_healthy:' + (c.health ? c.health.state : 'UNKNOWN'));
  if (NON_CHAT.includes(c.kind) || (c.capabilities && c.capabilities.chat === false)) why.push('not_a_chat_model');
  if (task) for (const [cap, need] of Object.entries(task.requiredCaps || {})) if (need) { const r = capValue(c, cap); if (!r.ok) why.push(`missing_capability:${cap}(${r.via})`); }
  return { ok: why.length === 0, why };
}

function expertise(task, c) {
  const p = c.profile || {};
  const pos = new Set(tokens([p.strengths, p.bestFor, (p.tasks || []).join(' '), p.role].join(' ')));
  const neg = new Set(tokens([p.weaknesses, p.avoidFor].join(' ')));
  if (!pos.size && !neg.size && !p.role) return { value: 0.5, note: 'no profile text' };
  const terms = new Set([...(TYPE_TERMS[task.type] || []).map(norm), ...(task.terms || [])]);
  let a = 0, b = 0; for (const t of terms) { if (pos.has(t)) a++; if (neg.has(t)) b++; }
  let v = 0.5 + 0.5 * Math.min(1, a / 2) - 0.6 * Math.min(1, b / 2);
  const roleMatch = p.role && (p.role === ROLE_FOR_TYPE[task.type] || p.role === task.type);
  if (roleMatch) v += 0.15;
  return { value: clamp(v), note: `strength hits ${a}, weakness hits ${b}${roleMatch ? ', role match' : ''}` };
}

function performance(task, c) {
  const p = c.profile || {}; const s = (k) => (p[k] == null ? 5 : p[k]) / 10;
  const parts = [];
  if (['analysis', 'math'].includes(task.type) || ['complex', 'critical'].includes(task.complexity)) parts.push(s('reasoning'));
  if (task.type === 'writing') parts.push(s('creativity'));
  if (['coding', 'math', 'analysis'].includes(task.type) || task.complexity === 'critical') parts.push(s('accuracy'));
  if (task.complexity === 'simple') parts.push(s('speed'));
  if (!parts.length) parts.push((s('reasoning') + s('accuracy')) / 2);
  return { value: clamp(parts.reduce((a, b) => a + b, 0) / parts.length) };
}

/** score every eligible candidate; every number comes from a real input (profile, health, stats, pricing, task). */
function scoreCandidates(task, candidates, { weights = {}, now = Date.now() } = {}) {
  const W = { ...DEFAULT_WEIGHTS, ...weights }; const sumW = Object.values(W).reduce((a, b) => a + b, 0) || 1;
  const eligible = [], excluded = [];
  for (const c of candidates) { const e = eligibility(c, task); (e.ok ? eligible : excluded).push(e.ok ? c : { candidate: c, reasons: e.why }); }
  const prices = eligible.map((c) => c.pricing && (c.pricing.inputPer1M != null || c.pricing.outputPer1M != null) ? (c.pricing.inputPer1M || 0) * 0.4 + (c.pricing.outputPer1M || 0) * 0.6 : null);
  const pk = prices.filter((x) => x != null); const pmin = Math.min(...pk), pmax = Math.max(...pk);
  const lats = eligible.map((c) => (c.stats && c.stats.avgLatencyMs) || (c.health && c.health.latencyMs) || null);
  const lk = lats.filter((x) => x != null); const lmin = Math.min(...lk), lmax = Math.max(...lk);
  const amplify = (v, slider) => clamp(0.5 + (v - 0.5) * ((slider == null ? 5 : slider) / 5));

  const scored = eligible.map((c, i) => {
    const p = c.profile; const st = c.stats || {};
    const comps = {};
    const needsVision = task.requiredCaps && task.requiredCaps.vision;
    let cap = 1; let capNote = 'required capabilities satisfied';
    if (needsVision && capValue(c, 'vision').via === 'user-declared') { cap = 0.7; capNote = 'vision is user-declared, not provider-confirmed'; }
    if (c.contextWindow && task.estimatedInputTokens > c.contextWindow * 0.8) { cap = Math.min(cap, 0.3); capNote = 'prompt may not fit the context window'; }
    else if (!c.contextWindow) cap = Math.min(cap, 0.85);
    comps.capability = { value: cap, note: capNote };
    const flags = p.flags || {};
    comps.userPreference = { value: clamp(((p.trust == null ? 5 : p.trust) / 10) * 0.5 + (flags.preferred || flags.primary ? 0.5 : flags.backup ? 0.05 : 0.2)), note: flags.preferred || flags.primary ? 'user-preferred' : flags.backup ? 'user-backup' : 'neutral' };
    comps.expertise = expertise(task, c);
    comps.health = { value: clamp(1 - 0.5 * (st.recentFailRate || 0)), note: `state ${c.health.state}` };
    comps.performance = performance(task, c);
    const price = prices[i];
    comps.cost = price == null ? { value: 0.5, note: 'pricing unknown' } : { value: amplify(pk.length > 1 && pmax > pmin ? 1 - (price - pmin) / (pmax - pmin) : 1, p.cost), note: `~$${price.toFixed(2)}/1M blended` };
    const lat = lats[i];
    comps.latency = lat == null ? { value: 0.5, note: 'no latency data' } : { value: amplify(lk.length > 1 && lmax > lmin ? 1 - (lat - lmin) / (lmax - lmin) : 1, p.speed), note: `${Math.round(lat)} ms` };
    const n = st.n || 0, ok = st.successes || 0;
    comps.history = { value: (ok + 1) / (n + 2), note: n ? `${ok}/${n} successful` : 'no history' };
    let total = 0; const breakdown = {};
    for (const k of Object.keys(W)) { const contribution = (W[k] * comps[k].value) / sumW * 100; total += contribution; breakdown[k] = { value: +comps[k].value.toFixed(3), weight: W[k], contribution: +contribution.toFixed(2), note: comps[k].note }; }
    return { candidate: c, score: +total.toFixed(1), breakdown };
  }).sort((a, b) => b.score - a.score);
  return { scored, excluded, weights: W };
}
module.exports = { scoreCandidates, eligibility, DEFAULT_WEIGHTS, capValue };
