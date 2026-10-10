// ============================================================================
// MuxMind AI — src/config.js
// System Rules, Provider Catalog & Fallback Chains
// ============================================================================

/**
 * PROVIDERS
 * Each provider entry includes:
 *  - id, name, envKey
 *  - consoleUrl: where to get an API key
 *  - docsUrl: API reference docs
 *  - pricingUrl: pricing page (shows free vs paid tiers)
 *  - freeTier: boolean — does this provider offer a free tier / free credits
 *  - validateEndpoint: used by api-manager.js to ping and confirm the key works
 *  - modelsEndpoint: used to dynamically fetch the live list of available models
 *  - authHeader: function(key) => headers object
 */
const PROVIDERS = {
  anthropic: {
    id: "anthropic",
    name: "Anthropic (Claude)",
    envKey: "ANTHROPIC_API_KEY",
    consoleUrl: "https://console.anthropic.com/settings/keys",
    docsUrl: "https://docs.claude.com/en/api/overview",
    pricingUrl: "https://www.anthropic.com/pricing#api",
    freeTier: false,
    freeNote: "Paid only — new accounts sometimes get small trial credits.",
    modelsEndpoint: "https://api.anthropic.com/v1/models",
    validateEndpoint: "https://api.anthropic.com/v1/models",
    authHeader: (key) => ({
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    }),
  },
  google: {
    id: "google",
    name: "Google AI Studio (Gemini)",
    envKey: "GOOGLE_API_KEY",
    consoleUrl: "https://aistudio.google.com/app/apikey",
    docsUrl: "https://ai.google.dev/gemini-api/docs",
    pricingUrl: "https://ai.google.dev/gemini-api/docs/pricing",
    freeTier: true,
    freeNote: "Generous free tier (rate-limited) available via Google AI Studio.",
    modelsEndpoint: "https://generativelanguage.googleapis.com/v1beta/models",
    validateEndpoint: "https://generativelanguage.googleapis.com/v1beta/models",
    authHeader: () => ({}), // key passed as query param ?key=
    keyAsQueryParam: true,
  },
  groq: {
    id: "groq",
    name: "Groq",
    envKey: "GROQ_API_KEY",
    consoleUrl: "https://console.groq.com/keys",
    docsUrl: "https://console.groq.com/docs/api-reference",
    pricingUrl: "https://groq.com/pricing/",
    freeTier: true,
    freeNote: "Free tier with generous rate limits for supported open models.",
    modelsEndpoint: "https://api.groq.com/openai/v1/models",
    validateEndpoint: "https://api.groq.com/openai/v1/models",
    authHeader: (key) => ({ Authorization: `Bearer ${key}` }),
  },
  openrouter: {
    id: "openrouter",
    name: "OpenRouter",
    envKey: "OPENROUTER_API_KEY",
    consoleUrl: "https://openrouter.ai/settings/keys",
    docsUrl: "https://openrouter.ai/docs",
    pricingUrl: "https://openrouter.ai/models",
    freeTier: true,
    freeNote: "Many models tagged ':free' — see model list, filter by price = 0.",
    modelsEndpoint: "https://openrouter.ai/api/v1/models",
    validateEndpoint: "https://openrouter.ai/api/v1/auth/key",
    authHeader: (key) => ({ Authorization: `Bearer ${key}` }),
  },
  mistral: {
    id: "mistral",
    name: "Mistral AI",
    envKey: "MISTRAL_API_KEY",
    consoleUrl: "https://console.mistral.ai/api-keys",
    docsUrl: "https://docs.mistral.ai/api/",
    pricingUrl: "https://mistral.ai/pricing",
    freeTier: true,
    freeNote: "Free experiment tier available for testing with rate limits.",
    modelsEndpoint: "https://api.mistral.ai/v1/models",
    validateEndpoint: "https://api.mistral.ai/v1/models",
    authHeader: (key) => ({ Authorization: `Bearer ${key}` }),
  },
  deepseek: {
    id: "deepseek",
    name: "DeepSeek",
    envKey: "DEEPSEEK_API_KEY",
    consoleUrl: "https://platform.deepseek.com/api_keys",
    docsUrl: "https://api-docs.deepseek.com/",
    pricingUrl: "https://api-docs.deepseek.com/quick_start/pricing",
    freeTier: false,
    freeNote: "Low-cost paid tier; occasional off-peak discount pricing.",
    modelsEndpoint: "https://api.deepseek.com/v1/models",
    validateEndpoint: "https://api.deepseek.com/v1/models",
    authHeader: (key) => ({ Authorization: `Bearer ${key}` }),
  },
};

// Routing tiers: which provider+model combo handles which class of task
const ROUTING_TIERS = {
  tier1_instant: {
    label: "Tier 1 — Instant / Speed Mode",
    description: "Simple conversational prompts, basic language conversion, instant routing decisions.",
    candidates: [
      { provider: "groq", model: "llama-3.3-70b-versatile" },
      { provider: "google", model: "gemini-1.5-flash" },
    ],
  },
  tier2_balanced: {
    label: "Tier 2 — Balanced Processing",
    description: "Standard summaries, general assistance, light document parsing.",
    candidates: [
      { provider: "google", model: "gemini-1.5-flash" },
      { provider: "openrouter", model: "meta-llama/llama-3.1-70b-instruct" },
    ],
  },
  tier3_deep: {
    label: "Tier 3 — Deep Reasoning & Complex Code",
    description: "Full-stack game dev, architecture blueprints, inline SVG generation, multi-file code execution.",
    candidates: [
      { provider: "anthropic", model: "claude-3-5-sonnet-20241022" },
      { provider: "google", model: "gemini-1.5-pro" },
      { provider: "deepseek", model: "deepseek-reasoner" },
    ],
  },
};

// Simple heuristic keyword sets used by router.js to classify prompts
const HEURISTICS = {
  tier3_keywords: [
    "build", "architecture", "full-stack", "game", "canvas", "svg",
    "refactor", "algorithm", "database schema", "system design",
    "optimi", "complex", "multi-file", "debug",
  ],
  tier1_keywords: [
    "hi", "hello", "translate", "define", "what is", "quick", "short",
  ],
};

module.exports = { PROVIDERS, ROUTING_TIERS, HEURISTICS };
