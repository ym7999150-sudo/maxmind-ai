import { h, clear, state, GET, errMsg, emptyState, skeleton } from '../core.js';
import { t } from '../i18n.js';
const NS = 'http://www.w3.org/2000/svg'; const S = (tag, a = {}, ...k) => { const e = document.createElementNS(NS, tag); for (const [x, v] of Object.entries(a)) e.setAttribute(x, v); k.forEach((c) => e.append(c)); return e; };
const COLORS = { online: 'var(--ok)', degraded: 'var(--warn)', offline: 'var(--bad)', disabled: 'var(--muted)', idle: 'var(--muted)' };
const ST_KEY = { online: 'HEALTHY', degraded: 'DEGRADED', offline: 'OFFLINE', disabled: 'UNKNOWN', idle: 'UNKNOWN' };
const R = { core: 46, router: 30, tokens: 24, memory: 24, agent: 22, provider: 28, model: 11 };
const K_MIN = 0.25, K_MAX = 6;
// UI state survives re-renders while the tab stays open (selection, filters, dragged positions, expanded providers).
const ui = { expanded: null, hidden: new Set(), showModels: true, selected: null, query: '', custom: {} };

export async function renderMap(root) {
  clear(root).append(skeleton(3)); let d; try { d = await GET('/map'); } catch (e) { clear(root).append(emptyState(errMsg(e))); return; }
  const byId = new Map(d.nodes.map((n) => [n.id, n])); const last = new Set((d.lastRoute && d.lastRoute.models) || []);
  const adj = new Map(); const link = (a, b) => { if (!adj.has(a)) adj.set(a, new Set()); adj.get(a).add(b); };
  for (const e of d.edges) { link(e.from, e.to); link(e.to, e.from); }
  const provModels = new Map(); for (const e of d.edges) if (e.from.startsWith('prov:') && e.to.startsWith('model:')) { if (!provModels.has(e.from)) provModels.set(e.from, []); provModels.get(e.from).push(e.to); }
  const modelProv = new Map(); for (const [p, ms] of provModels) ms.forEach((m) => modelProv.set(m, p));
  const nProv = d.nodes.filter((n) => n.type === 'provider').length, nModels = d.nodes.filter((n) => n.type === 'model').length;
  if (!ui.expanded) ui.expanded = new Set(nModels <= 40 ? [...provModels.keys()] : []);
  if (ui.selected && !byId.has(ui.selected)) ui.selected = null;

  const svg = S('svg', { role: 'img', 'aria-label': t('map.title'), viewBox: '-700 -700 1400 1400' }); const g = S('g'); svg.append(g);
  const edgeLayer = S('g'), nodeLayer = S('g'); g.append(edgeLayer, nodeLayer);
  let pos = {}, edgeEls = [], nodeEls = new Map(), hover = null, tx = 0, ty = 0, k = 1, anim = 0;
  const tip = h('div', { class: 'tip', hidden: true });
  const side = h('aside', { class: 'mapside', hidden: true, 'aria-live': 'polite' });
  const apply = () => g.setAttribute('transform', `translate(${tx},${ty}) scale(${k})`);
  const toSvg = (e) => { const p = svg.createSVGPoint(); p.x = e.clientX; p.y = e.clientY; return p.matrixTransform(svg.getScreenCTM().inverse()); };
  const animateTo = (nx, ny, nk) => { cancelAnimationFrame(anim); if (matchMedia('(prefers-reduced-motion:reduce)').matches) { tx = nx; ty = ny; k = nk; apply(); return; } const s = { tx, ty, k }, t0 = performance.now(); const step = (now) => { const p = Math.min(1, (now - t0) / 260), e = 1 - Math.pow(1 - p, 3); tx = s.tx + (nx - s.tx) * e; ty = s.ty + (ny - s.ty) * e; k = s.k + (nk - s.k) * e; apply(); if (p < 1) anim = requestAnimationFrame(step); }; anim = requestAnimationFrame(step); };
  const clampK = (v) => Math.min(K_MAX, Math.max(K_MIN, v));
  const zoomAt = (p, f, smooth) => { const nk = clampK(k * f); const ntx = p.x - (p.x - tx) * (nk / k), nty = p.y - (p.y - ty) * (nk / k); if (smooth) animateTo(ntx, nty, nk); else { tx = ntx; ty = nty; k = nk; apply(); } };
  const fit = () => { const ids = Object.keys(pos); if (!ids.length) return; let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9; for (const id of ids) { const r = (R[byId.get(id).type] || 20) + 14; x0 = Math.min(x0, pos[id].x - r); x1 = Math.max(x1, pos[id].x + r); y0 = Math.min(y0, pos[id].y - r); y1 = Math.max(y1, pos[id].y + r); } const nk = clampK(Math.min(1300 / (x1 - x0), 1300 / (y1 - y0), 2)); animateTo(-((x0 + x1) / 2) * nk, -((y0 + y1) / 2) * nk, nk); };
  const focusOn = (id) => { const p = pos[id]; if (p) animateTo(-p.x * 2, -p.y * 2, 2); };

  function modelVisible(m) { if (last.has(m)) return true; if (!ui.showModels) return false; return ui.expanded.has(modelProv.get(m)); }
  function isVisible(n) { return n.type !== 'model' || modelVisible(n.id); }
  function neighbours(id) { const s = new Set([id]); (adj.get(id) || new Set()).forEach((x) => { const n = byId.get(x); if (n && isVisible(n)) s.add(x); }); return s; }

  function applyFocus() {
    const f = ui.selected || hover; const lit = f ? neighbours(f) : null; const q = ui.query.trim().toLowerCase();
    const match = (n) => !q || (n.label + ' ' + (n.detail || '')).toLowerCase().includes(q);
    for (const [id, el] of nodeEls) { const n = byId.get(id); const dim = (lit && !lit.has(id)) || !match(n) || ui.hidden.has(n.status); el.classList.toggle('dim', !!dim); el.classList.toggle('sel', id === ui.selected); }
    for (const l of edgeEls) { const a = l.dataset.from, b = l.dataset.to; const touch = f && (a === f || b === f); const dim = (f && !touch) || !match(byId.get(a)) || !match(byId.get(b)) || ui.hidden.has(byId.get(a).status) || ui.hidden.has(byId.get(b).status); l.classList.toggle('dim', !!dim); l.classList.toggle('lit', !!touch); }
  }

  function layout() {
    pos = {}; const vis = d.nodes.filter(isVisible); const by = (ty2) => vis.filter((n) => n.type === ty2); pos.core = { x: 0, y: 0 };
    ['router', 'tokens', 'memory', 'synth'].forEach((id, i, arr) => { if (!byId.has(id)) return; const a = -Math.PI / 2 + (i * 2 * Math.PI) / arr.length; pos[id] = { x: Math.cos(a) * 130, y: Math.sin(a) * 130 }; });
    const agents = d.nodes.filter((n) => n.id.startsWith('agent:')); agents.forEach((n, i) => { const a = -Math.PI / 2 + ((i + 0.5) * 2 * Math.PI) / agents.length; pos[n.id] = { x: Math.cos(a) * 250, y: Math.sin(a) * 250 }; });
    const provs = by('provider'); const P = Math.max(1, provs.length);
    provs.forEach((n, i) => { const a = -Math.PI / 2 + (i * 2 * Math.PI) / P; pos[n.id] = { x: Math.cos(a) * 400, y: Math.sin(a) * 400 }; n._a = a; });
    for (const p of provs) { const ms = (provModels.get(p.id) || []).filter((m) => modelVisible(m)); const span = Math.min((2 * Math.PI / P) * 0.85, 1.6); ms.forEach((m, j) => { const a = p._a + (ms.length > 1 ? (j / (ms.length - 1) - 0.5) * span : 0); const r = 520 + (j % 4) * 46; pos[m] = { x: Math.cos(a) * r, y: Math.sin(a) * r }; }); }
    for (const id of Object.keys(ui.custom)) if (pos[id]) pos[id] = { ...ui.custom[id] };
  }

  function draw() {
    layout(); edgeLayer.replaceChildren(); nodeLayer.replaceChildren(); edgeEls = []; nodeEls = new Map();
    for (const e of d.edges) { const a = pos[e.from], b = pos[e.to]; if (!a || !b) continue; if (e.router && e.to.startsWith('model:') && !last.has(e.to)) continue; const isR = last.has(e.to) && e.router;
      const l = S('line', { class: 'edge' + (isR ? ' route' : ''), x1: a.x, y1: a.y, x2: b.x, y2: b.y }); l.dataset.from = e.from; l.dataset.to = e.to; if (e.router) l.dataset.router = '1'; edgeLayer.append(l); edgeEls.push(l); }
    for (const n of d.nodes) {
      const p = pos[n.id]; if (!p) continue; const r = R[n.type] || 20; const isM = n.type === 'model'; const nm = (provModels.get(n.id) || []).length;
      const grp = S('g', { class: 'node ' + n.type, transform: `translate(${p.x},${p.y})`, tabindex: '0', role: 'button', 'aria-label': `${n.label}: ${t('state.' + ST_KEY[n.status])}` });
      grp.append(S('circle', { r, class: 'nc', fill: n.type === 'core' ? 'var(--accent)' : 'var(--panel2)', stroke: COLORS[n.status] || 'var(--muted)', 'stroke-width': n.type === 'core' ? 4 : 3, 'stroke-dasharray': n.status === 'disabled' ? '4 3' : '0' }));
      if (!isM) grp.append(S('text', { 'text-anchor': 'middle', y: n.type === 'core' ? 5 : 4, 'font-size': n.type === 'core' ? 13 : 10, fill: n.type === 'core' ? 'var(--accent-fg)' : 'var(--text)', 'font-weight': 600 }, document.createTextNode(n.type === 'core' ? 'MAXMIND' : n.label.length > 12 ? n.label.slice(0, 11) + '…' : n.label)));
      else grp.append(S('text', { 'text-anchor': 'middle', y: r + 11, 'font-size': 8, fill: 'var(--muted)' }, document.createTextNode(n.label.length > 16 ? n.label.slice(0, 15) + '…' : n.label)));
      if (n.type === 'provider' && nm) { const open = ui.expanded.has(n.id); grp.append(S('g', { class: 'badge-g', transform: `translate(${r - 4},${-r + 4})` }, S('circle', { r: 10, fill: 'var(--accent)' }), S('text', { 'text-anchor': 'middle', y: 3.5, 'font-size': 9, 'font-weight': 700, fill: 'var(--accent-fg)' }, document.createTextNode(open ? '−' : String(nm))))); }
      wireNode(grp, n); nodeLayer.append(grp); nodeEls.set(n.id, grp);
    }
    applyFocus();
  }

  function showTip(n, ev) { tip.hidden = false; tip.replaceChildren(h('strong', null, n.label), h('div', null, t('state.' + ST_KEY[n.status]) + (n.status === 'disabled' ? ' · ' + t('map.disabled') : '')), n.detail ? h('div', { class: 'muted' }, n.detail) : null, h('div', { class: 'muted sm' }, t('map.clickHint'))); const b = box.getBoundingClientRect(); const x = (ev.clientX ?? b.left + 100) - b.left + 14, y = (ev.clientY ?? b.top + 100) - b.top + 14; tip.style.left = Math.max(4, Math.min(x, b.width - 270)) + 'px'; tip.style.top = Math.max(4, Math.min(y, b.height - 110)) + 'px'; }
  function select(id) { ui.selected = id; renderSide(); applyFocus(); }
  function toggleProvider(id) { if (ui.expanded.has(id)) ui.expanded.delete(id); else ui.expanded.add(id); draw(); renderSide(); }

  function wireNode(grp, n) {
    let st = null;
    grp.addEventListener('pointerdown', (e) => { if (e.button > 0) return; e.stopPropagation(); st = { x: e.clientX, y: e.clientY, moved: false, p: { ...pos[n.id] } }; grp.setPointerCapture(e.pointerId); });
    grp.addEventListener('pointermove', (e) => {
      if (st) { const dx = e.clientX - st.x, dy = e.clientY - st.y; if (!st.moved && Math.hypot(dx, dy) < 5) return; st.moved = true; tip.hidden = true; const sc = 1400 / svg.getBoundingClientRect().width / k;
        const np = { x: st.p.x + dx * sc, y: st.p.y + dy * sc }; pos[n.id] = np; ui.custom[n.id] = np; grp.setAttribute('transform', `translate(${np.x},${np.y})`); for (const l of edgeEls) { if (l.dataset.from === n.id) { l.setAttribute('x1', np.x); l.setAttribute('y1', np.y); } if (l.dataset.to === n.id) { l.setAttribute('x2', np.x); l.setAttribute('y2', np.y); } } return; }
      showTip(n, e);
    });
    grp.addEventListener('pointerup', () => { if (st && !st.moved) { if (n.type === 'provider' && ui.selected === n.id) toggleProvider(n.id); else select(ui.selected === n.id && n.type !== 'provider' ? null : n.id); } st = null; });
    grp.addEventListener('dblclick', (e) => { e.stopPropagation(); focusOn(n.id); });
    grp.addEventListener('mouseenter', () => { hover = n.id; if (!ui.selected) applyFocus(); }); grp.addEventListener('mouseleave', () => { hover = null; tip.hidden = true; if (!ui.selected) applyFocus(); });
    grp.addEventListener('focus', () => showTip(n, {})); grp.addEventListener('blur', () => { tip.hidden = true; });
    grp.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(n.id); } });
  }

  function renderSide() {
    const n = ui.selected && byId.get(ui.selected); side.hidden = !n; if (!n) return;
    const kids = []; const ms = provModels.get(n.id) || [];
    kids.push(h('div', { class: 'row', style: { justifyContent: 'space-between' } }, h('strong', null, n.label), h('button', { class: 'btn sm ghost', 'aria-label': t('map.close'), onclick: () => select(null) }, '✕')));
    kids.push(h('div', { class: 'row', style: { gap: '6px' } }, h('span', { class: `badge ${n.status}` }, h('span', { class: 'dot' }), t('state.' + ST_KEY[n.status])), h('span', { class: 'badge' }, n.type)));
    if (n.detail) kids.push(h('p', { class: 'muted sm' }, n.detail));
    if (n.type === 'provider' && n.meta && n.meta.models) { const s = n.meta.models; kids.push(h('div', { class: 'mstats' }, [['map.discovered', s.discovered], ['map.healthy', s.healthy], ['map.enabled', s.enabled]].map(([key, v]) => h('div', null, h('b', null, v ?? 0), h('span', { class: 'muted sm' }, t(key)))))); }
    const acts = [];
    if (n.type === 'provider' && ms.length) acts.push(h('button', { class: 'btn sm', onclick: () => toggleProvider(n.id) }, ui.expanded.has(n.id) ? t('map.collapse') : t('map.expand', { n: ms.length })));
    if (n.type === 'provider') acts.push(h('button', { class: 'btn sm', onclick: () => { location.hash = '#/providers'; } }, t('map.openProviders')));
    if (n.type === 'model') { const pv = byId.get(modelProv.get(n.id)); if (pv) acts.push(h('button', { class: 'btn sm', onclick: () => select(pv.id) }, '← ' + pv.label)); acts.push(h('button', { class: 'btn sm', onclick: () => { location.hash = '#/models'; } }, t('map.openModels'))); }
    if (n.type === 'agent') acts.push(h('button', { class: 'btn sm', onclick: () => { location.hash = '#/team'; } }, t('map.openTeam')));
    if (n.type === 'tokens') acts.push(h('button', { class: 'btn sm', onclick: () => { location.hash = '#/settings'; } }, t('map.openSettings')));
    if (n.type === 'memory') acts.push(h('button', { class: 'btn sm', onclick: () => { location.hash = '#/memory'; } }, t('map.openMemory')));
    acts.push(h('button', { class: 'btn sm', onclick: () => focusOn(n.id) }, t('map.focus')));
    kids.push(h('div', { class: 'row', style: { gap: '6px', marginTop: '8px' } }, acts));
    const nb = [...(adj.get(n.id) || [])].map((x) => byId.get(x)).filter((x) => x && isVisible(x) && x.type !== 'model');
    if (nb.length && n.type !== 'core') kids.push(h('div', { class: 'muted sm', style: { marginTop: '10px' } }, t('map.linked')), h('div', { class: 'row', style: { gap: '4px' } }, nb.slice(0, 12).map((x) => h('button', { class: 'chip', onclick: () => select(x.id) }, x.label.length > 18 ? x.label.slice(0, 17) + '…' : x.label))));
    side.replaceChildren(...kids);
  }

  // ---- pan / wheel / pinch / keyboard ----
  svg.addEventListener('wheel', (e) => { e.preventDefault(); zoomAt(toSvg(e), e.deltaY < 0 ? 1.12 : 1 / 1.12); }, { passive: false });
  const ptrs = new Map(); let pan = null, pinch = null;
  svg.addEventListener('pointerdown', (e) => { if (e.target.closest('g.node')) return; ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY }); svg.setPointerCapture(e.pointerId); if (ptrs.size === 2) { const [a, b] = [...ptrs.values()]; pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y), k }; pan = null; } else { pan = { x: e.clientX, y: e.clientY, tx, ty, moved: false }; } });
  svg.addEventListener('pointermove', (e) => { if (!ptrs.has(e.pointerId)) return; ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (ptrs.size === 2 && pinch) { const [a, b] = [...ptrs.values()]; const dist = Math.hypot(a.x - b.x, a.y - b.y); const nk = clampK(pinch.k * (dist / pinch.dist)); zoomAt(toSvg({ clientX: (a.x + b.x) / 2, clientY: (a.y + b.y) / 2 }), nk / k); return; }
    if (!pan) return; const sc = 1400 / svg.getBoundingClientRect().width; if (Math.hypot(e.clientX - pan.x, e.clientY - pan.y) > 4) pan.moved = true; tx = pan.tx + (e.clientX - pan.x) * sc; ty = pan.ty + (e.clientY - pan.y) * sc; apply(); });
  const endPtr = (e) => { ptrs.delete(e.pointerId); if (ptrs.size < 2) pinch = null; if (!ptrs.size) { if (pan && !pan.moved && ui.selected) select(null); pan = null; } };
  svg.addEventListener('pointerup', endPtr); svg.addEventListener('pointercancel', endPtr);
  svg.addEventListener('dblclick', (e) => { if (!e.target.closest('g.node')) zoomAt(toSvg(e), 1.8, true); });
  svg.addEventListener('keydown', (e) => { if (e.key === 'Escape') select(null); else if (e.key === '+' || e.key === '=') zoomAt({ x: 0, y: 0 }, 1.25, true); else if (e.key === '-') zoomAt({ x: 0, y: 0 }, 0.8, true); else if (e.key === '0') fit(); });

  // ---- toolbar ----
  const search = h('input', { type: 'search', class: 'mapsearch', placeholder: t('map.search'), 'aria-label': t('map.search'), value: ui.query, oninput: (e) => { ui.query = e.target.value; applyFocus(); },
    onkeydown: (e) => { if (e.key === 'Enter') { const q = ui.query.trim().toLowerCase(); const hit = d.nodes.find((n) => isVisible(n) && q && (n.label + ' ' + (n.detail || '')).toLowerCase().includes(q)) || d.nodes.find((n) => q && n.type === 'model' && n.label.toLowerCase().includes(q)); if (hit) { if (!isVisible(hit)) { ui.expanded.add(modelProv.get(hit.id)); draw(); } select(hit.id); focusOn(hit.id); } } } });
  const chips = h('div', { class: 'row', style: { gap: '4px' } });
  const paintChips = () => chips.replaceChildren(...['online', 'degraded', 'offline', 'disabled'].map((s) => h('button', { class: 'chip legend-chip', 'aria-pressed': String(!ui.hidden.has(s)), title: t('map.filterHint'), onclick: () => { if (ui.hidden.has(s)) ui.hidden.delete(s); else ui.hidden.add(s); paintChips(); applyFocus(); } }, h('span', { class: 'dot', style: { background: COLORS[s] } }), ' ' + t('map.' + s))));
  paintChips();
  const modelsBtn = h('button', { class: 'btn sm', 'aria-pressed': String(ui.showModels), onclick: () => { ui.showModels = !ui.showModels; if (ui.showModels && ![...ui.expanded].length) ui.expanded = new Set(provModels.keys()); modelsBtn.setAttribute('aria-pressed', String(ui.showModels)); modelsBtn.textContent = ui.showModels ? t('map.hideModels') : t('map.showModels'); draw(); fit(); } }, ui.showModels ? t('map.hideModels') : t('map.showModels'));
  const resetBtn = h('button', { class: 'btn sm', onclick: () => { ui.custom = {}; ui.selected = null; ui.query = ''; search.value = ''; ui.hidden.clear(); paintChips(); renderSide(); draw(); fit(); } }, t('map.reset'));
  const full = h('button', { class: 'btn sm', 'aria-label': t('map.fullscreen'), onclick: () => { if (document.fullscreenElement) document.exitFullscreen(); else box.requestFullscreen && box.requestFullscreen(); } }, '⛶');
  const bar = h('div', { class: 'mapbar' }, search, chips, h('span', { class: 'grow' }), h('span', { class: 'muted sm' }, t('map.counts', { p: nProv, m: nModels })), modelsBtn,
    h('div', { class: 'row', style: { gap: '4px' } }, h('button', { class: 'btn sm', 'aria-label': 'zoom in', onclick: () => zoomAt({ x: 0, y: 0 }, 1.25, true) }, '＋'), h('button', { class: 'btn sm', 'aria-label': 'zoom out', onclick: () => zoomAt({ x: 0, y: 0 }, 0.8, true) }, '－'), h('button', { class: 'btn sm', onclick: fit }, t('map.fit')), resetBtn, full));
  const box = h('div', { class: 'mapbox' }, svg, tip, side, h('div', { class: 'maphint muted' }, t('map.hint')));
  clear(root).append(h('div', { class: 'wrap' }, h('h2', null, t('map.title')), h('p', { class: 'muted' }, t('map.intro') + (d.truncatedModels ? ' ' + t('map.truncated', { n: d.truncatedModels }) : '')), bar, box));
  draw(); fit(); renderSide();

  // animate ONLY while a real request is routing (unchanged behaviour)
  const poll = setInterval(() => { if (!document.body.contains(box)) { clearInterval(poll); return; } const act = state.activeRoute || []; for (const l of edgeEls) l.classList.toggle('flow', act.includes(l.dataset.to)); }, 500);
}
