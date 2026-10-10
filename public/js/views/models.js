import { h, clear, GET, PATCH, toast, errMsg, modal, fmt, badge, stateBadge, skeleton, emptyState, field, sw, guard, state } from '../core.js';
import { t } from '../i18n.js';
import { capChips } from './providers.js';

const ROLES = ['', 'planner', 'researcher', 'coder', 'analyst', 'critic', 'vision', 'document', 'synthesizer', 'writer', 'generalist'];
const CAPS = ['vision', 'audioInput', 'imageGeneration', 'toolCalling', 'streaming', 'structuredOutput'];
let models = [], f = { conn: '', status: '', enabled: '', q: '' }, root, conns = [];

export async function renderModels(el, preset = {}) {
  root = el; if (preset.connectionId !== undefined) f.conn = preset.connectionId || ''; clear(el).append(skeleton(6));
  try { const [m, c] = await Promise.all([GET('/models'), GET('/connections')]); models = m.models; conns = c.connections; } catch (e) { clear(el).append(emptyState(errMsg(e))); return; }
  draw();
}
function draw() {
  clear(root);
  const list = models.filter((m) => (!f.conn || m.connectionId === f.conn) && (!f.status || m.health.state === f.status) && (f.enabled === '' || String(m.profile.enabled) === f.enabled) && (!f.q || (m.modelId + m.name + m.providerName).toLowerCase().includes(f.q.toLowerCase())));
  const en = models.filter((m) => m.profile.enabled).length, hy = models.filter((m) => m.health.state === 'HEALTHY').length, usable = models.filter((m) => m.profile.enabled && m.health.state === 'HEALTHY' && m.connectionStatus === 'VALID').length;
  root.append(h('div', { class: 'wrap' }, h('div', { class: 'row', style: { marginBottom: '8px' } }, h('h2', { style: { margin: 0 } }, t('models.title'))),
    h('p', { class: 'muted' }, t('models.intro')),
    h('div', { class: 'kv', style: { marginBottom: '14px' } }, kvc(t('models.total'), models.length), kvc(t('models.healthy'), hy), kvc(t('models.enabled'), en), kvc(t('models.usable'), usable)),
    h('div', { class: 'row', style: { marginBottom: '10px' } }, h('input', { type: 'search', placeholder: t('common.search'), value: f.q, 'aria-label': t('common.search'), style: { maxWidth: '240px' }, oninput: (e) => { f.q = e.target.value; clearTimeout(draw.t); draw.t = setTimeout(() => { draw(); const i = root.querySelector('input[type=search]'); i.focus(); i.setSelectionRange(f.q.length, f.q.length); }, 200); } }),
      h('select', { style: { width: 'auto' }, 'aria-label': t('models.connection'), onchange: (e) => { f.conn = e.target.value; draw(); } }, h('option', { value: '' }, t('models.allConns')), conns.map((c) => h('option', { value: c.id, selected: f.conn === c.id }, `${c.name} (${c.provider.name})`))),
      h('select', { style: { width: 'auto' }, 'aria-label': t('models.health'), onchange: (e) => { f.status = e.target.value; draw(); } }, h('option', { value: '' }, t('models.anyHealth')), ['HEALTHY', 'DEGRADED', 'RATE_LIMITED', 'AUTH_FAILED', 'UNAVAILABLE', 'TIMEOUT', 'UNKNOWN'].map((s) => h('option', { value: s, selected: f.status === s }, t('state.' + s)))),
      h('select', { style: { width: 'auto' }, 'aria-label': t('models.enabledCol'), onchange: (e) => { f.enabled = e.target.value; draw(); } }, h('option', { value: '' }, t('models.anyEnabled')), h('option', { value: 'true', selected: f.enabled === 'true' }, t('models.onlyEnabled')), h('option', { value: 'false', selected: f.enabled === 'false' }, t('models.onlyDisabled'))),
      h('span', { class: 'grow' }), h('button', { class: 'btn sm', onclick: () => bulk(list, true) }, t('models.enableShown')), h('button', { class: 'btn sm', onclick: () => bulk(list, false) }, t('models.disableShown'))),
    list.length ? h('div', { class: 'tablewrap' }, h('table', null, h('thead', null, h('tr', null, ['models.enabledCol', 'models.provider', 'models.model', 'models.health', 'models.caps', 'models.context', 'models.modalities', 'models.cost', 'models.checked', ''].map((k) => h('th', null, k ? t(k) : '')))),
      h('tbody', null, list.map(row)))) : emptyState(models.length ? t('common.noResults') : t('models.empty'))));
}
const kvc = (k, v) => h('div', { class: 'card' }, h('span', { class: 'muted sm' }, k), h('b', null, fmt.num(v)));
const bulk = guard(async (list, on) => { for (const m of list.filter((x) => x.profile.enabled !== on)) await PATCH('/models/' + m.key, { enabled: on }); await renderModels(root); });
function row(m) {
  const flags = Object.keys(m.profile.flags || {}).filter((k) => m.profile.flags[k]);
  return h('tr', null,
    h('td', null, sw(m.profile.enabled, guard(async (on, el) => { try { await PATCH('/models/' + m.key, { enabled: on }); m.profile.enabled = on; toast(on ? t('models.nowEnabled') : t('models.nowDisabled'), 'ok'); } catch (e) { el.checked = !on; throw e; } }), t('models.enabledCol'))),
    h('td', null, h('div', null, m.providerName), h('div', { class: 'muted sm' }, m.connectionName), h('div', { class: 'muted sm mono', dir: 'ltr' }, m.keyMask)),
    h('td', null, h('strong', null, m.name !== m.modelId ? m.name : m.modelId), h('div', { class: 'muted sm mono', dir: 'ltr' }, m.modelId), flags.map((x) => h('span', { class: 'badge', style: { marginInlineEnd: '3px' } }, t('flag.' + x)))),
    h('td', null, stateBadge(m.health.state), m.health.error && m.health.state !== 'HEALTHY' ? h('div', { class: 'muted sm', title: m.health.error }, m.health.error.slice(0, 60)) : null, m.health.latencyMs ? h('div', { class: 'muted sm' }, fmt.ms(m.health.latencyMs)) : null),
    h('td', null, capChips({ ...m.capabilities, ...Object.fromEntries(Object.keys(m.profile.capabilityOverrides || {}).filter((k) => m.profile.capabilityOverrides[k]).map((k) => [k, 'declared'])) }), m.kind && m.kind !== 'chat' ? h('span', { class: 'cap d', title: m.kindSource }, m.kind) : null),
    h('td', null, m.contextWindow ? fmt.num(m.contextWindow) : t('common.unknown')),
    h('td', { class: 'sm' }, (m.inputModalities || []).join(', ') || t('common.unknown'), ' → ', (m.outputModalities || []).join(', ') || t('common.unknown')),
    h('td', { class: 'sm' }, fmt.price(m.pricing)), h('td', { class: 'sm' }, fmt.time(m.health.checkedAt)),
    h('td', null, h('button', { class: 'btn sm', onclick: () => profileDialog(m) }, t('models.profile'))));
}

export function profileDialog(m) {
  const p = JSON.parse(JSON.stringify(m.profile)); const ta = (k, rows = 2) => { const e = h('textarea', { rows, dir: 'auto', maxlength: 1000, oninput: () => { p[k] = e.value; } }); e.value = p[k] || ''; return e; };
  const sl = (k) => { const out = h('b', null, String(p[k])); const e = h('input', { type: 'range', min: 0, max: 10, step: 1, value: p[k], 'aria-label': t('prof.' + k), oninput: () => { p[k] = +e.value; out.textContent = e.value; } }); return h('div', null, h('label', { class: 'f' }, t('prof.' + k), ' ', out), e, h('div', { class: 'muted sm' }, t('prof.' + k + 'Hint'))); };
  const tags = h('input', { type: 'text', dir: 'auto', value: (p.tasks || []).join(', '), placeholder: t('prof.tasksPh'), oninput: (e) => { p.tasks = e.target.value.split(',').map((s) => s.trim()).filter(Boolean); } });
  const role = h('select', { onchange: (e) => { p.role = e.target.value; } }, ROLES.map((r) => h('option', { value: r, selected: p.role === r }, r ? t('role.' + r) : t('role.none'))));
  const flagBox = ['preferred', 'primary', 'reviewer', 'specialist', 'backup'].map((k) => h('label', { class: 'row sm' }, h('input', { type: 'checkbox', checked: !!p.flags[k], onchange: (e) => { p.flags[k] = e.target.checked; } }), t('flag.' + k)));
  const capBox = CAPS.map((k) => h('label', { class: 'row sm' }, h('input', { type: 'checkbox', checked: !!p.capabilityOverrides[k], onchange: (e) => { p.capabilityOverrides[k] = e.target.checked; } }), t('cap.' + k), m.capabilities[k] === true ? h('span', { class: 'muted' }, ' (' + t('cap.confirmed') + ')') : ''));
  const body = h('div', null, h('p', { class: 'muted sm' }, `${m.providerName} · ${m.connectionName} · `, h('span', { class: 'mono' }, m.modelId)), h('p', { class: 'sm' }, t('prof.affects')),
    h('div', { class: 'row' }, h('label', { class: 'row' }, t('models.enabledCol'), sw(p.enabled, (v) => { p.enabled = v; }, t('models.enabledCol')))),
    field(t('prof.role'), role), field(t('prof.strengths'), ta('strengths')), field(t('prof.weaknesses'), ta('weaknesses')), field(t('prof.bestFor'), ta('bestFor')), field(t('prof.avoidFor'), ta('avoidFor')), field(t('prof.tasks'), tags),
    h('div', { class: 'grid', style: { marginTop: '12px' } }, ['reasoning', 'creativity', 'accuracy', 'speed', 'cost', 'trust'].map(sl)),
    h('h4', null, t('prof.flags')), h('div', { class: 'row' }, flagBox), h('h4', null, t('prof.declare')), h('p', { class: 'muted sm' }, t('prof.declareHint')), h('div', { class: 'row' }, capBox), field(t('prof.notes'), ta('notes', 3)));
  const md = modal({ title: t('models.profile'), body, wide: true, footer: [h('button', { class: 'btn', onclick: () => md.close() }, t('common.cancel')), h('button', { class: 'btn primary', onclick: guard(async (e) => { e.target.disabled = true; try { await PATCH('/models/' + m.key, p); toast(t('common.saved'), 'ok'); md.close(); await renderModels(root); } catch (er) { e.target.disabled = false; throw er; } }) }, t('common.save'))] });
}
