import { h, clear, state, GET, POST, PATCH, PUT, DEL, toast, errMsg, modal, confirmDialog, fmt, skeleton, emptyState, sw, guard } from '../core.js';
import { t } from '../i18n.js';
export async function renderMemory(root) {
  clear(root).append(skeleton(4)); let d; try { d = await GET('/memory'); } catch (e) { clear(root).append(emptyState(errMsg(e))); return; }
  const re = () => renderMemory(root); const inp = h('input', { type: 'text', dir: 'auto', maxlength: 500, placeholder: t('mem.addPh') });
  const add = guard(async () => { if (!inp.value.trim()) return; await POST('/memory', { content: inp.value }); await re(); });
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });
  clear(root).append(h('div', { class: 'wrap' }, h('h2', null, t('mem.title')), h('p', { class: 'muted' }, t('mem.intro')),
    h('div', { class: 'card' }, h('div', { class: 'row' }, h('strong', null, t('mem.userMemory')), h('span', { class: 'grow' }), h('label', { class: 'row' }, t('mem.enabled'), sw(d.enabled, guard(async (v) => { state.settings = await PUT('/settings', { memory: { enabled: v } }); }), t('mem.enabled')))), h('p', { class: 'muted sm' }, t('mem.sensitive'))),
    h('div', { class: 'row', style: { margin: '14px 0' } }, inp, h('button', { class: 'btn primary', onclick: add }, t('common.add')), d.items.length ? h('button', { class: 'btn danger', onclick: async () => { if (await confirmDialog(t('mem.confirmClear'))) { await DEL('/memory'); re(); } } }, t('mem.clear')) : null),
    d.items.length ? h('div', { class: 'tablewrap' }, h('table', null, h('tbody', null, d.items.map((i) => h('tr', null, h('td', { dir: 'auto' }, i.content, h('div', { class: 'muted sm' }, `${i.source === 'chat' ? t('mem.fromChat') : t('mem.manual')} · ${fmt.time(i.createdAt)}`)), h('td', { style: { width: '170px' } }, h('button', { class: 'btn sm', onclick: () => { const ta = h('textarea', { rows: 3, dir: 'auto' }); ta.value = i.content; const m = modal({ title: t('common.edit'), body: ta, footer: h('button', { class: 'btn primary', onclick: guard(async () => { await PATCH('/memory/' + i.id, { content: ta.value }); m.close(); re(); }) }, t('common.save')) }); } }, t('common.edit')), ' ', h('button', { class: 'btn sm danger', onclick: guard(async () => { await DEL('/memory/' + i.id); re(); }) }, t('common.delete')))))))) : emptyState(t('mem.empty')),
    h('p', { class: 'muted sm' }, t('mem.convNote'))));
}
