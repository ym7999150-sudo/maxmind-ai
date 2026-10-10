'use strict';
const { request, ProviderError, UNSUPPORTED } = require('@maxmind-ai/core');
const { sseData } = require('../sse');
const { UNKNOWN_CAPS, timedHealth } = require('./common');

const base = (c) => c.baseUrl.replace(/\/+$/, '');
const hdr = (c) => ({ 'Content-Type': 'application/json', 'x-api-key': c.apiKey, 'anthropic-version': '2023-06-01' });
const opts = (c, o = {}) => ({ allowInsecureLocal: c.allowInsecureLocal, secrets: [c.apiKey], ...o });

function extractModel(m) {
  const caps = UNKNOWN_CAPS();
  const c = m.capabilities;
  if (c && typeof c === 'object') {
    if (c.image_input && 'supported' in c.image_input) caps.vision = !!c.image_input.supported;
    if (c.structured_outputs && 'supported' in c.structured_outputs) caps.structuredOutput = !!c.structured_outputs.supported;
  }
  caps.chat = true; // /v1/models on Anthropic lists Messages-API models only
  return { modelId: m.id, name: m.display_name || m.id, kind: 'chat', kindSource: 'provider-api', capabilities: caps,
    contextWindow: m.max_input_tokens || null, inputModalities: null, outputModalities: null, pricing: null, owner: 'anthropic' };
}
async function listModels(c) {
  const out = []; let after = null;
  for (let i = 0; i < 10; i++) {
    const q = `limit=1000${after ? `&after_id=${encodeURIComponent(after)}` : ''}`;
    const { data } = await request(`${base(c)}/models?${q}`, { headers: hdr(c), ...opts(c, { timeoutMs: 20000 }) });
    if (!Array.isArray(data.data)) throw new ProviderError('INVALID_REQUEST', 'Unexpected /models response shape');
    out.push(...data.data.map(extractModel));
    if (!data.has_more || !data.last_id) break; after = data.last_id;
  }
  return out;
}
const validateKey = async (c) => { const models = await listModels(c); return { valid: true, modelCount: models.length, models }; };

function body(req, extra = {}) {
  const messages = req.messages.map((m) => ({ role: m.role, content: typeof m.content === 'string' ? m.content
    : m.content.map((p) => p.type === 'image' ? { type: 'image', source: { type: 'base64', media_type: p.mime, data: p.data } } : { type: 'text', text: p.text }) }));
  const b = { model: req.model, messages, max_tokens: req.maxTokens || 1024, ...extra };
  if (req.system) b.system = req.system;
  if (req.temperature != null) b.temperature = req.temperature;
  return JSON.stringify(b);
}
const usageOf = (u) => u && (u.input_tokens != null || u.output_tokens != null)
  ? { input: u.input_tokens || 0, output: u.output_tokens || 0, total: (u.input_tokens || 0) + (u.output_tokens || 0) } : null;

async function chat(c, req) {
  const { data } = await request(`${base(c)}/messages`, { method: 'POST', headers: hdr(c), body: body(req), signal: req.signal,
    ...opts(c, { retries: req.retries ?? 2, timeoutMs: req.timeoutMs || 90000 }) });
  return { content: (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join(''), finishReason: data.stop_reason || null, usage: usageOf(data.usage) };
}
async function streamChat(c, req, onDelta) {
  const resp = await request(`${base(c)}/messages`, { method: 'POST', headers: hdr(c), body: body(req, { stream: true }), signal: req.signal,
    ...opts(c, { retries: req.retries ?? 1, timeoutMs: req.timeoutMs || 90000, stream: true }) });
  let content = '', inT = 0, outT = 0, finish = null, seen = false;
  for await (const d of sseData(resp)) {
    let j; try { j = JSON.parse(d); } catch { continue; }
    if (j.type === 'message_start' && j.message && j.message.usage) { inT = j.message.usage.input_tokens || 0; outT = j.message.usage.output_tokens || 0; seen = true; }
    if (j.type === 'content_block_delta' && j.delta && j.delta.type === 'text_delta') { content += j.delta.text; onDelta(j.delta.text); }
    if (j.type === 'message_delta') { if (j.usage && j.usage.output_tokens != null) { outT = j.usage.output_tokens; seen = true; } if (j.delta && j.delta.stop_reason) finish = j.delta.stop_reason; }
    if (j.type === 'error') throw new ProviderError('SERVER', (j.error && j.error.message) || 'stream error');
  }
  return { content, finishReason: finish, usage: seen ? { input: inT, output: outT, total: inT + outT } : null };
}
const healthCheck = (c, modelId) => timedHealth(() => chat(c, { model: modelId, messages: [{ role: 'user', content: 'Reply with the single word: ok' }], maxTokens: 16, retries: 1, timeoutMs: 25000 }));

module.exports = { id: 'anthropic', validateKey, listModels, healthCheck, chat, streamChat, extractModel,
  getCapabilities: async () => ({ source: 'GET /v1/models metadata only' }),
  generateImage: async () => UNSUPPORTED, transcribe: async () => UNSUPPORTED, embed: async () => UNSUPPORTED, countTokens: async () => UNSUPPORTED, getUsage: async () => UNSUPPORTED };
