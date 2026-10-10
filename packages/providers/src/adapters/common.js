'use strict';
const { HEALTH, ProviderError } = require('@maxmind-ai/core');

const UNKNOWN_CAPS = () => ({ chat: 'unknown', vision: 'unknown', audioInput: 'unknown', audioOutput: 'unknown',
  imageGeneration: 'unknown', toolCalling: 'unknown', streaming: 'unknown', embeddings: 'unknown', structuredOutput: 'unknown' });

/** Non-chat model kinds inferred from the id ONLY when the provider exposes no metadata. Flagged as 'id-pattern'. */
function kindFromId(id) {
  const s = String(id).toLowerCase();
  if (/embed/.test(s)) return 'embedding';
  if (/whisper|transcri|tts|speech|audio-preview|realtime/.test(s)) return 'audio';
  if (/dall-e|gpt-image|imagen|stable-diffusion|sdxl|flux/.test(s)) return 'image';
  if (/moderation|guard|rerank/.test(s)) return 'moderation';
  return 'unknown';
}
const NON_CHAT_KINDS = ['embedding', 'audio', 'image', 'moderation'];

function stateFromError(err) {
  if (!(err instanceof ProviderError)) return { state: HEALTH.UNKNOWN };
  switch (err.kind) {
    case 'AUTH_FAILED': return { state: HEALTH.AUTH_FAILED };
    case 'RATE_LIMITED': return { state: HEALTH.RATE_LIMITED };
    case 'TIMEOUT': return { state: HEALTH.TIMEOUT };
    case 'SERVER': return { state: HEALTH.DEGRADED };
    case 'ABORTED': return { state: HEALTH.UNKNOWN };
    default: return { state: HEALTH.UNAVAILABLE }; // UNAVAILABLE, INVALID_REQUEST, NETWORK
  }
}

/** Shared health-check wrapper: times a minimal chat call and normalizes the outcome. */
async function timedHealth(fn, degradedMs = 20000) {
  const t0 = Date.now();
  try {
    const out = await fn();
    const latencyMs = Date.now() - t0;
    return { state: latencyMs > degradedMs ? HEALTH.DEGRADED : HEALTH.HEALTHY, latencyMs, httpStatus: 200, error: null, usage: out && out.usage || null };
  } catch (e) {
    return { ...stateFromError(e), latencyMs: Date.now() - t0, httpStatus: e.httpStatus || null, error: String(e.message || e).slice(0, 300), kind: e.kind || null };
  }
}
const textOf = (c) => typeof c === 'string' ? c : (c || []).filter((p) => p.type === 'text').map((p) => p.text).join('\n');
module.exports = { UNKNOWN_CAPS, kindFromId, NON_CHAT_KINDS, stateFromError, timedHealth, textOf };
