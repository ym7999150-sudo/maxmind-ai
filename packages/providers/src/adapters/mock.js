'use strict';
/**
 * DEVELOPMENT / MOCK adapter. Only registered when DEV_MOCK=1 and NODE_ENV!=='production'.
 * Everything it returns is labelled mock; usage is flagged mock so it can never be mistaken for real measurements.
 */
const { ProviderError } = require('@maxmind-ai/core');
const { UNKNOWN_CAPS } = require('./common');
const MODELS = [
  { id: 'mock-fast', vision: false }, { id: 'mock-smart', vision: false }, { id: 'mock-vision', vision: true }, { id: 'mock-broken', vision: false }
];
const approx = (s) => Math.ceil(String(s).length / 4);
const bad = (c) => c.apiKey !== 'mock-valid-key' && !/^mock-/.test(c.apiKey || '');
async function listModels(c) {
  if (bad(c)) throw new ProviderError('AUTH_FAILED', 'Invalid mock key', { httpStatus: 401 });
  return MODELS.map((m) => ({ modelId: m.id, name: `[MOCK] ${m.id}`, kind: 'chat', kindSource: 'mock', capabilities: { ...UNKNOWN_CAPS(), chat: true, vision: m.vision, streaming: true },
    contextWindow: 8192, inputModalities: m.vision ? ['text', 'image'] : ['text'], outputModalities: ['text'], pricing: null, owner: 'mock' }));
}
const flat = (m) => typeof m.content === 'string' ? m.content : m.content.filter((p) => p.type === 'text').map((p) => p.text).join(' ');
async function chat(c, req) {
  if (bad(c)) throw new ProviderError('AUTH_FAILED', 'Invalid mock key', { httpStatus: 401 });
  if (req.model === 'mock-broken') throw new ProviderError('SERVER', 'mock-broken always fails', { httpStatus: 500 });
  const last = flat(req.messages[req.messages.length - 1]);
  const content = `[MOCK:${req.model}] ${/^Reply with the single word/.test(last) ? 'ok' : 'Mock answer to: ' + last.slice(0, 200)}`;
  const input = approx(JSON.stringify(req.messages) + (req.system || '')), output = approx(content);
  return { content, finishReason: 'stop', usage: { input, output, total: input + output, mock: true } };
}
async function streamChat(c, req, onDelta) { const r = await chat(c, req); for (const w of r.content.split(/(\s+)/)) if (w) onDelta(w); return r; }
const healthCheck = async (c, id) => { try { await chat(c, { model: id, messages: [{ role: 'user', content: 'Reply with the single word: ok' }] }); return { state: 'HEALTHY', latencyMs: 1, httpStatus: 200, error: null }; } catch (e) { return { state: e.kind === 'AUTH_FAILED' ? 'AUTH_FAILED' : 'DEGRADED', latencyMs: 1, httpStatus: e.httpStatus || null, error: e.message }; } };
module.exports = { id: 'mock', validateKey: async (c) => { const models = await listModels(c); return { valid: true, modelCount: models.length, models }; },
  listModels, chat, streamChat, healthCheck, getCapabilities: async () => ({ source: 'mock' }) };
