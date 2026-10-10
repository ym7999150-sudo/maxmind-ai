import { h, $, clear, state, GET, POST, PATCH, toast, errMsg, renderMarkdown, download, fmt, modal, skeleton, emptyState, downloadAuthed } from '../core.js';
import { t, getLang } from '../i18n.js';

let msgs = [], busy = false, abortCtl = null, atts = [], listEl, composerEl, inputEl, onChatsChanged = () => {}, canImage = false, lastPayload = null, tts = null;
export const chatHooks = { set onChanged(fn) { onChatsChanged = fn; } };

export async function openChat(id) {
  state.chatId = id; msgs = []; atts = [];
  if (listEl) { clear(listEl).append(skeleton(4)); }
  if (id) { try { const c = await GET('/chats/' + id); msgs = c.messages; } catch (e) { toast(errMsg(e), 'err'); state.chatId = null; } }
  renderList(); renderAtts();
}
export function newChat() { state.chatId = null; msgs = []; atts = []; if (listEl) { renderList(); renderAtts(); inputEl && inputEl.focus(); } }

export async function renderChat(root) {
  clear(root); root.style.padding = '0';
  listEl = h('div', { class: 'in', 'aria-live': 'polite' });
  const modeSel = h('select', { 'aria-label': t('chat.mode'), style: { width: 'auto' }, onchange: (e) => { state.settings.chat.mode = e.target.value; POST_SETTINGS({ chat: { mode: e.target.value } }); } },
    ['auto', 'smart', 'manual', 'team'].map((m) => h('option', { value: m, selected: state.settings.chat.mode === m }, t('mode.' + m))));
  const critical = h('input', { type: 'checkbox', id: 'crit' });
  const fileInput = h('input', { type: 'file', multiple: true, hidden: true, onchange: (e) => { upload([...e.target.files]); e.target.value = ''; } });
  inputEl = h('textarea', { rows: 1, placeholder: t('chat.placeholder'), 'aria-label': t('chat.placeholder'), dir: 'auto', onkeydown: (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } }, oninput: () => { inputEl.style.height = 'auto'; inputEl.style.height = Math.min(200, inputEl.scrollHeight) + 'px'; } });
  const sendBtn = h('button', { class: 'btn primary', id: 'sendBtn', onclick: () => (busy ? stop() : send()) }, t('chat.send'));
  const imgBtn = h('button', { class: 'btn', id: 'imgBtn', hidden: true, title: t('chat.generateImage'), onclick: genImage }, '🎨');
  const micBtn = h('button', { class: 'btn', id: 'micBtn', title: t('chat.voice'), 'aria-label': t('chat.voice'), onclick: toggleVoice }, '🎤');
  composerEl = h('div', { class: 'composer' }, h('div', { class: 'in' }, h('div', { class: 'atts', id: 'atts' }),
    inputEl, h('div', { class: 'row', style: { marginTop: '8px' } }, h('button', { class: 'btn', onclick: () => fileInput.click(), title: t('chat.attach') }, '📎 ', t('chat.attach')), micBtn, imgBtn, fileInput,
      h('span', { class: 'grow' }), h('label', { class: 'row sm muted', for: 'crit', title: t('chat.criticalHint') }, critical, t('chat.critical')), modeSel, sendBtn)));
  const wrap = h('div', { class: 'chat' }, h('div', { class: 'msgs', id: 'msgScroll' }, listEl), composerEl); root.append(wrap);
  wrap.addEventListener('dragover', (e) => { e.preventDefault(); composerEl.classList.add('drop'); }); wrap.addEventListener('dragleave', () => composerEl.classList.remove('drop'));
  wrap.addEventListener('drop', (e) => { e.preventDefault(); composerEl.classList.remove('drop'); upload([...e.dataTransfer.files]); });
  listEl.addEventListener('click', onListClick);
  GET('/models').then(({ models }) => { canImage = models.some((m) => m.profile.enabled && m.connectionStatus === 'VALID' && (m.capabilities.imageGeneration === true || m.profile.capabilityOverrides.imageGeneration)); imgBtn.hidden = !canImage; }).catch(() => {});
  renderList(); renderAtts();
  window.__mmCritical = () => critical.checked;
}
const POST_SETTINGS = (p) => import('../core.js').then((c) => c.PUT('/settings', p)).catch(() => {});

function renderList() {
  if (!listEl) return; clear(listEl);
  if (!msgs.length) { listEl.append(h('div', { class: 'empty', style: { marginTop: '10vh' } }, h('img', { src: '/logo.svg', width: 56, height: 56, alt: '' }), h('h2', null, t('chat.welcome')), h('p', null, t('chat.welcomeSub')))); return; }
  msgs.forEach((m, i) => listEl.append(renderMsg(m, i)));
  scrollDown();
}
const scrollDown = () => { const s = $('#msgScroll'); if (s) s.scrollTop = s.scrollHeight; };

function renderMsg(m, i) {
  const last = i === msgs.length - 1; const isUser = m.role === 'user';
  const bubble = h('div', { class: 'bubble' }); if (isUser) bubble.textContent = m.content; else { bubble.innerHTML = renderMarkdown(m.content); fixImgs(bubble); }
  if (isUser && m.meta && m.meta.attachments) bubble.append(h('div', { class: 'muted sm' }, m.meta.attachments.map((a) => '📎 ' + a.name).join('  ')));
  const acts = h('div', { class: 'acts' }, h('button', { class: 'btn sm ghost', dataset: { act: 'copy', i } }, t('chat.copy')));
  if (!isUser) acts.append(h('button', { class: 'btn sm ghost', dataset: { act: 'speak', i } }, '🔊 ' + t('chat.speak')));
  if (isUser) acts.append(h('button', { class: 'btn sm ghost', dataset: { act: 'edit', i } }, t('chat.edit')));
  if (!isUser && last) acts.append(h('button', { class: 'btn sm ghost', dataset: { act: 'regen', i } }, t('chat.regenerate')), h('button', { class: 'btn sm ghost', dataset: { act: 'continue', i } }, t('chat.continue')));
  const el = h('div', { class: 'msg ' + m.role, dir: 'auto' }, bubble, acts);
  const d = m.meta && m.meta.requestDetails; if (d && state.settings.chat.showRequestDetails && !d.local) el.append(detailsEl(d));
  return el;
}
const fixImgs = (root) => root.querySelectorAll('img[data-src]').forEach((i) => { i.src = i.dataset.src; });

export function detailsEl(d) {
  const row = (k, v) => [h('dt', null, k), h('dd', null, v)];
  const tk = d.tokens || {}; const top = (d.routing && d.routing.top) || [];
  return h('details', { class: 'details' }, h('summary', null, `${t('det.title')} · ${d.modelsUsed ?? 0} ${t('det.models')} · ${fmt.num(tk.total)} ${t('det.tokens')} · ${t('det.cache')} ${d.cache}${d.failures && d.failures.length ? ' · ⚠ ' + d.failures.length : ''}`),
    h('dl', null, ...row(t('det.strategy'), t('strat.' + d.strategy)), ...row(t('det.primary'), d.primary || '—'), d.reviewer ? row(t('det.reviewer'), d.reviewer) : [], ...row(t('det.synth'), d.synthesizer || '—'),
      ...row(t('det.tokens'), `${fmt.num(tk.input)} in / ${fmt.num(tk.output)} out = ${fmt.num(tk.total)} (${tk.measured ? t('det.measured') : t('det.estimated')})`),
      ...row(t('det.cost'), d.costKnown ? fmt.cost(d.estimatedCost) : t('common.unknown')), ...row(t('det.calls'), String(d.teamCalls ?? 0)), ...row(t('det.cache'), d.cache + (d.cacheSimilarity ? ` (${d.cacheSimilarity})` : '')),
      ...row(t('det.compression'), (d.compressionPct ?? 0) + '% (' + t('det.estimated') + ')'), ...row(t('det.latency'), fmt.ms(d.latencyMs)),
      ...row(t('det.task'), d.routing ? `${d.routing.task.type} / ${d.routing.task.complexity}` : '—')),
    top.length ? h('div', null, h('strong', null, t('det.why')), h('ul', null, top.map((c) => h('li', null, `${c.label} — ${c.score}`, h('span', { class: 'muted' }, ' (' + Object.entries(c.breakdown).filter(([, v]) => v.contribution >= 4).map(([k, v]) => `${k} ${v.contribution}`).join(', ') + ')'))))) : null,
    d.models && d.models.length ? h('details', null, h('summary', null, t('det.teamSummary')), h('ul', null, d.models.map((c) => h('li', null, `${c.role} · ${c.label} · ${c.status}${c.latencyMs ? ' · ' + fmt.ms(c.latencyMs) : ''}`, c.conclusion ? h('div', { class: 'muted' }, '→ ' + c.conclusion) : null, c.error ? h('div', { style: { color: 'var(--bad)' } }, c.error) : null)))) : null);
}

async function onListClick(e) {
  const b = e.target.closest('button[data-act]'); if (!b) return; const act = b.dataset.act;
  if (act === 'copy-code') return navigator.clipboard.writeText(b.closest('.codeblock').querySelector('code').textContent).then(() => toast(t('chat.copied'), 'ok'));
  if (act === 'dl-code') { const lang = b.dataset.lang || 'txt'; const ext = { javascript: 'js', js: 'js', python: 'py', py: 'py', typescript: 'ts', ts: 'ts', html: 'html', css: 'css', json: 'json', bash: 'sh', sh: 'sh', sql: 'sql', java: 'java' }[lang] || lang || 'txt'; return download('code.' + ext, b.closest('.codeblock').querySelector('code').textContent); }
  const m = msgs[+b.dataset.i];
  if (act === 'copy') return navigator.clipboard.writeText(m.content).then(() => toast(t('chat.copied'), 'ok'));
  if (act === 'speak') return speak(m.content);
  if (act === 'regen') return run({ action: 'regenerate', chatId: state.chatId });
  if (act === 'continue') return run({ action: 'continue', chatId: state.chatId });
  if (act === 'edit') { const ta = h('textarea', { rows: 6, dir: 'auto' }, m.content); ta.value = m.content; const md = modal({ title: t('chat.edit'), body: ta, footer: [h('button', { class: 'btn', onclick: () => md.close() }, t('common.cancel')), h('button', { class: 'btn primary', onclick: () => { const text = ta.value.trim(); md.close(); if (text) { msgs = msgs.slice(0, +b.dataset.i); renderList(); run({ action: 'edit', chatId: state.chatId, messageId: m.id, text }); } } }, t('chat.send'))] }); }
}
function speak(text) {
  if (!('speechSynthesis' in window)) return toast(t('voice.noTts'), 'err'); speechSynthesis.cancel(); if (tts === text) { tts = null; return; }
  const u = new SpeechSynthesisUtterance(text.replace(/```[\s\S]*?```/g, ' ')); u.lang = getLang() === 'ar' ? 'ar-SA' : 'en-US'; u.onend = () => { tts = null; }; tts = text; speechSynthesis.speak(u);
}

/* ---------- attachments ---------- */
async function upload(files) {
  for (const f of files) {
    if (f.size > 10 * 1048576) { toast(`${f.name}: ${t('files.tooLarge')}`, 'err'); continue; }
    try {
      const b64 = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = rej; r.readAsDataURL(f); });
      const a = await POST('/files', { name: f.name, dataBase64: b64, chatId: state.chatId }); atts.push(a); renderAtts();
    } catch (e) { toast(`${f.name}: ${errMsg(e)}`, 'err'); }
  }
}
function renderAtts() { const box = $('#atts'); if (!box) return; clear(box); atts.forEach((a, i) => box.append(h('span', { class: 'att' }, a.kind === 'image' ? h('img', { src: '/api/files/' + a.id, alt: a.name }) : '📄', a.name, h('small', { class: 'muted' }, a.textTokens ? `~${fmt.num(a.textTokens)} ${t('det.tokens')}` : ''), h('button', { class: 'btn sm ghost', 'aria-label': t('common.remove'), onclick: () => { atts.splice(i, 1); renderAtts(); } }, '✕')))); }

/* ---------- sending / streaming ---------- */
function send() {
  const text = inputEl.value.trim(); if (!text || busy) return;
  inputEl.value = ''; inputEl.style.height = 'auto';
  const attachmentIds = atts.map((a) => a.id); const shown = { role: 'user', content: text, meta: attachmentIds.length ? { attachments: atts.map((a) => ({ id: a.id, name: a.name, kind: a.kind })) } : {} };
  msgs.push(shown); atts = []; renderAtts(); renderList();
  run({ text, chatId: state.chatId, attachmentIds, critical: window.__mmCritical && window.__mmCritical() });
}
function stop() { if (abortCtl) abortCtl.abort(); }
function setBusy(b) { busy = b; const s = $('#sendBtn'); if (s) { s.textContent = b ? t('chat.stop') : t('chat.send'); s.classList.toggle('danger', b); } }

async function run(payload) {
  lastPayload = payload; setBusy(true); abortCtl = new AbortController(); state.activeRoute = null;
  const live = h('div', { class: 'msg assistant', dir: 'auto' }, h('div', { class: 'bubble' }), h('div', { class: 'stage typing' }, t('stage.analyzing')));
  const bub = live.firstChild, stage = live.lastChild; listEl.append(live); scrollDown(); let acc = '', err = null, done = null;
  try {
    const res = await fetch('/api/chat/send', { method: 'POST', credentials: 'same-origin', signal: abortCtl.signal, headers: { 'Content-Type': 'application/json', 'x-csrf-token': state.csrf }, body: JSON.stringify(payload) });
    if (!res.ok || !res.body) { const j = await res.json().catch(() => null); throw new Error((j && j.error && j.error.message) || 'Request failed'); }
    const rd = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
    for (;;) {
      const { value, done: fin } = await rd.read(); if (fin) break; buf += dec.decode(value, { stream: true });
      let i; while ((i = buf.indexOf('\n\n')) !== -1) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2); const m = block.match(/^event: (.+)\ndata: (.+)$/s); if (!m) continue; const ev = m[1], data = JSON.parse(m[2]);
        if (ev === 'start') { if (!state.chatId) { state.chatId = data.chatId; } }
        else if (ev === 'stage') stage.textContent = stageText(data);
        else if (ev === 'route') { state.activeRoute = data.steps.map((s) => 'model:' + s.key); stage.textContent = `${t('strat.' + data.strategy)} · ${data.steps.map((s) => s.label.split(' · ').pop()).join(' → ')}`; }
        else if (ev === 'delta') { acc += data.text; bub.innerHTML = renderMarkdown(acc); fixImgs(bub); stage.classList.remove('typing'); scrollDown(); }
        else if (ev === 'done') done = data; else if (ev === 'error') err = data;
      }
    }
  } catch (e) { if (e.name !== 'AbortError') err = { message: errMsg(e) }; else done = done || { content: acc, stoppedLocal: true }; }
  state.activeRoute = null; setBusy(false); abortCtl = null; live.remove();
  if (err) { msgs.push({ role: 'assistant', content: '', error: err }); renderList(); const box = h('div', { class: 'msg assistant' }, h('div', { class: 'bubble', style: { borderColor: 'var(--bad)' } }, h('strong', null, '⚠ ' + (err.code ? t('err.' + err.code) !== 'err.' + err.code ? t('err.' + err.code) : err.code : t('common.error'))), h('p', null, err.message), errHint(err), h('button', { class: 'btn sm', onclick: () => { box.remove(); msgs.pop(); run(lastPayload); } }, t('chat.retry')))); msgs.pop(); listEl.append(box); scrollDown(); if (state.chatId) onChatsChanged(); return; }
  if (state.chatId) { try { const c = await GET('/chats/' + state.chatId); msgs = c.messages; } catch { /* keep local */ } }
  renderList(); onChatsChanged();
}
const errHint = (err) => err.details && err.details.reasons ? h('div', { class: 'muted sm' }, err.details.reasons.join(', ')) : (err.code === 'NO_COMPATIBLE_MODEL' ? h('div', { class: 'muted sm' }, t('err.hintModels')) : null);
const stageText = (d) => d.key === 'analyzing' ? t('stage.analyzing') : d.key === 'drafting' ? t('stage.drafting') : d.key === 'reviewing' ? `${t('stage.reviewing')} (${d.model.split(' · ').pop()})` : d.key === 'synthesizing' ? `${t('stage.synthesizing')} (${d.model.split(' · ').pop()})` : d.key === 'fallback' ? `${t('stage.fallback')}: ${d.model.split(' · ').pop()}` : `${t('stage.answering')} (${(d.model || '').split(' · ').pop()})`;

/* ---------- image generation ---------- */
async function genImage() {
  const ta = h('textarea', { rows: 4, dir: 'auto', placeholder: t('chat.imagePrompt') });
  const md = modal({ title: t('chat.generateImage'), body: ta, footer: [h('button', { class: 'btn', onclick: () => md.close() }, t('common.cancel')), h('button', { class: 'btn primary', onclick: async (e) => { const p = ta.value.trim(); if (!p) return; e.target.disabled = true; try { const r = await POST('/images/generate', { prompt: p, chatId: state.chatId }); md.close(); if (state.chatId) { const c = await GET('/chats/' + state.chatId); msgs = c.messages; renderList(); } else { toast(t('chat.imageDone'), 'ok'); } void r; } catch (er) { toast(errMsg(er), 'err'); e.target.disabled = false; } } }, t('chat.generate'))] });
}

/* ---------- voice ---------- */
let rec = null, mr = null;
function toggleVoice() {
  const btn = $('#micBtn'); const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (rec) { rec.stop(); return; } if (mr) { mr.stop(); return; }
  const vl = state.settings.voice.lang; const lang = vl === 'auto' ? (getLang() === 'ar' ? 'ar-SA' : 'en-US') : vl;
  if (SR) {
    rec = new SR(); rec.lang = lang; rec.interimResults = false; rec.onresult = (e) => { inputEl.value += (inputEl.value ? ' ' : '') + [...e.results].map((r) => r[0].transcript).join(' '); inputEl.focus(); };
    rec.onerror = (e) => toast(t('voice.error') + ': ' + e.error, 'err'); rec.onend = () => { rec = null; btn.textContent = '🎤'; }; btn.textContent = '⏹'; rec.start(); return;
  }
  if (navigator.mediaDevices && window.MediaRecorder) {
    navigator.mediaDevices.getUserMedia({ audio: true }).then((stream) => {
      const chunks = []; mr = new MediaRecorder(stream); mr.ondataavailable = (e) => chunks.push(e.data); btn.textContent = '⏹';
      mr.onstop = async () => { stream.getTracks().forEach((x) => x.stop()); btn.textContent = '🎤'; const blob = new Blob(chunks, { type: mr.mimeType }); mr = null;
        try { const b64 = await new Promise((res) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.readAsDataURL(blob); }); const r = await POST('/voice/transcribe', { audioBase64: b64, mime: blob.type }); inputEl.value += (inputEl.value ? ' ' : '') + r.text; } catch (e) { toast(errMsg(e), 'err'); } };
      mr.start();
    }).catch(() => toast(t('voice.denied'), 'err')); return;
  }
  toast(t('voice.unavailable'), 'err');
}
