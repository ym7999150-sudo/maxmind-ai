// ============================================================================
// MuxMind AI — src/router.js
// Zero-Latency Multi-Tier Heuristic Task Router + Infinite Fallback Pipeline
// ============================================================================

const fetch = require("node-fetch");
const { PROVIDERS, ROUTING_TIERS, HEURISTICS } = require("./config");
const { getKey } = require("./api-manager");

function classifyPrompt(prompt = "") {
  const p = prompt.toLowerCase();
  if (HEURISTICS.tier3_keywords.some((kw) => p.includes(kw))) return "tier3_deep";
  if (HEURISTICS.tier1_keywords.some((kw) => p.startsWith(kw)) || p.length < 40) return "tier1_instant";
  return "tier2_balanced";
}

function buildRequestPayload(providerId, model, messages) {
  switch (providerId) {
    case "anthropic":
      return {
        url: "https://api.anthropic.com/v1/messages",
        body: { model, max_tokens: 4096, messages },
        extraHeaders: { "content-type": "application/json" },
      };
    case "google":
      return {
        url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        body: {
          contents: messages.map((m) => ({
            role: m.role === "assistant" ? "model" : "user",
            parts: [{ text: m.content }],
          })),
        },
        extraHeaders: { "content-type": "application/json" },
        keyAsQueryParam: true,
      };
    case "groq":
    case "openrouter":
    case "mistral":
    case "deepseek":
      return {
        url:
          providerId === "groq"
            ? "https://api.groq.com/openai/v1/chat/completions"
            : providerId === "openrouter"
            ? "https://openrouter.ai/api/v1/chat/completions"
            : providerId === "mistral"
            ? "https://api.mistral.ai/v1/chat/completions"
            : "https://api.deepseek.com/v1/chat/completions",
        body: { model, messages },
        extraHeaders: { "content-type": "application/json" },
      };
    default:
      throw new Error(`No payload builder for provider: ${providerId}`);
  }
}

function extractText(providerId, data) {
  try {
    switch (providerId) {
      case "anthropic":
        return data.content?.map((c) => c.text).join("") || "";
      case "google":
        return data.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "";
      case "groq":
      case "openrouter":
      case "mistral":
      case "deepseek":
        return data.choices?.[0]?.message?.content || "";
      default:
        return "";
    }
  } catch {
    return "";
  }
}

/**
 * Attempts each candidate in a tier in order. On 429/5xx or missing key,
 * silently falls through to the next candidate ("Infinite Fallback Pipeline").
 */
async function routeAndExecute({ prompt, history = [], forceProvider = null, forceModel = null }) {
  const tierId = classifyPrompt(prompt);
  const tier = ROUTING_TIERS[tierId];

  const candidates = forceProvider
    ? [{ provider: forceProvider, model: forceModel }]
    : tier.candidates;

  const messages = [...history, { role: "user", content: prompt }];

  let lastError = null;

  for (const candidate of candidates) {
    const provider = PROVIDERS[candidate.provider];
    const key = getKey(candidate.provider);

    if (!key) {
      lastError = `${provider.name}: no API key configured`;
      continue;
    }

    try {
      const { url, body, extraHeaders, keyAsQueryParam } = buildRequestPayload(
        candidate.provider,
        candidate.model,
        messages
      );

      const finalUrl = keyAsQueryParam
        ? `${url}?key=${encodeURIComponent(key)}`
        : url;

      const headers = { ...extraHeaders, ...provider.authHeader(key) };

      const res = await fetch(finalUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        timeout: 60000,
      });

      if (res.status === 429 || res.status >= 500) {
        lastError = `${provider.name}: HTTP ${res.status}, falling back`;
        continue; // silent migration to next candidate
      }

      if (!res.ok) {
        lastError = `${provider.name}: HTTP ${res.status}`;
        continue;
      }

      const data = await res.json();
      const text = extractText(candidate.provider, data);

      return {
        success: true,
        tier: tierId,
        tierLabel: tier.label,
        provider: candidate.provider,
        model: candidate.model,
        text,
      };
    } catch (err) {
      lastError = `${provider.name}: ${err.message}`;
      continue;
    }
  }

  return {
    success: false,
    tier: tierId,
    tierLabel: tier.label,
    error: lastError || "No provider available for this tier",
  };
}

module.exports = { classifyPrompt, routeAndExecute };
