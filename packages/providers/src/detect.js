'use strict';
/**
 * Provider detection. Prefix/shape = HINT only. Only providers in the registry whose key shape matches
 * are ever contacted, always over HTTPS (enforced by core.request). A provider is "confirmed" only
 * after it returns a valid authenticated response (GET /models).
 */
function hints(key, registry) {
  const k = String(key || '').trim();
  return registry.list().filter((d) => d.keyPatterns.some((p) => new RegExp(p).test(k)))
    .sort((a, b) => b.hintPriority - a.hintPriority).map((d) => d.id);
}
const validKeyShape = (k) => typeof k === 'string' && k.length >= 8 && k.length <= 600 && !/\s/.test(k);

async function detect(key, registry, getAdapter, { allowInsecureLocal = false } = {}) {
  const k = String(key || '').trim();
  if (!validKeyShape(k)) return { provider: null, confidence: 'none', attempted: [], reason: 'invalid_key_shape' };
  const candidates = hints(k, registry);
  const attempted = [];
  for (const id of candidates) {
    const def = registry.get(id);
    try {
      const r = await getAdapter(def).validateKey({ baseUrl: def.apiBaseUrl, apiKey: k, allowInsecureLocal });
      attempted.push({ id, result: 'valid' });
      return { provider: id, confidence: 'confirmed', attempted, validation: r };
    } catch (e) {
      attempted.push({ id, result: e.kind || 'error', message: String(e.message).slice(0, 160) });
      if (e.kind === 'RATE_LIMITED') return { provider: id, confidence: 'likely_rate_limited', attempted };
    }
  }
  return { provider: null, confidence: 'none', attempted, reason: candidates.length ? 'no_candidate_confirmed' : 'no_matching_format' };
}
module.exports = { detect, hints, validKeyShape };
