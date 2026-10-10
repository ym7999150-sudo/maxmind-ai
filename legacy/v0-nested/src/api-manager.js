// ============================================================================
// MuxMind AI — src/api-manager.js
// Standalone API Key Manager, Key Validation & Model Discovery
// ============================================================================

const fetch = require("node-fetch");
const { PROVIDERS } = require("./config");

/**
 * In-memory key store (per-process). Keys are supplied by the client from the
 * browser's API Manager modal and never written to disk.
 * Structure: { [providerId]: { key: string, validatedAt: number, models: [] } }
 */
const keyStore = {};

function setKey(providerId, key) {
  if (!PROVIDERS[providerId]) throw new Error(`Unknown provider: ${providerId}`);
  keyStore[providerId] = keyStore[providerId] || {};
  keyStore[providerId].key = key;
  return true;
}

function getKey(providerId) {
  return (keyStore[providerId] && keyStore[providerId].key) || process.env[PROVIDERS[providerId]?.envKey] || null;
}

function buildUrl(provider, key) {
  if (provider.keyAsQueryParam) {
    const sep = provider.modelsEndpoint.includes("?") ? "&" : "?";
    return `${provider.modelsEndpoint}${sep}key=${encodeURIComponent(key)}`;
  }
  return provider.modelsEndpoint;
}

/**
 * Validates a key by pinging the provider's models endpoint.
 * Returns { valid, latencyMs, models, error }
 */
async function validateKey(providerId, key) {
  const provider = PROVIDERS[providerId];
  if (!provider) return { valid: false, error: "Unknown provider" };

  const start = Date.now();
  try {
    const url = buildUrl(provider, key);
    const headers = provider.authHeader(key);

    const res = await fetch(url, { method: "GET", headers, timeout: 10000 });
    const latencyMs = Date.now() - start;

    if (!res.ok) {
      return {
        valid: false,
        latencyMs,
        error: `HTTP ${res.status} — Invalid Key / Access Denied`,
      };
    }

    const data = await res.json().catch(() => ({}));
    const models = extractModelList(providerId, data);

    keyStore[providerId] = { key, validatedAt: Date.now(), models };

    return { valid: true, latencyMs, models };
  } catch (err) {
    return { valid: false, latencyMs: Date.now() - start, error: err.message };
  }
}

/**
 * Normalizes each provider's models response into a flat array of model IDs.
 */
function extractModelList(providerId, data) {
  try {
    switch (providerId) {
      case "anthropic":
        return (data.data || []).map((m) => m.id);
      case "google":
        return (data.models || [])
          .map((m) => m.name.replace("models/", ""))
          .filter((id) => id.includes("gemini"));
      case "groq":
        return (data.data || []).map((m) => m.id);
      case "openrouter":
        return (data.data || []).map((m) => m.id);
      case "mistral":
        return (data.data || []).map((m) => m.id);
      case "deepseek":
        return (data.data || []).map((m) => m.id);
      default:
        return [];
    }
  } catch {
    return [];
  }
}

function getCachedModels(providerId) {
  return (keyStore[providerId] && keyStore[providerId].models) || [];
}

function listProviderMeta() {
  return Object.values(PROVIDERS).map((p) => ({
    id: p.id,
    name: p.name,
    consoleUrl: p.consoleUrl,
    docsUrl: p.docsUrl,
    pricingUrl: p.pricingUrl,
    freeTier: p.freeTier,
    freeNote: p.freeNote,
    hasKey: !!getKey(p.id),
  }));
}

module.exports = {
  setKey,
  getKey,
  validateKey,
  getCachedModels,
  listProviderMeta,
};
