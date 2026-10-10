'use strict';
const { request, ProviderError, UNSUPPORTED } = require('@maxmind-ai/core');
const { sseData } = require('../sse');
const { UNKNOWN_CAPS, timedHealth } = require('./common');

const base = (c) => c.baseUrl.replace(/\/+$/, '');
const hdr = (c) => ({ 'Content-Type': 'application/json', 'x-goog-api-key': c.apiKey }); // header, never URL
const opts = (c, o = {}) => ({ allowInsecureLocal: c.allowInsecureLocal, secrets: [c.apiKey], ...o });

function extractModel(m) {
  const id = String(m.name || '').replace(/^models\//, '');
  const methods = m.supportedGenerationMethods || [];
  const caps = UNKNOWN_CAPS();
  if (methods.length) { caps.chat = methods.includes('generateContent'); caps.embeddings = methods.includes('embedContent') || methods.includes('batchEmbedContents'); }
  const kind = caps.chat === true ? 'chat' : caps.embeddings === true ? 'embedding' : (methods.length ? 'other' : 'unknown');
  return { modelId: id, name: m.displayName || id, kind, kindSource: methods.length ? 'metadata' : 'none', capabilities: caps,
    contextWindow: m.inputTokenLimit || null, outputLimit: m.outputTokenLimit || null, inputModalities: null, outputModalities: null, pricing: null, owner: 'google', methods };
}
async function listModels(c) {
  const out = []; let tok = null;
  for (let i = 0; i < 10; i++) {
    const { data } = await request(`${base(c)}/models?pageSize=1000${tok ? `&pageToken=${encodeURIComponent(tok)}` : ''}`, { headers: hdr(c), ...opts(c, { timeoutMs: 20000 }) });
    if (!Array.isArray(data.models)) throw new ProviderError('INVALID_REQUEST', 'Unexpected /models response shape');
    out.push(...data.models.map(extractModel)); if (!data.nextPageToken) break; tok = data.nextPageToken;
  }
  return out;
}
const validateKey = async (c) => { const models = await listModels(c); return { valid: true, modelCount: models.length, models }; };

function payload(req) {
  const contents = req.messages.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user',
    parts: typeof m.content === 'string' ? [{ text: m.content }] : m.content.map((p) => p.type === 'image' ? { inlineData: { mimeType: p.mime, data: p.data } } : { text: p.text }) }));
  const b = { contents, generationConfig: {} };
  if (req.maxTokens) b.generationConfig.maxOutputTokens = req.maxTokens;
  if (req.temperature != null) b.generationConfig.temperature = req.temperature;
  if (req.system) b.systemInstruction = { parts: [{ text: req.system }] };
  return JSON.stringify(b);
}
const textFrom = (d) => ((d.candidates && d.candidates[0] && d.candidates[0].content && d.candidates[0].content.parts) || []).filter((p) => !p.thought && p.text).map((p) => p.text).join('');
const usageOf = (u) => u && u.promptTokenCount != null ? { input: u.promptTokenCount, output: u.totalTokenCount != null ? u.totalTokenCount - u.promptTokenCount : (u.candidatesTokenCount || 0), total: u.totalTokenCount ?? u.promptTokenCount + (u.candidatesTokenCount || 0) } : null;

async function chat(c, req) {
  const { data } = await request(`${base(c)}/models/${encodeURIComponent(req.model)}:generateContent`, { method: 'POST', headers: hdr(c), body: payload(req), signal: req.signal,
    ...opts(c, { retries: req.retries ?? 2, timeoutMs: req.timeoutMs || 90000 }) });
  return { content: textFrom(data), finishReason: data.candidates && data.candidates[0] && data.candidates[0].finishReason || null, usage: usageOf(data.usageMetadata) };
}
async function streamChat(c, req, onDelta) {
  const resp = await request(`${base(c)}/models/${encodeURIComponent(req.model)}:streamGenerateContent?alt=sse`, { method: 'POST', headers: hdr(c), body: payload(req), signal: req.signal,
    ...opts(c, { retries: req.retries ?? 1, timeoutMs: req.timeoutMs || 90000, stream: true }) });
  let content = '', usage = null, finish = null;
  for await (const d of sseData(resp)) {
    let j; try { j = JSON.parse(d); } catch { continue; }
    const t = textFrom(j); if (t) { content += t; onDelta(t); }
    if (j.usageMetadata) usage = usageOf(j.usageMetadata);
    const fr = j.candidates && j.candidates[0] && j.candidates[0].finishReason; if (fr) finish = fr;
  }
  return { content, finishReason: finish, usage };
}
async function countTokens(c, { model, text }) {
  const { data } = await request(`${base(c)}/models/${encodeURIComponent(model)}:countTokens`, { method: 'POST', headers: hdr(c), body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text }] }] }), ...opts(c, { retries: 1 }) });
  return { tokens: data.totalTokens };
}
const healthCheck = (c, modelId) => timedHealth(() => chat(c, { model: modelId, messages: [{ role: 'user', content: 'Reply with the single word: ok' }], maxTokens: 16, retries: 1, timeoutMs: 25000 }));

module.exports = { id: 'gemini', validateKey, listModels, healthCheck, chat, streamChat, countTokens, extractModel,
  getCapabilities: async () => ({ source: 'GET /models supportedGenerationMethods' }),
  generateImage: async () => UNSUPPORTED, transcribe: async () => UNSUPPORTED, embed: async () => UNSUPPORTED, getUsage: async () => UNSUPPORTED };
