import { h, clear, state, GET, POST, PUT, PATCH, DEL, toast, errMsg, modal, confirmDialog, fmt, badge, stateBadge, skeleton, emptyState, field, sw, guard } from '../core.js';
import { t } from '../i18n.js';

const FILTERS = ['all', 'free', 'freemium', 'paid', 'enterprise', 'opensource', 'aggregator', 'custom', 'connected', 'disconnected'];
let data = { providers: [], connections: [] }, filter = 'all', q = '', sort = 'name', root;
export let goModels = () => {}; export const providersHooks = { set goModels(f) { goModels = f; } };

export async function renderProviders(el) {
  root = el; clear(el).append(skeleton(5));
  try { const [p, c] = await Promise.all([GET('/providers'), GET('/connections')]); data = { providers: p.providers, connections: c.connections }; } catch (e) { clear(el).append(emptyState(errMsg(e))); return; }
  draw();
}
const matches = (p) => {
  if (q && !(p.name + ' ' + p.id).toLowerCase().includes(q.toLowerCase())) return false;
  switch (filter) { case 'all': return true; case 'connected': return p.connected; case 'disconnected': return !p.connected; case 'custom': return p.custom; case 'aggregator': return (p.tags || []).includes('aggregator'); case 'opensource': return (p.tags || []).includes('opensource');
    default: return (p.classification || '').toLowerCase() === filter; }
};
function draw() {
  clear(root);
  const list = data.providers.filter(matches).sort((a, b) => sort === 'connected' ? (b.connected - a.connected) || a.name.localeCompare(b.name) : sort === 'models' ? b.discovered - a.discovered : a.name.localeCompare(b.name));
  root.append(h('div', { class: 'wrap' },
    h('div', { class: 'row', style: { marginBottom: '14px' } }, h('h2', { style: { margin: 0 } }, t('prov.title')), h('span', { class: 'grow' }), h('button', { class: 'btn primary', onclick: () => addKeyWizard() }, '＋ ', t('prov.addKey'))),
    data.connections.length ? h('section', null, h('h3', null, t('prov.connections')), h('div', { class: 'grid' }, data.connections.map(connCard))) : h('div', { class: 'empty' }, h('p', null, t('prov.noneYet')), h('button', { class: 'btn primary', onclick: () => addKeyWizard() }, t('prov.addKey'))),
    h('h3', { style: { marginTop: '26px' } }, t('prov.directory')), h('p', { class: 'muted sm' }, t('prov.classNote')),
    h('div', { class: 'row', style: { margin: '8px 0 12px' } }, h('input', { type: 'search', placeholder: t('common.search'), 'aria-label': t('common.search'), value: q, style: { maxWidth: '260px' }, oninput: (e) => { q = e.target.value; clearTimeout(draw.t); draw.t = setTimeout(() => { draw(); const i = root.querySelector('input[type=search]'); i.focus(); i.setSelectionRange(q.length, q.length); }, 200); } }),
      h('select', { 'aria-label': t('common.sort'), style: { width: 'auto' }, onchange: (e) => { sort = e.target.value; draw(); } }, ['name', 'connected', 'models'].map((s) => h('option', { value: s, selected: sort === s }, t('sort.' + s)))),
      FILTERS.map((f) => h('button', { class: 'chip', 'aria-pressed': String(filter === f), onclick: () => { filter = f; draw(); } }, t('filter.' + f)))),
    list.length ? h('div', { class: 'grid' }, list.map(providerCard)) : emptyState(t('common.noResults'))));
}
const provLogo = (p) => h('div', { 'aria-hidden': 'true', style: { width: '34px', height: '34px', borderRadius: '9px', background: 'var(--panel2)', border: '1px solid var(--border)', display: 'grid', placeItems: 'center', fontWeight: 700, color: 'var(--accent)' } }, p.name.slice(0, 2).toUpperCase());
function providerCard(p) {
  return h('div', { class: 'card' }, h('div', { class: 'row' }, provLogo(p), h('div', { class: 'grow' }, h('strong', null, p.name), h('div', { class: 'muted sm mono' }, p.id)), badge(p.connected ? 'CONNECTED' : 'UNKNOWN', p.connected ? t('prov.connected') : t('prov.disconnected'))),
    h('div', { class: 'row sm', style: { margin: '10px 0' } }, h('span', { class: 'badge' }, t('class.' + (p.classification || 'UNKNOWN'))), (p.tags || []).map((x) => h('span', { class: 'badge' }, x))),
    h('div', { class: 'kv sm', style: { gridTemplateColumns: 'repeat(3,1fr)' } }, h('div', null, h('span', { class: 'muted' }, t('prov.discovered')), h('b', null, fmt.num(p.discovered))), h('div', null, h('span', { class: 'muted' }, t('prov.healthy')), h('b', null, fmt.num(p.healthy))), h('div', null, h('span', { class: 'muted' }, t('prov.enabled')), h('b', null, fmt.num(p.enabled)))),
    h('div', { class: 'muted sm' }, t('prov.lastChecked') + ': ' + fmt.time(p.lastChecked)),
    h('div', { class: 'row', style: { marginTop: '12px' } }, h('button', { class: 'btn sm primary', onclick: () => addKeyWizard({ providerId: p.id }) }, t('prov.addKey')),
      p.connections ? h('button', { class: 'btn sm', onclick: () => goModels() }, t('prov.models')) : null,
      p.apiKeyUrl ? h('a', { class: 'btn sm', href: p.apiKeyUrl, target: '_blank', rel: 'noopener noreferrer' }, t('prov.getKey') + ' ↗') : null,
      p.documentationUrl ? h('a', { class: 'btn sm', href: p.documentationUrl, target: '_blank', rel: 'noopener noreferrer' }, t('prov.docs') + ' ↗') : null));
}
function connCard(c) {
  const s = c.stats; const act = guard(async (fn) => { await fn(); await renderProviders(root); });
  return h('div', { class: 'card' }, h('div', { class: 'row' }, h('div', { class: 'grow' }, h('strong', null, c.name), h('div', { class: 'muted sm' }, c.provider.name)), stateBadge(c.status === 'VALID' ? c.providerHealth : c.status)),
    h('div', { class: 'mono sm', style: { margin: '8px 0' }, dir: 'ltr' }, c.keyMask),
    h('div', { class: 'row sm' }, h('span', null, `${t('prov.discovered')}: ${s.discovered}`), h('span', null, `${t('prov.healthy')}: ${s.healthy}`), h('span', null, `${t('prov.failed')}: ${s.failed}`), h('span', null, `${t('prov.enabled')}: ${s.enabled}`)),
    h('div', { class: 'muted sm' }, `${t('prov.validated')}: ${fmt.time(c.lastValidatedAt)} · ${t('prov.lastChecked')}: ${fmt.time(c.lastHealthAt)}`), c.lastError ? h('div', { class: 'sm', style: { color: 'var(--bad)' } }, c.lastError) : null,
    h('div', { class: 'row', style: { marginTop: '10px' } },
      h('button', { class: 'btn sm', onclick: (e) => act(async () => { e.target.disabled = true; e.target.textContent = t('prov.testing'); const r = await POST(`/connections/${c.id}/test`, {}); toast(r.status === 'VALID' ? t('prov.testOk') : t('prov.testFail') + ': ' + (r.lastError || r.status), r.status === 'VALID' ? 'ok' : 'err'); }) }, t('prov.test')),
      h('button', { class: 'btn sm', onclick: () => goModels(c.id) }, t('prov.models')),
      h('button', { class: 'btn sm', onclick: () => { const i = h('input', { type: 'text', value: c.name }); const m = modal({ title: t('prov.rename'), body: [i, h('p', { class: 'muted sm' }, t('prov.renameNote'))], footer: h('button', { class: 'btn primary', onclick: () => act(async () => { await PATCH('/connections/' + c.id, { name: i.value }); m.close(); }) }, t('common.save')) }); } }, t('prov.rename')),
      h('button', { class: 'btn sm', onclick: () => { const i = h('input', { type: 'password', autocomplete: 'off', placeholder: t('prov.pasteKey') }); const m = modal({ title: t('prov.replaceKey'), body: [i, h('p', { class: 'muted sm' }, t('prov.replaceNote'))], footer: h('button', { class: 'btn primary', onclick: (e) => { e.target.disabled = true; act(async () => { try { await PUT(`/connections/${c.id}/key`, { apiKey: i.value }); toast(t('prov.keyReplaced'), 'ok'); m.close(); } catch (er) { e.target.disabled = false; throw er; } }); } }, t('common.save')) }); } }, t('prov.editKey')),
      h('button', { class: 'btn sm danger', onclick: async () => { if (await confirmDialog(t('prov.confirmDelete'))) act(() => DEL('/connections/' + c.id)); } }, t('common.delete'))));
}

/* ------------------------------------------------------------------ Add API Key wizard */
export function addKeyWizard(pre = {}) {
  const st = { step: 'input', preview: null, health: null, enabled: new Set(), manual: !!pre.providerId };
  const body = h('div'); const footer = h('div', { class: 'row', style: { width: '100%', justifyContent: 'flex-end' } });
  const m = modal({ title: t('wiz.title'), body, footer, wide: true, onClose: () => renderProviders(root) });
  const key = h('input', { type: 'password', autocomplete: 'off', spellcheck: 'false', dir: 'ltr', placeholder: t('wiz.pasteKey'), 'aria-label': t('wiz.pasteKey') });
  const provSel = h('select', { 'aria-label': t('wiz.provider') }, h('option', { value: 'auto' }, t('wiz.autoDetect')), data.providers.filter((p) => !p.custom || true).map((p) => h('option', { value: p.id, selected: pre.providerId === p.id }, p.name)), h('option', { value: '__custom' }, t('wiz.customProvider')), h('option', { value: '__openai' }, t('wiz.openaiCompat')));
  const cName = h('input', { type: 'text', placeholder: t('wiz.providerName') }), cUrl = h('input', { type: 'url', dir: 'ltr', placeholder: 'https://api.example.com/v1' });
  const cProto = h('select', null, ['openai-compatible', 'anthropic', 'gemini'].map((x) => h('option', { value: x }, x)));
  const custom = h('div', { hidden: true }, field(t('wiz.providerName'), cName), field(t('wiz.baseUrl'), cUrl), field(t('wiz.protocol'), cProto), h('p', { class: 'muted sm' }, t('wiz.httpsOnly')));
  const steps = h('div', { class: 'steps' }); const status = h('div'); const results = h('div');
  provSel.onchange = () => { custom.hidden = !['__custom', '__openai'].includes(provSel.value); cProto.parentElement; if (provSel.value === '__openai') cProto.value = 'openai-compatible'; };
  const setSteps = (cur, fail) => { clear(steps); ['detect', 'validate', 'discover', 'test'].forEach((k, i) => { const order = ['detect', 'validate', 'discover', 'test']; const ci = order.indexOf(cur); steps.append(h('span', { class: 'badge', dataset: { s: fail === k ? 'fail' : i < ci ? 'done' : i === ci ? 'run' : '' } }, (i < ci ? '✓ ' : fail === k ? '✗ ' : '') + t('wiz.step.' + k))); }); };
  const nameIn = h('input', { type: 'text', maxlength: 60 });

  function showInput(msg) {
    st.step = 'input'; clear(body).append(h('p', { class: 'muted' }, t('wiz.intro')), field(t('wiz.apiKey'), key), field(t('wiz.provider'), provSel, t('wiz.providerHint')), custom, steps, status, msg || null);
    clear(footer).append(h('button', { class: 'btn', onclick: () => m.close() }, t('common.cancel')), h('button', { class: 'btn primary', id: 'go', onclick: run }, t('wiz.detectValidate')));
    if (pre.providerId) custom.hidden = true;
  }
  async function run(e) {
    const btn = e.target; btn.disabled = true; clear(status); const k = key.value.trim(); if (!k) { toast(t('wiz.needKey'), 'err'); btn.disabled = false; return; }
    const payload = { apiKey: k }; const sel = provSel.value;
    if (sel === '__custom' || sel === '__openai') { payload.baseUrl = cUrl.value.trim(); payload.providerName = cName.value.trim(); payload.protocol = cProto.value; if (!payload.baseUrl) { toast(t('wiz.needUrl'), 'err'); btn.disabled = false; return; } } else if (sel !== 'auto') payload.providerId = sel;
    setSteps('detect');
    try {
      const pv = await POST('/connections/preview', payload); key.value = '';
      if (!pv.ok) { setSteps('validate', 'validate'); return showFail(pv, btn); }
      st.preview = pv; setSteps('test'); status.replaceChildren(h('p', null, t('wiz.testingModels', { n: pv.modelCount })));
      const hl = await POST(`/connections/preview/${pv.pendingId}/health`, {}); st.health = hl; setSteps('done'); showResults();
    } catch (er) { setSteps('validate', 'validate'); status.replaceChildren(h('p', { style: { color: 'var(--bad)' } }, errMsg(er))); btn.disabled = false; }
  }
  function showFail(pv, btn) {
    btn.disabled = false;
    if (pv.status === 'UNKNOWN_PROVIDER') status.replaceChildren(h('div', { class: 'card', style: { borderColor: 'var(--warn)' } }, h('strong', null, t('wiz.unknown')), h('p', { class: 'muted' }, pv.reason === 'no_matching_format' ? t('wiz.unknownNoMatch') : t('wiz.unknownNoConfirm')), pv.attempted && pv.attempted.length ? h('p', { class: 'sm' }, t('wiz.contacted') + ': ' + pv.attempted.map((a) => `${a.id} (${a.result})`).join(', ')) : h('p', { class: 'sm' }, t('wiz.notSent')),
      h('p', null, t('wiz.unknownOptions')), h('div', { class: 'row' }, h('button', { class: 'btn', onclick: () => { provSel.focus(); } }, '1 · ' + t('wiz.opt1')), h('button', { class: 'btn', onclick: () => { provSel.value = '__custom'; provSel.onchange(); cUrl.focus(); } }, '2 · ' + t('wiz.opt2')), h('button', { class: 'btn', onclick: () => { provSel.value = '__openai'; provSel.onchange(); cUrl.focus(); } }, '3 · ' + t('wiz.opt3')))));
    else status.replaceChildren(h('p', { style: { color: 'var(--bad)' } }, `${pv.provider ? pv.provider.name + ': ' : ''}${pv.status === 'AUTH_FAILED' ? t('wiz.authFailed') : t('wiz.validationFailed')} — ${pv.error || ''}`));
  }
  function showResults() {
    const pv = st.preview, hl = st.health, s = hl.summary; st.step = 'results';
    const healthy = pv.models.filter((x) => hl.models[x.modelId] && hl.models[x.modelId].state === 'HEALTHY'); st.enabled = new Set(); nameIn.value = `${pv.provider.name} #${data.connections.filter((c) => c.providerId === pv.provider.id).length + 1}`;
    const rows = pv.models.map((x) => { const hs = hl.models[x.modelId] || { state: 'UNKNOWN' }; const cb = h('input', { type: 'checkbox', 'aria-label': x.modelId, checked: false, onchange: (e) => { e.target.checked ? st.enabled.add(x.modelId) : st.enabled.delete(x.modelId); count.textContent = st.enabled.size; } });
      return h('tr', null, h('td', null, cb), h('td', null, h('strong', null, x.name), h('div', { class: 'muted sm mono' }, x.modelId)), h('td', null, stateBadge(hs.state), hs.error && hs.state !== 'HEALTHY' ? h('div', { class: 'muted sm' }, hs.error.slice(0, 80)) : null), h('td', null, fmt.ms(hs.latencyMs)), h('td', null, capChips(x.capabilities)), h('td', null, x.contextWindow ? fmt.num(x.contextWindow) : t('common.unknown'))); });
    const count = h('b', null, '0');
    clear(body).append(h('div', { class: 'kv' }, kv(t('wiz.provider'), pv.provider.name), kv(t('wiz.confidence'), pv.detection.confidence), kv(t('wiz.auth'), t('state.VALID')), kv(t('wiz.found'), pv.modelCount), kv(t('wiz.healthyN'), s.healthy), kv(t('wiz.degradedN'), s.degraded), kv(t('wiz.unavailableN'), s.unavailable + s.timeout + s.rateLimited + s.authFailed), kv(t('wiz.untestedN'), s.unknown)),
      pv.detection.method === 'auto-detect' ? h('p', { class: 'muted sm' }, t('wiz.detectedVia', { list: (pv.detection.attempted || []).map((a) => a.id).join(', ') })) : null,
      field(t('wiz.connName'), nameIn, t('wiz.connNameHint')), h('div', { class: 'row', style: { margin: '10px 0' } }, h('strong', null, t('wiz.chooseModels')), h('span', { class: 'muted sm' }, t('wiz.chooseHint')), h('span', { class: 'grow' }), h('button', { class: 'btn sm', onclick: () => { healthy.forEach((x) => st.enabled.add(x.modelId)); body.querySelectorAll('tbody input').forEach((c, i) => { c.checked = st.enabled.has(pv.models[i].modelId); }); count.textContent = st.enabled.size; } }, t('wiz.selectHealthy')), h('span', null, t('wiz.selected') + ': ', count)),
      h('div', { class: 'tablewrap', style: { maxHeight: '38vh' } }, h('table', null, h('thead', null, h('tr', null, h('th'), h('th', null, t('models.model')), h('th', null, t('models.health')), h('th', null, t('models.latency')), h('th', null, t('models.caps')), h('th', null, t('models.context')))), h('tbody', null, rows))));
    clear(footer).append(h('button', { class: 'btn', onclick: () => m.close() }, t('common.cancel')), h('button', { class: 'btn primary', onclick: async (e) => { e.target.disabled = true; try { await POST('/connections', { pendingId: pv.pendingId, name: nameIn.value, enableModelIds: [...st.enabled] }); toast(t('wiz.saved'), 'ok'); m.close(); } catch (er) { toast(errMsg(er), 'err'); e.target.disabled = false; } } }, t('wiz.save')));
  }
  showInput();
}
const kv = (k, v) => h('div', { class: 'card' }, h('span', { class: 'muted sm' }, k), h('b', { style: { fontSize: '17px' } }, String(v)));
export function capChips(c) {
  const names = ['chat', 'vision', 'audioInput', 'audioOutput', 'imageGeneration', 'toolCalling', 'streaming', 'structuredOutput', 'embeddings'];
  const known = names.filter((n) => c[n] === true || c[n] === 'declared');
  const unknown = names.filter((n) => c[n] === 'unknown');
  return [...known.map((n) => h('span', { class: 'cap ' + (c[n] === true ? 't' : 'd'), title: c[n] === true ? t('cap.confirmed') : t('cap.declared') }, t('cap.' + n) + (c[n] === 'declared' ? ' *' : ''))),
    unknown.length ? h('span', { class: 'cap u', title: t('cap.unknown') + ': ' + unknown.map((n) => t('cap.' + n)).join(', ') }, t('cap.unknownGroup', { n: unknown.length })) : null];
}
