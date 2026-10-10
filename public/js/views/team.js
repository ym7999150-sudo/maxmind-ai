import { h, clear, state, GET, PUT, toast, errMsg, fmt, stateBadge, skeleton, emptyState, field, sw, guard } from '../core.js';
import { t } from '../i18n.js';

const W = ['capability', 'userPreference', 'expertise', 'health', 'performance', 'cost', 'latency', 'history'];
export async function renderTeam(root) {
  clear(root).append(skeleton(5)); let models, agents;
  try { [{ models }, { agents }] = await Promise.all([GET('/models'), GET('/agents')]); } catch (e) { clear(root).append(emptyState(errMsg(e))); return; }
  const s = JSON.parse(JSON.stringify(state.settings)); const usable = models.filter((m) => m.profile.enabled && m.health.state === 'HEALTHY' && m.connectionStatus === 'VALID');
  const save = guard(async () => { state.settings = await PUT('/settings', { team: s.team, router: s.router, chat: { mode: s.chat.mode } }); toast(t('common.saved'), 'ok'); });
  const num = (obj, k, min, max) => h('input', { type: 'number', min, max, value: obj[k], onchange: (e) => { obj[k] = Math.min(max, Math.max(min, +e.target.value)); e.target.value = obj[k]; } });
  const modelOpt = (sel) => [h('option', { value: '' }, '—'), usable.map((m) => h('option', { value: m.key, selected: sel === m.key }, `${m.providerName} · ${m.connectionName} · ${m.modelId}`))];
  const teamRows = h('div'); const drawTeam = () => { clear(teamRows); s.team.selectedTeam.forEach((r, i) => teamRows.append(h('div', { class: 'row', style: { marginBottom: '6px' } }, h('select', { style: { flex: 1 }, onchange: (e) => { r.key = e.target.value; } }, modelOpt(r.key)), h('select', { style: { width: '160px' }, onchange: (e) => { r.role = e.target.value; } }, ['worker', 'coder', 'analyst', 'researcher', 'writer', 'specialist', 'reviewer', 'synthesizer'].map((x) => h('option', { value: x, selected: r.role === x }, t('role.' + x) !== 'role.' + x ? t('role.' + x) : x))), h('button', { class: 'btn sm danger', onclick: () => { s.team.selectedTeam.splice(i, 1); drawTeam(); } }, '✕')))); }; drawTeam();
  const wsum = () => W.reduce((a, k) => a + (+s.router.weights[k] || 0), 0);
  const wOut = h('span', { class: 'muted sm' }); const wRows = W.map((k) => { const out = h('b', null, String(s.router.weights[k])); const e = h('input', { type: 'range', min: 0, max: 100, step: 1, value: s.router.weights[k], 'aria-label': t('w.' + k), oninput: () => { s.router.weights[k] = +e.value; out.textContent = e.value; wOut.textContent = t('team.weightsSum', { n: wsum() }); } }); return h('div', null, h('label', { class: 'f' }, t('w.' + k), ' ', out), e); }); wOut.textContent = t('team.weightsSum', { n: wsum() });
  clear(root).append(h('div', { class: 'wrap' }, h('h2', null, t('team.title')), h('p', { class: 'muted' }, t('team.intro')),
    h('div', { class: 'card' }, h('h3', { style: { marginTop: 0 } }, t('team.mode')),
      h('div', { class: 'row' }, ['automatic', 'manual', 'hybrid'].map((m) => h('label', { class: 'row' }, h('input', { type: 'radio', name: 'tm', checked: s.team.teamMode === m, onchange: () => { s.team.teamMode = m; } }), h('span', null, h('strong', null, t('team.' + m)), h('div', { class: 'muted sm' }, t('team.' + m + 'Hint')))))),
      h('div', { class: 'grid', style: { marginTop: '12px' } }, field(t('team.maxSize'), num(s.team, 'maxTeamSize', 1, 6), t('team.maxSizeHint')), field(t('team.maxCalls'), num(s.team, 'maxCalls', 1, 10), t('team.maxCallsHint'))),
      h('div', { class: 'row', style: { marginTop: '10px' } }, h('label', { class: 'row' }, sw(s.team.multiModel, (v) => { s.team.multiModel = v; }, t('team.multi')), t('team.multi')), h('label', { class: 'row' }, sw(s.team.reviewOnMedium, (v) => { s.team.reviewOnMedium = v; }, t('team.reviewMedium')), t('team.reviewMedium'))),
      h('p', { class: 'muted sm' }, t('team.strategyHint'))),
    h('div', { class: 'card', style: { marginTop: '14px' } }, h('h3', { style: { marginTop: 0 } }, t('team.chatModes')), h('p', { class: 'muted sm' }, t('team.chatModesHint')),
      field(t('team.defaultMode'), h('select', { onchange: (e) => { s.chat.mode = e.target.value; } }, ['auto', 'smart', 'manual', 'team'].map((m) => h('option', { value: m, selected: s.chat.mode === m }, t('mode.' + m) + ' — ' + t('modeHint.' + m))))),
      field(t('team.manualModel'), h('select', { onchange: (e) => { s.team.manualModelKey = e.target.value || null; } }, modelOpt(s.team.manualModelKey))),
      h('label', { class: 'f' }, t('team.selectedTeam')), teamRows, h('button', { class: 'btn sm', onclick: () => { if (s.team.selectedTeam.length < 8) { s.team.selectedTeam.push({ key: '', role: 'worker' }); drawTeam(); } } }, '＋ ' + t('team.addMember'))),
    h('div', { class: 'card', style: { marginTop: '14px' } }, h('h3', { style: { marginTop: 0 } }, t('team.weights')), h('p', { class: 'muted sm' }, t('team.weightsHint')), h('div', { class: 'grid' }, wRows), h('div', { class: 'row', style: { marginTop: '8px' } }, wOut, h('button', { class: 'btn sm', onclick: () => { Object.assign(s.router.weights, { capability: 30, userPreference: 20, expertise: 15, health: 10, performance: 10, cost: 5, latency: 5, history: 5 }); renderTeamKeep(); } }, t('team.resetWeights')))),
    h('div', { class: 'row', style: { margin: '14px 0' } }, h('button', { class: 'btn primary', onclick: () => save().then(() => renderTeam(root)) }, t('common.save'))),
    h('h3', null, t('team.agents')), h('p', { class: 'muted sm' }, t('team.agentsHint')), h('div', { class: 'grid' }, agents.map((a) => h('div', { class: 'card' }, h('div', { class: 'row' }, h('strong', { class: 'grow' }, t('agent.' + a.id)), stateBadge(a.state)), h('div', { class: 'muted sm' }, a.detail))))));
  function renderTeamKeep() { state.settings.router.weights = { ...s.router.weights }; renderTeam(root); }
}
