import { h, $, clear, state, GET, POST, PATCH, DEL, toast, errMsg, applyTheme, confirmDialog, modal, downloadAuthed, field, guard } from './core.js';
import { t, setLang, initLang, getLang, LANGS } from './i18n.js';
import { renderChat, openChat, newChat, chatHooks } from './views/chat.js';
import { renderProviders, providersHooks, addKeyWizard } from './views/providers.js';
import { renderModels } from './views/models.js';
import { renderTeam } from './views/team.js';
import { renderMap } from './views/map.js';
import { renderMonitor, stopMonitor } from './views/monitor.js';
import { renderMemory } from './views/memory.js';
import { renderSettings } from './views/settings.js';

const root = $('#root');
const VIEWS = [['chat', '💬'], ['providers', '🔌'], ['models', '🧩'], ['team', '👥'], ['map', '🕸️'], ['monitor', '📈'], ['memory', '🧠'], ['settings', '⚙️']];
let chatsBox, content, titleEl, chatQuery = '', showArchived = false;

window.addEventListener('mm:unauth', () => { if (state.user) { state.user = null; boot(); } });
window.addEventListener('mm:pwchange', () => boot());
window.addEventListener('hashchange', () => { if (state.user) show(location.hash.replace('#/', '') || 'chat'); });
matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => state.settings && state.settings.theme === 'system' && applyTheme(state.settings));

async function boot() {
  initLang(); let me;
  try { me = await GET('/auth/me'); } catch { return loginScreen(); }
  state.user = me.user; state.csrf = me.csrf; state.settings = me.settings; state.mockMode = me.mockMode;
  await setLang(state.settings.language, { persist: true }); applyTheme(state.settings);
  if (me.user.mustChangePassword) return pwScreen(); shell();
}
const langSwitch = () => h('select', { 'aria-label': 'Language', style: { width: 'auto' }, onchange: async (e) => { await setLang(e.target.value); if (state.user) { try { state.settings = await (await import('./core.js')).PUT('/settings', { language: e.target.value }); } catch { /* ignore */ } shell(); } else loginScreen(); } }, LANGS.map((l) => h('option', { value: l.id, selected: getLang() === l.id }, l.name)));
const brand = () => h('div', { class: 'brand' }, h('img', { src: '/logo.svg', alt: '' }), h('div', null, 'MAXMIND AI', h('small', null, t('app.tagline'))));

function loginScreen() {
  state.user = null; const u = h('input', { type: 'text', value: 'admin', autocomplete: 'username', 'aria-label': t('auth.username') }), p = h('input', { type: 'password', autocomplete: 'current-password', 'aria-label': t('auth.password') }); const err = h('div', { class: 'sm', style: { color: 'var(--bad)', minHeight: '20px' }, role: 'alert' });
  const go = async () => { err.textContent = ''; try { const r = await POST('/auth/login', { username: u.value, password: p.value }); state.csrf = r.csrf; await boot(); } catch (e) { err.textContent = errMsg(e); } };
  p.addEventListener('keydown', (e) => e.key === 'Enter' && go());
  clear(root).append(h('div', { class: 'auth' }, h('div', { class: 'card' }, h('div', { class: 'row' }, h('img', { src: '/logo.svg', width: 44, height: 44, alt: '' }), h('span', { class: 'grow' }), langSwitch()), h('h1', null, 'MAXMIND AI'), h('p', { class: 'muted' }, t('auth.subtitle')), field(t('auth.username'), u), field(t('auth.password'), p), err, h('button', { class: 'btn primary', style: { width: '100%', justifyContent: 'center' }, onclick: go }, t('auth.signIn')), h('p', { class: 'muted sm' }, t('auth.firstTime')))));
  p.focus();
}
function pwScreen() {
  const c = h('input', { type: 'password', autocomplete: 'current-password' }), n = h('input', { type: 'password', autocomplete: 'new-password' }), n2 = h('input', { type: 'password', autocomplete: 'new-password' }); const err = h('div', { class: 'sm', role: 'alert', style: { color: 'var(--bad)', minHeight: '20px' } });
  const go = async () => { err.textContent = ''; if (n.value !== n2.value) { err.textContent = t('auth.mismatch'); return; } try { await POST('/auth/change-password', { currentPassword: c.value, newPassword: n.value }); toast(t('set.pwChanged'), 'ok'); await POST('/auth/logout', {}).catch(() => {}); state.user = null; loginScreen(); } catch (e) { err.textContent = errMsg(e); } };
  clear(root).append(h('div', { class: 'auth' }, h('div', { class: 'card' }, h('h1', null, t('auth.mustChange')), h('p', { class: 'muted' }, t('auth.mustChangeNote')), field(t('set.currentPw'), c), field(t('set.newPw'), n, t('set.pwRules')), field(t('auth.confirmPw'), n2), err, h('div', { class: 'row', style: { marginTop: '12px' } }, h('button', { class: 'btn primary', onclick: go }, t('set.changePw')), h('button', { class: 'btn', onclick: async () => { await POST('/auth/logout', {}).catch(() => {}); loginScreen(); } }, t('auth.signOut'))))));
}

function shell() {
  const side = h('aside', { class: 'side', id: 'side' }, brand(),
    h('nav', { class: 'nav', 'aria-label': 'Main' }, VIEWS.map(([id, ico]) => h('button', { dataset: { view: id }, onclick: () => { location.hash = '#/' + id; $('#side').classList.remove('open'); } }, h('span', { 'aria-hidden': 'true' }, ico), t('nav.' + id)))),
    h('div', { class: 'chats' }, h('div', { class: 'row', style: { marginBottom: '8px' } }, h('button', { class: 'btn primary grow', onclick: () => { newChat(); location.hash = '#/chat'; show('chat'); } }, '＋ ' + t('chat.new'))),
      h('input', { type: 'search', placeholder: t('chat.search'), 'aria-label': t('chat.search'), oninput: (e) => { chatQuery = e.target.value; clearTimeout(shell.t); shell.t = setTimeout(loadChats, 250); } }),
      h('label', { class: 'row sm muted', style: { margin: '6px 0' } }, h('input', { type: 'checkbox', onchange: (e) => { showArchived = e.target.checked; loadChats(); } }), t('chat.showArchived')), chatsBox = h('div', { id: 'chatList' })),
    h('div', { class: 'row', style: { padding: '10px', borderTop: '1px solid var(--border)' } }, h('span', { class: 'muted sm grow' }, state.user.username), langSwitch(), h('button', { class: 'btn sm', onclick: async () => { await POST('/auth/logout', {}).catch(() => {}); state.user = null; loginScreen(); } }, t('auth.signOut'))));
  titleEl = h('h1'); content = h('div', { class: 'content', id: 'content' });
  clear(root).append(h('div', { class: 'app' }, side, h('div', { class: 'main' }, state.mockMode ? h('div', { class: 'banner', role: 'alert' }, 'DEVELOPMENT / MOCK MODE — ' + t('app.mockWarn')) : null,
    h('div', { class: 'top' }, h('button', { class: 'btn sm ghost', id: 'menuBtn', 'aria-label': 'Menu', style: { display: matchMedia('(max-width:860px)').matches ? '' : 'none' }, onclick: () => $('#side').classList.toggle('open') }, '☰'), titleEl), content)));
  chatHooks.onChanged = loadChats; providersHooks.goModels = (connId) => { location.hash = '#/models'; show('models', { connectionId: connId }); };
  loadChats(); show(location.hash.replace('#/', '') || 'chat');
}

async function loadChats() {
  if (!chatsBox) return; try { const d = await GET(`/chats?q=${encodeURIComponent(chatQuery)}${showArchived ? '&archived=1' : ''}`); clear(chatsBox);
    if (!d.chats.length) chatsBox.append(h('div', { class: 'muted sm', style: { padding: '8px' } }, t('chat.noChats')));
    for (const c of d.chats) { const item = h('div', { class: 'chat-item' + (c.id === state.chatId ? ' on' : ''), tabindex: 0, onclick: (e) => { if (e.target.closest('.acts')) return; location.hash = '#/chat'; show('chat').then(() => openChat(c.id)).then(loadChats); $('#side').classList.remove('open'); }, onkeydown: (e) => { if (e.key === 'Enter' && e.target === item) item.click(); } },
      c.pinned ? h('span', { 'aria-label': 'pinned' }, '📌') : null, h('span', { class: 't', dir: 'auto', title: c.title }, c.title),
      h('span', { class: 'acts' }, [['✏️', t('common.rename'), () => renameChat(c)], [c.pinned ? '📍' : '📌', t('chat.pin'), async () => { await PATCH('/chats/' + c.id, { pinned: !c.pinned }); loadChats(); }], ['⬇️', t('chat.export'), () => exportChat(c)], [c.archived ? '📤' : '🗄️', t('chat.archive'), async () => { await PATCH('/chats/' + c.id, { archived: !c.archived }); if (state.chatId === c.id) newChat(); loadChats(); }], ['🗑️', t('common.delete'), async () => { if (await confirmDialog(t('chat.confirmDelete'))) { await DEL('/chats/' + c.id); if (state.chatId === c.id) newChat(); loadChats(); } }]].map(([ico, label, fn]) => h('button', { class: 'btn sm ghost', title: label, 'aria-label': label, onclick: guard(fn) }, ico))));
      chatsBox.append(item); } } catch { /* sidebar is best-effort */ }
}
function renameChat(c) { const i = h('input', { type: 'text', value: c.title, maxlength: 120 }); const m = modal({ title: t('common.rename'), body: i, footer: h('button', { class: 'btn primary', onclick: guard(async () => { await PATCH('/chats/' + c.id, { title: i.value }); m.close(); loadChats(); }) }, t('common.save')) }); }
function exportChat(c) { const m = modal({ title: t('chat.export'), body: h('div', { class: 'row' }, h('button', { class: 'btn', onclick: guard(async () => { await downloadAuthed(`/chats/${c.id}/export?format=markdown`, 'chat.md'); m.close(); }) }, 'Markdown (.md)'), h('button', { class: 'btn', onclick: guard(async () => { await downloadAuthed(`/chats/${c.id}/export?format=json`, 'chat.json'); m.close(); }) }, 'JSON')) }); }

async function show(view, preset) {
  if (!VIEWS.some(([v]) => v === view)) view = 'chat'; state.view = view; stopMonitor();
  document.querySelectorAll('.nav button').forEach((b) => b.toggleAttribute('aria-current', b.dataset.view === view) || (b.dataset.view === view ? b.setAttribute('aria-current', 'page') : b.removeAttribute('aria-current')));
  document.querySelectorAll('.nav button').forEach((b) => { if (b.dataset.view === view) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
  titleEl.textContent = t('nav.' + view); clear(content); content.style.padding = '';
  const r = { chat: () => renderChat(content), providers: () => renderProviders(content), models: () => renderModels(content, preset), team: () => renderTeam(content), map: () => renderMap(content), monitor: () => renderMonitor(content), memory: () => renderMemory(content), settings: () => renderSettings(content, { rerender: shell }) }[view];
  await r();
}
boot();
export { addKeyWizard };
