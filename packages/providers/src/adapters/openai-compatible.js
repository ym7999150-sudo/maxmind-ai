'use strict';
const { request, ProviderError, UNSUPPORTED } = require('@maxmind-ai/core');
const { sseData } = require('../sse');
const { UNKNOWN_CAPS, kindFromId, timedHealth } = require('./common');

/**
 * Generic adapter for any service exposing OpenAI-style /models and /chat/completions.
 * conn = { baseUrl, apiKey, allowInsecureLocal }. Capabilities are read from whatever the
 * service's /models response actually contains; everything else stays 'unknown'.
 */
const base = (c) => c.baseUrl.replace(/\/+$/, '');
const hdr = (c) => ({ 'Content-Type': 'application/json', ...(c.apiKey ? { Authorization: `Bearer ${c.apiKey}` } : {}) });
const opts = (c, o = {}) => ({ allowInsecureLocal: c.allowInsecureLocal, secrets: [c.apiKey], ...o });
const paramMemo = new Map(); // learned per base+model: { maxTokensParam, temperature }

function per1M(v) { const n = parseFloat(v); return Number.isFinite(n) && n >= 0 ? +(n * 1e6).toFixed(6) : null; }

function extractModel(m) {
  const id = String(m.id || m.name || '');
  const caps = UNKNOWN_CAPS();
  let contextWindow = m.context_length || m.context_window || m.max_context_length || m.max_model_len || null;
  let inputModalities = null, outputModalities = null, pricing = null, kind = 'unknown', kindSource = 'none';
  if (m.architecture) {
    inputModalities = m.architecture.input_modalities || null; outputModalities = m.architecture.output_modalities || null;
    if (inputModalities) { caps.vision = inputModalities.includes('image'); caps.audioInput = inputModalities.includes('audio'); }
    if (outputModalities) {
      caps.imageGeneration = outputModalities.includes('image'); caps.audioOutput = outputModalities.includes('audio');
      caps.chat = outputModalities.includes('text');
      kind = caps.chat ? 'chat' : (caps.imageGeneration ? 'image' : 'unknown'); kindSource = 'metadata';
    }
  }
  if (Array.isArray(m.supported_parameters)) {
    caps.toolCalling = m.supported_parameters.includes('tools');
    caps.structuredOutput = m.supported_parameters.includes('structured_outputs') || m.supported_parameters.includes('response_format');
  }
  if (m.capabilities && typeof m.capabilities === 'object') {
    const c = m.capabilities;
    if ('completion_chat' in c) { caps.chat = !!c.completion_chat; kind = caps.chat ? 'chat' : kind; kindSource = 'metadata'; }
    if ('vision' in c) caps.vision = !!c.vision;
    if ('function_calling' in c) caps.toolCalling = !!c.function_calling;
  }
  if (m.pricing && typeof m.pricing === 'object') {
    pricing = { inputPer1M: per1M(m.pricing.prompt), outputPer1M: per1M(m.pricing.completion),
      cachedInputPer1M: per1M(m.pricing.input_cache_read), imagePerUnit: per1M(m.pricing.image) != null ? parseFloat(m.pricing.image) : null, source: 'provider-api' };
    if (pricing.inputPer1M == null && pricing.outputPer1M == null) pricing = null;
  }
  if (kind === 'unknown') { const k = kindFromId(id); if (k !== 'unknown') { kind = k; kindSource = 'id-pattern'; if (k !== 'unknown') caps.chat = false; if (k === 'embedding') caps.embeddings = true; if (k === 'image') caps.imageGeneration = true; } }
  return { modelId: id, name: m.name || m.display_name || id, kind, kindSource, capabilities: caps, contextWindow: contextWindow ? +contextWindow : null,
    inputModalities, outputModalities, pricing, owner: m.owned_by || null };
}

async function listModels(c) {
  const { data } = await request(`${base(c)}/models`, { headers: hdr(c), ...opts(c, { retries: 2, timeoutMs: 20000 }) });
  const arr = Array.isArray(data) ? data : Array.isArray(data.data) ? data.data : Array.isArray(data.models) ? data.models : null;
  if (!arr) throw new ProviderError('INVALID_REQUEST', 'Unexpected /models response shape (not OpenAI-compatible?)');
  return arr.map(extractModel).filter((m) => m.modelId);
}
const validateKey = async (c) => { const models = await listModels(c); return { valid: true, modelCount: models.length, models }; };

function toMsgs(req) {
  const out = [];
  if (req.system) out.push({ role: 'system', content: req.system });
  for (const m of req.messages) {
    if (typeof m.content === 'string') { out.push({ role: m.role, content: m.content }); continue; }
    out.push({ role: m.role, content: m.content.map((p) => p.type === 'image'
      ? { type: 'image_url', image_url: { url: `data:${p.mime};base64,${p.data}` } } : { type: 'text', text: p.text }) });
  }
  return out;
}

async function post(c, req, extra, signal) {
  const key = `${base(c)}|${req.model}`;
  const memo = paramMemo.get(key) || { maxTokensParam: 'max_tokens', temperature: true };
  for (let attempt = 0; attempt < 3; attempt++) {
    const body = { model: req.model, messages: toMsgs(req), ...extra };
    if (req.maxTokens) body[memo.maxTokensParam] = req.maxTokens;
    if (req.temperature != null && memo.temperature) body.temperature = req.temperature;
    try {
      const r = await request(`${base(c)}/chat/completions`, { method: 'POST', headers: hdr(c), body: JSON.stringify(body),
        signal, ...opts(c, { retries: req.retries ?? 2, timeoutMs: req.timeoutMs || 90000, stream: !!extra.stream }) });
      paramMemo.set(key, memo); return r;
    } catch (e) {
      // Adapt to what the API actually says instead of assuming (e.g. reasoning models).
      if (e.kind === 'INVALID_REQUEST' && memo.maxTokensParam === 'max_tokens' && /max_completion_tokens/.test(e.message)) { memo.maxTokensParam = 'max_completion_tokens'; continue; }
      if (e.kind === 'INVALID_REQUEST' && memo.temperature && /temperature/i.test(e.message)) { memo.temperature = false; continue; }
      throw e;
    }
  }
  throw new ProviderError('INVALID_REQUEST', 'Provider rejected request parameters');
}
const usageOf = (u) => u && (u.prompt_tokens != null || u.completion_tokens != null)
  ? { input: u.prompt_tokens || 0, output: u.completion_tokens || 0, total: u.total_tokens ?? (u.prompt_tokens || 0) + (u.completion_tokens || 0) } : null;

async function chat(c, req) {
  const { data } = await post(c, req, {}, req.signal);
  const ch = data.choices && data.choices[0];
  return { content: (ch && ch.message && (typeof ch.message.content === 'string' ? ch.message.content : '')) || '', finishReason: ch && ch.finish_reason || null, usage: usageOf(data.usage) };
}
async function streamChat(c, req, onDelta) {
  const resp = await post(c, req, { stream: true, stream_options: { include_usage: true } }, req.signal);
  let content = '', usage = null, finish = null;
  for await (const d of sseData(resp)) {
    if (d === '[DONE]') break;
    let j; try { j = JSON.parse(d); } catch { continue; }
    const ch = j.choices && j.choices[0];
    const t = ch && ch.delta && ch.delta.content;
    if (t) { content += t; onDelta(t); }
    if (ch && ch.finish_reason) finish = ch.finish_reason;
    if (j.usage) usage = usageOf(j.usage);
  }
  return { content, finishReason: finish, usage };
}
const healthCheck = (c, modelId) => timedHealth(() => chat(c, { model: modelId, messages: [{ role: 'user', content: 'Reply with the single word: ok' }], maxTokens: 16, retries: 1, timeoutMs: 25000 }));

async function generateImage(c, { model, prompt, signal }) {
  const { data } = await request(`${base(c)}/images/generations`, { method: 'POST', headers: hdr(c), body: JSON.stringify({ model, prompt, n: 1 }), signal, ...opts(c, { retries: 1, timeoutMs: 120000 }) });
  const it = data.data && data.data[0];
  if (!it) throw new ProviderError('INVALID_REQUEST', 'No image returned');
  return { b64: it.b64_json || null, url: it.url || null, usage: usageOf(data.usage) };
}
async function transcribe(c, { model, audio, mime, filename = 'audio.webm', signal }) {
  const fd = new FormData(); fd.append('model', model); fd.append('file', new Blob([audio], { type: mime }), filename);
  const h = { ...(c.apiKey ? { Authorization: `Bearer ${c.apiKey}` } : {}) };
  const { data } = await request(`${base(c)}/audio/transcriptions`, { method: 'POST', headers: h, body: fd, signal, ...opts(c, { retries: 1, timeoutMs: 120000 }) });
  return { text: data.text || '' };
}

module.exports = { id: 'openai-compatible', validateKey, listModels, healthCheck, chat, streamChat, generateImage, transcribe,
  getCapabilities: async (c) => ({ source: 'GET /models metadata only; unknown values are verified by health checks', extractModel }),
  embed: async () => UNSUPPORTED, countTokens: async () => UNSUPPORTED, getUsage: async () => UNSUPPORTED, extractModel };
