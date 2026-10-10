import { h, clear, GET, errMsg, fmt, stateBadge, skeleton, emptyState } from '../core.js';
import { t } from '../i18n.js';
let timer = null;
export function stopMonitor() { clearInterval(timer); timer = null; }
export async function renderMonitor(root) {
  stopMonitor(); let days = 7;
  const draw = async (first) => {
    if (first) clear(root).append(skeleton(5)); let d; try { d = await GET('/monitor?days=' + days); } catch (e) { clear(root).append(emptyState(errMsg(e))); return; }
    const r = d.requests, c = d.modelCalls; const max = Math.max(1, ...d.daily.map((x) => x.t || 0));
    clear(root).append(h('div', { class: 'wrap' }, h('div', { class: 'row' }, h('h2', { class: 'grow' }, t('mon.title')), h('select', { style: { width: 'auto' }, 'aria-label': t('mon.window'), onchange: (e) => { days = +e.target.value; draw(true); } }, [1, 7, 30, 90].map((x) => h('option', { value: x, selected: days === x }, t('mon.lastDays', { n: x }))))), h('p', { class: 'muted sm' }, t('mon.real')),
      h('div', { class: 'kv' }, k(t('mon.requests'), fmt.num(r.total)), k(t('mon.tokens'), fmt.num(r.tokens.total), `${fmt.num(r.tokens.input)} in / ${fmt.num(r.tokens.output)} out`), k(t('mon.cost'), r.estimatedCost == null ? t('common.unknown') : fmt.cost(r.estimatedCost), t('mon.costNote')), k(t('mon.cacheRate'), Math.round(r.cacheHitRate * 100) + '%', `${r.cacheHits} ${t('mon.hits')}`), k(t('mon.latency'), fmt.ms(r.avgLatencyMs)), k(t('mon.calls'), fmt.num(c.total), `${c.ok} ok`), k(t('mon.failures'), fmt.num(c.failures)), k(t('mon.rateLimits'), fmt.num(c.rateLimited))),
      r.estimatedTokenRequests ? h('p', { class: 'muted sm' }, t('mon.estimatedNote', { n: r.estimatedTokenRequests })) : null,
      h('h3', null, t('mon.providers')), d.providers.length ? h('div', { class: 'tablewrap' }, h('table', null, h('thead', null, h('tr', null, ['mon.connection', 'mon.provider', 'models.health', 'prov.discovered', 'prov.healthy', 'prov.enabled', 'prov.lastChecked'].map((x) => h('th', null, t(x))))), h('tbody', null, d.providers.map((p) => h('tr', null, h('td', null, p.name), h('td', null, p.provider), h('td', null, stateBadge(p.status === 'VALID' ? p.health : p.status)), h('td', null, p.stats.discovered), h('td', null, p.stats.healthy), h('td', null, p.stats.enabled), h('td', null, fmt.time(p.lastHealthAt))))))) : emptyState(t('mon.noProviders')),
      h('h3', null, t('mon.modelHealth')), h('div', { class: 'row' }, Object.entries(d.modelHealth).map(([s, n]) => h('span', { class: 'row' }, stateBadge(s), h('b', null, n)))),
      h('h3', null, t('mon.agents')), h('div', { class: 'row' }, d.agents.map((a) => h('span', { class: 'row', title: a.detail }, stateBadge(a.state), t('agent.' + a.id)))),
      h('h3', null, t('mon.daily')), d.daily.length ? h('div', { class: 'card' }, h('div', { class: 'bars' }, d.daily.map((x) => h('div', { style: { height: Math.max(2, ((x.t || 0) / max) * 100) + '%' }, title: `${x.d}: ${fmt.num(x.t)} ${t('det.tokens')} / ${x.n} ${t('mon.requests')}` }, h('small', null, x.d.slice(5)))))) : emptyState(t('mon.noData')),
      h('h3', { style: { marginTop: '28px' } }, t('mon.perModel')), d.perModel.length ? h('div', { class: 'tablewrap' }, h('table', null, h('thead', null, h('tr', null, ['models.model', 'mon.calls', 'mon.success', 'mon.latency', 'mon.in', 'mon.out'].map((x) => h('th', null, t(x))))), h('tbody', null, d.perModel.map((m) => h('tr', null, h('td', null, m.label), h('td', null, m.calls), h('td', null, `${m.success}/${m.calls}`), h('td', null, fmt.ms(m.avgLatencyMs)), h('td', null, fmt.num(m.inputTokens)), h('td', null, fmt.num(m.outputTokens))))))) : emptyState(t('mon.noData')),
      h('h3', null, t('mon.errors')), d.errors.length ? h('div', { class: 'tablewrap' }, h('table', null, h('tbody', null, d.errors.map((e) => h('tr', null, h('td', null, fmt.time(e.at)), h('td', null, stateBadge(e.status === 'RATE_LIMITED' ? 'RATE_LIMITED' : e.status === 'AUTH_FAILED' ? 'AUTH_FAILED' : e.status === 'TIMEOUT' ? 'TIMEOUT' : 'UNAVAILABLE')), h('td', { class: 'mono' }, e.model || '—'), h('td', null, e.role), h('td', { class: 'sm' }, e.error || ''))))) ) : emptyState(t('mon.noErrors'))));
  };
  await draw(true); timer = setInterval(() => draw(false), 20000);
}
const k = (a, b, sub) => h('div', { class: 'card' }, h('span', { class: 'muted sm' }, a), h('b', null, b), sub ? h('span', { class: 'muted sm' }, sub) : null);
