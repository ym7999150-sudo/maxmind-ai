'use strict';
const { ROLE_FOR_TYPE } = require('./task');

/**
 * Builds a routing plan WITHIN user constraints. Never selects outside `scored` (= enabled+healthy+valid+capable).
 * mode: auto | manual | team | smart ;  settings.teamMode: automatic | manual | hybrid
 */
const hasFlag = (c) => { const f = (c.profile && c.profile.flags) || {}; return !!(f.preferred || f.primary || f.reviewer || f.specialist || f.backup); };
const isPreferred = (c) => { const f = (c.profile && c.profile.flags) || {}; return !!(f.preferred || f.primary || f.specialist || f.reviewer); };
const id = (s) => `${s.candidate.providerName || s.candidate.providerId} · ${s.candidate.connectionName || s.candidate.connectionId} · ${s.candidate.modelId}`;
const fail = (code, message, details) => ({ ok: false, code, message, details: details || null });
const reasonFor = (excluded, key) => { const e = excluded.find((x) => x.candidate.key === key); return e ? e.reasons : ['unknown_model']; };

function buildPlan({ mode = 'auto', task, scored, excluded = [], settings = {}, selection = {} }) {
  const maxTeam = Math.max(1, settings.maxTeamSize || 3);
  const maxCalls = Math.max(1, settings.maxCalls || 5);
  const notes = [];
  const roleOf = (s) => (s.candidate.profile && s.candidate.profile.role) || ROLE_FOR_TYPE[task.type] || 'generalist';
  const step = (role, s, why) => ({ role, key: s.candidate.key, label: id(s), score: s.score, why });

  if (mode === 'manual') {
    const s = scored.find((x) => x.candidate.key === selection.manualKey);
    if (!s) return fail('MANUAL_MODEL_UNAVAILABLE', 'The model you selected is not available (disabled, unhealthy, invalid key or lacking a required capability). No substitute was used.', { reasons: reasonFor(excluded, selection.manualKey) });
    return { ok: true, strategy: 'single', steps: [step('primary', s, 'selected manually by user')], notes: ['manual mode: exactly the selected model'], expectedCalls: 1 };
  }
  if (mode === 'team') {
    const members = selection.team || [];
    if (!members.length) return fail('NO_TEAM_SELECTED', 'Team mode requires a user-selected team. Choose models in AI Team settings.');
    const picked = [];
    for (const m of members) { const s = scored.find((x) => x.candidate.key === m.key); if (!s) return fail('TEAM_MEMBER_UNAVAILABLE', 'A team member you selected is unavailable. No substitute was used.', { key: m.key, reasons: reasonFor(excluded, m.key) }); picked.push({ s, role: m.role || 'worker' }); }
    const workers = picked.filter((p) => !['reviewer', 'synthesizer'].includes(p.role));
    const reviewer = picked.find((p) => p.role === 'reviewer'); const synth = picked.find((p) => p.role === 'synthesizer') || workers[0] || picked[0];
    const steps = workers.slice(0, maxTeam).map((p) => step(p.role === 'worker' ? roleOf(p.s) : p.role, p.s, 'user-selected team'));
    if (!steps.length) steps.push(step('primary', picked[0].s, 'user-selected team'));
    if (reviewer) steps.push(step('reviewer', reviewer.s, 'user-selected team'));
    steps.push(step('synthesizer', synth.s, 'user-selected team'));
    return { ok: true, strategy: steps.length > 1 ? 'team' : 'single', steps, notes: ['team mode: exactly the user-selected team'], expectedCalls: steps.length };
  }

  // auto / smart ---------------------------------------------------------------------------------
  let pool = scored;
  const tm = settings.teamMode || 'automatic';
  if (tm === 'manual') {
    pool = scored.filter((s) => hasFlag(s.candidate));
    if (!pool.length) return fail('NO_SELECTED_MODELS', 'AI Team is set to Manual and no enabled healthy model is marked as preferred/primary/reviewer/specialist.');
    notes.push('team mode manual: only user-selected models participate');
  } else if (tm === 'hybrid') {
    pool = [...scored.filter((s) => isPreferred(s.candidate)), ...scored.filter((s) => !isPreferred(s.candidate))];
    notes.push('hybrid: preferred models first, others only when needed');
  }
  if (!pool.length) return fail('NO_COMPATIBLE_MODEL', 'No enabled, healthy model can perform this task.', { required: task.requiredCaps, excluded: excluded.map((e) => ({ key: e.candidate.key, reasons: e.reasons })) });

  const primary = pool[0];
  const others = pool.filter((s) => s.candidate.key !== primary.candidate.key);
  const bestReviewer = (list) => list.slice().sort((a, b) => ((b.candidate.profile.flags || {}).reviewer ? 100 : 0) + (b.candidate.profile.accuracy || 5) * 5 + b.score - (((a.candidate.profile.flags || {}).reviewer ? 100 : 0) + (a.candidate.profile.accuracy || 5) * 5 + a.score))[0];
  const multiOk = settings.multiModel !== false && maxCalls >= 2 && maxTeam >= 2;
  const c = task.complexity;

  if (c === 'simple' || !multiOk || !others.length) {
    if (c !== 'simple' && !others.length) notes.push('only one eligible model: team not possible');
    return { ok: true, strategy: 'single', steps: [step('primary', primary, 'highest score')], notes, expectedCalls: 1 };
  }
  if (c === 'medium') {
    if ((mode === 'smart' || settings.reviewOnMedium) && maxCalls >= 2) {
      const rv = bestReviewer(others);
      return { ok: true, strategy: 'primary_review', steps: [step('primary', primary, 'highest score'), step('reviewer', rv, 'best reviewer among others (final synthesis only if issues found)')], notes: [...notes, 'review is conditional: if reviewer reports OK the draft is the answer'], expectedCalls: 2 };
    }
    return { ok: true, strategy: 'single', steps: [step('primary', primary, 'highest score')], notes: [...notes, 'medium task: single model (review disabled)'], expectedCalls: 1 };
  }
  // complex / critical
  const workers = [primary];
  if ((c === 'critical' || mode === 'smart') && maxTeam >= 3 && others.length >= 2 && maxCalls >= 4) workers.push(others[0]);
  const reviewerPool = others.filter((s) => !workers.some((w) => w.candidate.key === s.candidate.key));
  const rv = bestReviewer(reviewerPool.length ? reviewerPool : others);
  const steps = [...workers.map((w, i) => step(i === 0 ? roleOf(w) : 'specialist', w, i === 0 ? 'highest score' : 'second-best score')), step('reviewer', rv, 'cross-review'), step('synthesizer', primary, 'primary synthesizes final answer')];
  return { ok: true, strategy: 'team', steps, notes, expectedCalls: steps.length + (workers.length > 1 ? 0 : 0) };
}
module.exports = { buildPlan };
