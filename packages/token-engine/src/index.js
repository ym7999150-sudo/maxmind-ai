'use strict';
/**
 * MaxMind Token Engine. All operations are LOCAL (no extra API calls, no extra tokens spent).
 * Token numbers produced here are ESTIMATES (flagged as such). Real usage comes from provider responses.
 */
const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[\u064B-\u065F\u0670\u0640]/g, '').replace(/[إأآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه');
const tokenize = (s) => norm(s).split(/[^\p{L}\p{N}_]+/u).filter((t) => t.length > 1);

// Stop-words are dropped ONLY for relevance scoring (never for cache similarity, so negations like "not" stay significant).
const STOP = new Set(('the a an and or of to in on for with is are was were be been it this that these those as at by from can could should would will you your i me my we our they them he she his her what which who how why when where do does did not please about into than then so if but just have has had there here also more some any'
  + ' في من على الى إلى عن مع هذا هذه ذلك تلك هو هي هم انا أنا انت أنت نحن ما ماذا كيف لماذا متى اين أين هل او أو ثم لكن كل بعض قد لقد كان كانت يكون التي الذي الذين').split(' ').map(norm));
const keyTokens = (s) => tokenize(s).filter((w) => !STOP.has(w));
// Estimate: ASCII ~4 chars/token, CJK ~1 char/token, other scripts (Arabic…) ~1.8 chars/token.
function estimateTokens(s) { s = String(s || ''); let a = 0, c = 0, o = 0; for (const ch of s) { const k = ch.codePointAt(0); if (k < 128) a++; else if ((k >= 0x3040 && k <= 0x9FFF) || (k >= 0xAC00 && k <= 0xD7AF)) c++; else o++; } return Math.ceil(a / 4 + c + o / 1.8); }
/** Lossless-in-meaning whitespace squeeze (outside fenced code): fewer wasted tokens, same content. */
function squeeze(text) {
  return String(text || '').split(/(```[\s\S]*?```)/g).map((part, i) => i % 2 ? part : part.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ')).join('').trim();
}
/** Shorten long fenced code blocks to first/last lines (code is the most token-expensive part of old turns). */
function trimCode(text, maxLines = 14) {
  return String(text || '').replace(/```([^\n`]*)\n([\s\S]*?)```/g, (m, lang, body) => {
    const lines = body.split('\n'); if (lines.length <= maxLines) return m;
    const head = lines.slice(0, Math.ceil(maxLines * 0.6)), tail = lines.slice(-Math.floor(maxLines * 0.4));
    return '```' + lang + '\n' + head.join('\n') + `\n… [${lines.length - head.length - tail.length} lines omitted] …\n` + tail.join('\n') + '```';
  });
}
/** BM25-style inverse-document-frequency weights over a set of token lists (rare words matter more than common ones). */
function idfMap(docs) { const df = new Map(); for (const d of docs) for (const w of new Set(d)) df.set(w, (df.get(w) || 0) + 1); const N = docs.length || 1; return (w) => Math.log(1 + (N - (df.get(w) || 0) + 0.5) / ((df.get(w) || 0) + 0.5)); }
const msgText = (m) => typeof m.content === 'string' ? m.content : (m.content || []).map((p) => p.text || '').join(' ');
const msgTokens = (m) => estimateTokens(msgText(m)) + 4;

/** Keep head and tail of a long text; code blocks keep their first lines. */
function compressText(text, maxChars) {
  text = squeeze(text);
  if (text.length <= maxChars) return text;
  text = trimCode(text); if (text.length <= maxChars) return text;
  const head = Math.floor(maxChars * 0.65), tail = Math.floor(maxChars * 0.25);
  return text.slice(0, head).trimEnd() + '\n…[trimmed ' + (text.length - head - tail) + ' chars]…\n' + text.slice(text.length - tail).trimStart();
}
const firstSentence = (t, n = 180) => { const s = String(t).replace(/```[\s\S]*?```/g, '[code]').replace(/\s+/g, ' ').trim(); const m = s.match(/^.{20,}?[.!?؟](\s|$)/); return (m ? m[0].trim() : s).slice(0, n); };

/** Extractive rolling summary (no model call): one compact line per old exchange. Idempotent: pass previous summary to extend. */
function extendSummary(prevSummary, oldMessages, maxChars = 1800) {
  const lines = prevSummary ? prevSummary.split('\n').filter(Boolean) : [];
  for (const m of oldMessages) { const f = firstSentence(m.content, m.role === 'user' ? 160 : 120); if (f.length < 8) continue; const line = `${m.role === 'user' ? 'U' : 'A'}: ${f}`; if (lines[lines.length - 1] !== line) lines.push(line); }
  let out = lines.join('\n');
  while (out.length > maxChars && lines.length > 4) { lines.splice(0, Math.ceil(lines.length / 6)); out = '[…earlier omitted]\n' + lines.join('\n'); }
  return out;
}

/** TF-overlap relevance with mild recency boost. Returns the top-k messages (kept in chronological order). */
function selectRelevant(history, query, k = 3, minScore = 0.15) {
  const q = new Set(keyTokens(query)); if (!q.size) return [];
  const toks = history.map((m) => keyTokens(msgText(m))); const idf = idfMap(toks); const qMax = [...q].reduce((a, w) => a + idf(w), 0) || 1;
  const scored = history.map((m, i) => {
    const t = toks[i]; if (!t.length) return { i, s: 0 };
    let hit = 0; for (const w of new Set(t)) if (q.has(w)) hit += idf(w);
    const len = Math.min(t.length, 200);
    return { i, s: (hit / qMax) * (1 / (1 + Math.log10(1 + len / 40))) * 2 * (1 + 0.1 * (i / history.length)) };
  }).filter((x) => x.s >= minScore).sort((a, b) => b.s - a.s).slice(0, k).sort((a, b) => a.i - b.i);
  return scored.map((x) => history[x.i]);
}

/** Jaccard similarity over normalized token sets (lexical — NOT embedding-based). */
function similarity(a, b) {
  const A = new Set(tokenize(a)), B = new Set(tokenize(b)); if (!A.size || !B.size) return 0;
  let inter = 0; for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}
function findCached(entries, query, threshold = 0.92, now = Date.now()) {
  let best = null;
  for (const e of entries) {
    if (e.expiresAt && e.expiresAt < now) continue;
    const s = e.queryNorm === norm(query).trim() ? 1 : similarity(e.query, query);
    if (s >= threshold && (!best || s > best.similarity)) best = { entry: e, similarity: +s.toFixed(3) };
  }
  return best;
}

/** Remove consecutive duplicate messages (prompt deduplication). */
function dedupeMessages(msgs) { const out = []; for (const m of msgs) { const p = out[out.length - 1]; if (p && p.role === m.role && msgText(p) === msgText(m)) continue; out.push(m); } return out; }

/**
 * Build the context actually sent to the model.
 * history: [{role,content}] chronological, EXCLUDING the new user message.
 * Strategy: last `keepLast` messages (long ones compressed) + rolling summary of the rest + top-k relevant older messages,
 * trimmed to fit budget.maxInputTokens (reserving room for system + the new user message).
 */
function buildContext({ history = [], summary = '', query = '', systemTokens = 0, userTokens = 0, budget = {}, keepLast = 4, retrieveK = 3 }) {
  const maxIn = budget.maxInputTokens || 6000;
  const originalTokens = history.reduce((a, m) => a + msgTokens(m), 0);
  const recent = history.slice(-keepLast); const older = history.slice(0, Math.max(0, history.length - keepLast));
  const relevant = selectRelevant(older, query, retrieveK);
  const compress = (m, max) => ({ role: m.role, content: compressText(msgText(m), max) }); // squeezes whitespace + trims long code
  let room = Math.max(0, maxIn - systemTokens - userTokens - 50);
  const out = []; let usedSummary = false; let dropped = 0;
  const parts = [];
  if (summary) parts.push({ kind: 'summary', tokens: estimateTokens(summary) + 6 });
  const rel = relevant.map((m) => { const c = compress(m, 900); return { kind: 'relevant', m: c, tokens: msgTokens(c) }; });
  const rec = recent.map((m, i) => { const c = compress(m, i >= recent.length - 2 ? 3500 : 900); return { kind: 'recent', m: c, tokens: msgTokens(c) }; });
  // priority: recent > summary > relevant. Trim lowest priority first.
  let total = rec.reduce((a, x) => a + x.tokens, 0) + parts.reduce((a, x) => a + x.tokens, 0) + rel.reduce((a, x) => a + x.tokens, 0);
  while (total > room && rel.length) { total -= rel.pop().tokens; dropped++; }
  let includeSummary = !!summary;
  if (total > room && includeSummary) { total -= parts[0].tokens; includeSummary = false; dropped++; }
  while (total > room && rec.length > 1) { total -= rec.shift().tokens; dropped++; }
  if (includeSummary) { out.push({ role: 'user', content: `[Conversation summary so far]\n${summary}` }, { role: 'assistant', content: 'Understood.' }); usedSummary = true; }
  const relMsgs = rel.map((x) => x.m);
  if (relMsgs.length) out.push({ role: 'user', content: '[Earlier relevant messages follow]' }, { role: 'assistant', content: 'Understood.' }, ...relMsgs);
  for (const x of rec) out.push(x.m);
  // providers need alternating roles starting with user; merge consecutive same-role messages
  const merged = [];
  for (const m of dedupeMessages(out)) { const p = merged[merged.length - 1]; if (p && p.role === m.role) p.content += '\n\n' + m.content; else merged.push({ ...m }); }
  while (merged.length && merged[0].role !== 'user') merged.shift();
  const sentTokens = merged.reduce((a, m) => a + msgTokens(m), 0);
  return { messages: merged, stats: { originalTokens, sentTokens, compressionPct: originalTokens ? Math.max(0, Math.round((1 - sentTokens / originalTokens) * 100)) : 0,
    usedSummary, retrieved: relMsgs.length, droppedParts: dropped, savedTokens: Math.max(0, originalTokens - sentTokens), estimated: true } };
}

/** Choose relevant chunks of a large document for a query, preserving order, within a token budget. */
function selectDocumentChunks(text, query, maxTokens = 1500) {
  text = String(text || ''); if (estimateTokens(text) <= maxTokens) return { text, truncated: false, chunks: 1 };
  const paras = text.split(/\n{2,}|(?<=[.!?])\s{2,}/).map((p) => p.trim()).filter(Boolean);
  const chunks = []; let cur = '';
  for (const p of paras) { if ((cur + p).length > 800 && cur) { chunks.push(cur); cur = ''; } cur += (cur ? '\n' : '') + p; } if (cur) chunks.push(cur);
  const q = new Set(keyTokens(query)); const ct = chunks.map((c) => keyTokens(c)); const idf = idfMap(ct);
  const sc = chunks.map((c, i) => { const t = ct[i]; let h = 0; for (const w of new Set(t)) if (q.has(w)) h += idf(w); return { i, s: h / Math.sqrt(1 + t.length / 50) + (i === 0 ? 0.5 : 0) }; }).sort((a, b) => b.s - a.s);
  const keep = new Set(); let used = 0; const kept = [];
  for (const x of sc) { const tk = estimateTokens(chunks[x.i]); if (used + tk > maxTokens) continue; if (kept.some((j) => similarity(chunks[j], chunks[x.i]) > 0.8)) continue; keep.add(x.i); kept.push(x.i); used += tk; }
  const sel = [...keep].sort((a, b) => a - b).map((i) => chunks[i]);
  return { text: sel.join('\n…\n'), truncated: true, chunks: sel.length, totalChunks: chunks.length };
}

/** Cost from REAL usage and officially-provided pricing only; null when pricing is unknown. */
function estimateCost(usage, pricing) {
  if (!usage || !pricing || (pricing.inputPer1M == null && pricing.outputPer1M == null)) return null;
  return ((usage.input || 0) * (pricing.inputPer1M || 0) + (usage.output || 0) * (pricing.outputPer1M || 0)) / 1e6;
}

module.exports = { squeeze, trimCode, keyTokens, estimateTokens, msgTokens, msgText, compressText, extendSummary, selectRelevant, similarity, findCached, dedupeMessages, buildContext, selectDocumentChunks, estimateCost, norm, tokenize };
