'use strict';
const { norm, tokens } = require('./text');

/** Heuristic task analyzer (keyword/structure based, EN + AR). It is a classifier, not an AI call — zero tokens. */
const TYPE_TERMS = {
  coding: ['code', 'coding', 'program', 'function', 'bug', 'debug', 'api', 'react', 'node', 'python', 'javascript', 'typescript', 'sql', 'backend', 'frontend', 'refactor', 'implement', 'class', 'compile', 'error', 'stack', 'authentication', 'endpoint', 'database', 'برمج', 'كود', 'برمجه', 'دال', 'خطا', 'اصلح', 'قاعده', 'بيانات', 'واجهه'],
  writing: ['write', 'rewrite', 'draft', 'email', 'paragraph', 'essay', 'marketing', 'copy', 'blog', 'story', 'poem', 'tone', 'اكتب', 'اعد', 'صياغه', 'فقره', 'مقال', 'رسايل', 'رساله', 'تسويق', 'قصه'],
  summarization: ['summarize', 'summary', 'tldr', 'condense', 'shorten', 'لخص', 'تلخيص', 'ملخص', 'اختصر'],
  analysis: ['analyze', 'analyse', 'compare', 'comparison', 'evaluate', 'trade-off', 'tradeoff', 'architecture', 'architectures', 'reason', 'why', 'pros', 'cons', 'strategy', 'حلل', 'تحليل', 'قارن', 'مقارنه', 'معماريه', 'معماريات', 'قيم', 'لماذا'],
  research: ['research', 'find', 'sources', 'latest', 'explain', 'what', 'history', 'overview', 'ابحث', 'بحث', 'اشرح', 'ما هو', 'مصادر'],
  translation: ['translate', 'translation', 'ترجم', 'ترجمه'],
  math: ['calculate', 'equation', 'solve', 'proof', 'integral', 'math', 'احسب', 'معادله', 'حل', 'رياضيات'],
  vision: ['image', 'photo', 'picture', 'screenshot', 'diagram', 'صوره', 'صور', 'لقطه']
};
const COMPLEX_TERMS = ['architecture', 'architectures', 'design', 'system', 'compare', 'trade-off', 'tradeoff', 'authentication', 'migrate', 'refactor', 'implement', 'full', 'end-to-end', 'scalable', 'microservice', 'security', 'optimize', 'strategy', 'step by step', 'معماريه', 'معماريات', 'نظام', 'قارن', 'ابني', 'ابنِ', 'تصميم', 'مصادقه', 'امان', 'كامل', 'خطوه'];
const ROLE_FOR_TYPE = { coding: 'coder', writing: 'writer', summarization: 'writer', analysis: 'analyst', research: 'researcher', translation: 'writer', math: 'analyst', vision: 'vision', chat: 'generalist' };

function estimateTokens(s) { s = String(s || ''); let a = 0, o = 0; for (const ch of s) { if (ch.charCodeAt(0) < 128) a++; else o++; } return Math.ceil(a / 4 + o / 1.8); }

function analyzeTask({ text = '', hasImage = false, hasDocument = false, extraTokens = 0, critical = false } = {}) {
  const tk = new Set(tokens(text)); const low = norm(text);
  const scores = {};
  for (const [type, terms] of Object.entries(TYPE_TERMS)) {
    let s = 0; for (const t of terms) { const nt = norm(t); if (nt.includes(' ') ? low.includes(nt) : tk.has(nt)) s++; } scores[type] = s;
  }
  if (/```|=>|\bfunction\b|\bdef\b|\bclass\b|#include|SELECT\s.+FROM/i.test(text)) scores.coding += 2;
  if (hasImage) scores.vision += 3;
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]).filter(([, s]) => s > 0);
  const type = ranked.length ? ranked[0][0] : 'chat';
  let c = 0; const signals = [];
  const len = text.length;
  if (len > 400) { c++; signals.push('long_prompt'); } if (len > 1500) { c++; signals.push('very_long_prompt'); }
  let ct = 0; for (const t of COMPLEX_TERMS) { const nt = norm(t); if (nt.includes(' ') ? low.includes(nt) : tk.has(nt)) ct++; }
  if (ct) { c += Math.min(2, ct); signals.push('complexity_terms:' + ct); }
  if (/```/.test(text)) { c++; signals.push('code_block'); }
  const qs = (text.match(/[?؟]/g) || []).length + (text.match(/^\s*\d+[.)]/gm) || []).length;
  if (qs >= 3) { c++; signals.push('multi_part'); }
  if (hasDocument) { c++; signals.push('document'); }
  if (len < 80 && ct === 0 && !hasDocument) c = 0;
  let complexity = c === 0 ? 'simple' : c <= 2 ? 'medium' : 'complex';
  if (critical) { complexity = 'critical'; signals.push('user_marked_critical'); }
  return { type, scores, requiredCaps: { vision: !!hasImage }, complexity, estimatedInputTokens: estimateTokens(text) + extraTokens, signals,
    suggestedRole: ROLE_FOR_TYPE[type] || 'generalist', terms: [...new Set([...tk].slice(0, 80))] };
}
module.exports = { analyzeTask, TYPE_TERMS, ROLE_FOR_TYPE, estimateTokens };
