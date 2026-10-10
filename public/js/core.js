import { t, getLang } from './i18n.js';

export const state = { user: null, csrf: null, settings: null, mockMode: false, activeRoute: null, chatId: null, view: 'chat' };

/** DOM builder. Strings become text nodes (XSS-safe). on* props are event handlers. */
export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v; else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'dataset') Object.assign(el.dataset, v); else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k in el && k !== 'list' && typeof v !== 'string' || k === 'value' || k === 'checked' || k === 'disabled' || k === 'selected') el[k] = v; else el.setAttribute(k, v === true ? '' : v);
  }
  const add = (c) => { if (c == null || c === false) return; if (Array.isArray(c)) c.forEach(add); else el.append(c instanceof Node ? c : document.createTextNode(String(c))); };
  kids.forEach(add); return el;
}
export const $ = (s, r = document) => r.querySelector(s);
export const clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); return el; };

export class ApiError extends Error { constructor(status, body) { super((body && body.error && body.error.message) || 'Request failed'); this.status = status; this.code = body && body.error && body.error.code; this.body = body; } }
export async function api(method, path, body) {
  const res = await fetch('/api' + path, { method, credentials: 'same-origin', headers: { 'Content-Type': 'application/json', ...(state.csrf && method !== 'GET' ? { 'x-csrf-token': state.csrf } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* non-json */ }
  if (!res.ok) { if (res.status === 401 && path !== '/auth/login') window.dispatchEvent(new Event('mm:unauth')); if (json && json.error && json.error.code === 'PASSWORD_CHANGE_REQUIRED') window.dispatchEvent(new Event('mm:pwchange')); throw new ApiError(res.status, json); }
  return json;
}
export const GET = (p) => api('GET', p), POST = (p, b) => api('POST', p, b ?? {}), PUT = (p, b) => api('PUT', p, b), PATCH = (p, b) => api('PATCH', p, b), DEL = (p) => api('DELETE', p);

export function toast(msg, kind = 'info') {
  if (state.settings && state.settings.notifications && state.settings.notifications.toasts === false && kind !== 'err') return;
  const el = h('div', { class: 'toast ' + kind }, msg); $('#toasts').append(el); setTimeout(() => el.remove(), kind === 'err' ? 7000 : 3500);
}
export const errMsg = (e) => (e && e.message) || String(e);
export const guard = (fn) => async (...a) => { try { return await fn(...a); } catch (e) { toast(errMsg(e), 'err'); } };

export function modal({ title, body, footer, wide = false, onClose }) {
  const prev = document.activeElement;
  const close = () => { ov.remove(); document.removeEventListener('keydown', esc); if (prev && prev.focus) prev.focus(); if (onClose) onClose(); };
  const esc = (e) => { if (e.key === 'Escape') close(); };
  const ov = h('div', { class: 'overlay', role: 'dialog', 'aria-modal': 'true', 'aria-label': title, onmousedown: (e) => { if (e.target === ov) close(); } },
    h('div', { class: 'modal' + (wide ? ' wide' : '') }, h('header', null, h('h2', null, title), h('button', { class: 'btn ghost sm', 'aria-label': t('common.close'), onclick: close }, '✕')), h('div', { class: 'body' }, body), footer ? h('footer', null, footer) : null));
  document.addEventListener('keydown', esc); document.body.append(ov);
  const f = ov.querySelector('input,textarea,select,button.primary'); if (f) f.focus();
  return { close, el: ov };
}
export function confirmDialog(message, { danger = true, okText } = {}) {
  return new Promise((resolve) => {
    let m; const done = (v) => { m.close(); resolve(v); };
    m = modal({ title: t('common.confirm'), body: h('p', null, message), footer: [h('button', { class: 'btn', onclick: () => done(false) }, t('common.cancel')), h('button', { class: 'btn primary' + (danger ? ' danger' : ''), onclick: () => done(true) }, okText || t('common.yes'))], onClose: () => resolve(false) });
  });
}

export const fmt = {
  time: (ms) => ms ? new Date(ms).toLocaleString(getLang() === 'ar' ? 'ar' : 'en') : '—',
  num: (n) => n == null ? '—' : Number(n).toLocaleString(getLang() === 'ar' ? 'ar-EG' : 'en'),
  ms: (n) => n == null ? '—' : n >= 1000 ? (n / 1000).toFixed(1) + 's' : Math.round(n) + 'ms',
  cost: (c) => c == null ? t('common.unknown') : '$' + (c < 0.01 ? c.toFixed(5) : c.toFixed(4)),
  price: (p) => p == null ? t('common.pricingUnknown') : `${p.inputPer1M == null ? '?' : '$' + p.inputPer1M} / ${p.outputPer1M == null ? '?' : '$' + p.outputPer1M} per 1M`
};
export const badge = (cls, text) => h('span', { class: 'badge ' + cls }, h('span', { class: 'dot' }), text);
export const stateBadge = (s) => badge(s, t('state.' + s));

/* ---------------- theme ---------------- */
export function applyTheme(s) {
  const mode = s.theme === 'system' ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : s.theme;
  const r = document.documentElement; r.dataset.theme = mode; r.style.setProperty('--accent', s.accent);
  const c = s.accent.replace('#', ''); const [R, G, B] = [0, 2, 4].map((i) => parseInt(c.substr(i, 2), 16) / 255).map((v) => v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
  r.style.setProperty('--accent-fg', 0.2126 * R + 0.7152 * G + 0.0722 * B > 0.35 ? '#0b0f1d' : '#ffffff'); // keep text on accent readable
}

/* ---------------- markdown (escape-first, no innerHTML of raw input) ---------------- */
export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const KW = /\b(?:function|const|let|var|return|if|else|for|while|class|import|from|export|default|new|async|await|try|catch|finally|throw|def|self|None|True|False|elif|in|is|not|and|or|lambda|with|as|pass|yield|public|private|static|void|int|string|bool|true|false|null|undefined|typeof|struct|fn|impl|use|mod|let|match|SELECT|FROM|WHERE|INSERT|UPDATE|DELETE|JOIN|CREATE|TABLE|package|interface|extends|implements|this|super)\b/;
const TOK = new RegExp(`(\\/\\*[\\s\\S]*?\\*\\/|\\/\\/[^\\n]*|#[^\\n]*)|("(?:\\\\.|[^"\\\\\\n])*"|'(?:\\\\.|[^'\\\\\\n])*'|\`(?:\\\\.|[^\`\\\\])*\`)|(\\b\\d[\\d_.]*\\b)|(${KW.source})`, 'g');
export function highlight(code) {
  let out = '', last = 0, m; TOK.lastIndex = 0;
  while ((m = TOK.exec(code))) { out += esc(code.slice(last, m.index)); const cls = m[1] ? 'c' : m[2] ? 's' : m[3] ? 'n' : 'k'; out += `<span class="tk-${cls}">${esc(m[0])}</span>`; last = TOK.lastIndex; if (m[0].length === 0) TOK.lastIndex++; }
  return out + esc(code.slice(last));
}
function inline(s) {
  s = esc(s);
  s = s.replace(/`([^`\n]+)`/g, '<code class="i">$1</code>').replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>').replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  s = s.replace(/!\[([^\]\n]*)\]\((\/api\/files\/[a-f0-9-]{36})\)/g, '<img src="$2" alt="$1" style="max-width:100%;border-radius:10px">');
  return s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
}
export function renderMarkdown(src) {
  const blocks = []; src = String(src).replace(/```(\w*)[^\n]*\n([\s\S]*?)(```|$)/g, (_, lang, code) => { blocks.push({ lang, code: code.replace(/\n$/, '') }); return `\u0000B${blocks.length - 1}\u0000`; });
  const lines = src.split('\n'); let html = '', i = 0;
  const flushPara = (buf) => { if (buf.length) html += `<p>${inline(buf.join('\n')).replace(/\n/g, '<br>')}</p>`; };
  let para = [];
  while (i < lines.length) {
    const ln = lines[i]; let m;
    if ((m = ln.match(/^\u0000B(\d+)\u0000$/))) { flushPara(para); para = []; const b = blocks[m[1]]; html += `<div class="codeblock"><div class="ch"><span>${esc(b.lang || 'code')}</span><button class="btn sm ghost" data-act="copy-code">${esc(t('chat.copy'))}</button><button class="btn sm ghost" data-act="dl-code" data-lang="${esc(b.lang)}">${esc(t('chat.download'))}</button></div><pre><code>${highlight(b.code)}</code></pre></div>`; i++; continue; }
    if ((m = ln.match(/^(#{1,4})\s+(.*)$/))) { flushPara(para); para = []; html += `<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`; i++; continue; }
    if (/^\s*([-*])\s+/.test(ln) || /^\s*\d+[.)]\s+/.test(ln)) { flushPara(para); para = []; const ord = /^\s*\d+[.)]/.test(ln); let items = ''; while (i < lines.length && (ord ? /^\s*\d+[.)]\s+/ : /^\s*[-*]\s+/).test(lines[i])) { items += `<li>${inline(lines[i].replace(/^\s*(?:[-*]|\d+[.)])\s+/, ''))}</li>`; i++; } html += ord ? `<ol>${items}</ol>` : `<ul>${items}</ul>`; continue; }
    if (/^>\s?/.test(ln)) { flushPara(para); para = []; let q = []; while (i < lines.length && /^>\s?/.test(lines[i])) { q.push(lines[i].replace(/^>\s?/, '')); i++; } html += `<blockquote>${inline(q.join('\n')).replace(/\n/g, '<br>')}</blockquote>`; continue; }
    if (/^\s*\|.+\|\s*$/.test(ln) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] || '')) { flushPara(para); para = []; const cells = (r) => r.trim().replace(/^\||\|$/g, '').split('|').map((c) => inline(c.trim())); html += '<div style="overflow:auto"><table><thead><tr>' + cells(ln).map((c) => `<th>${c}</th>`).join('') + '</tr></thead><tbody>'; i += 2; while (i < lines.length && /^\s*\|.+\|\s*$/.test(lines[i])) { html += '<tr>' + cells(lines[i]).map((c) => `<td>${c}</td>`).join('') + '</tr>'; i++; } html += '</tbody></table></div>'; continue; }
    if (/^\s*---+\s*$/.test(ln)) { flushPara(para); para = []; html += '<hr>'; i++; continue; }
    if (!ln.trim()) { flushPara(para); para = []; i++; continue; }
    para.push(ln); i++;
  }
  flushPara(para); return html;
}
export function download(name, text, type = 'text/plain') { const a = h('a', { href: URL.createObjectURL(new Blob([text], { type })), download: name }); document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500); }
export async function downloadAuthed(path, fallbackName) {
  const res = await fetch('/api' + path, { credentials: 'same-origin' }); if (!res.ok) throw new Error('Download failed');
  const cd = res.headers.get('content-disposition') || ''; const m = cd.match(/filename\*=UTF-8''([^;]+)/); const blob = await res.blob();
  const a = h('a', { href: URL.createObjectURL(blob), download: m ? decodeURIComponent(m[1]) : fallbackName }); document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}
export function skeleton(n = 3) { return h('div', null, Array.from({ length: n }, () => h('div', { class: 'skeleton' }))); }
export function emptyState(msg, action) { return h('div', { class: 'empty' }, h('p', null, msg), action || null); }
export function sw(checked, onchange, label) { return h('label', { class: 'switch', title: label }, h('input', { type: 'checkbox', checked: !!checked, 'aria-label': label || '', onchange: (e) => onchange(e.target.checked, e.target) }), h('i')); }
export function field(label, input, hint) { return h('div', null, h('label', { class: 'f' }, label), input, hint ? h('div', { class: 'muted sm' }, hint) : null); }
