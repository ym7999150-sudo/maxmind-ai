'use strict';
const fs = require('fs');
const path = require('path');

/**
 * ProviderDefinition { id, name, logo, website, apiBaseUrl, documentationUrl, apiKeyUrl, protocol,
 *   capabilities, authenticationMethod, modelDiscoveryMethod, adapter, keyPatterns, hintPriority, classification, tags }
 * `classification` is informational only (FREE|FREEMIUM|PAID|ENTERPRISE|UNKNOWN) and NEVER gates usage.
 * Adding a provider = adding an entry here, a JSON file in config/providers/, or a custom connection in the UI.
 */
const BUILTIN = [
  { id: 'openai', name: 'OpenAI', website: 'https://openai.com', apiBaseUrl: 'https://api.openai.com/v1', documentationUrl: 'https://platform.openai.com/docs', apiKeyUrl: 'https://platform.openai.com/api-keys',
    adapter: 'openai-compatible', authenticationMethod: 'bearer', classification: 'PAID', keyPatterns: ['^sk-(?!ant-|or-)[A-Za-z0-9_-]{20,}$'], hintPriority: 1 },
  { id: 'anthropic', name: 'Anthropic', website: 'https://www.anthropic.com', apiBaseUrl: 'https://api.anthropic.com/v1', documentationUrl: 'https://docs.claude.com/en/api/overview', apiKeyUrl: 'https://console.anthropic.com/settings/keys',
    adapter: 'anthropic', authenticationMethod: 'x-api-key', classification: 'PAID', keyPatterns: ['^sk-ant-'], hintPriority: 5 },
  { id: 'gemini', name: 'Google Gemini (AI Studio)', website: 'https://ai.google.dev', apiBaseUrl: 'https://generativelanguage.googleapis.com/v1beta', documentationUrl: 'https://ai.google.dev/gemini-api/docs', apiKeyUrl: 'https://aistudio.google.com/app/apikey',
    adapter: 'gemini', authenticationMethod: 'x-goog-api-key', classification: 'FREEMIUM', keyPatterns: ['^AIza[0-9A-Za-z_-]{30,}$'], hintPriority: 5 },
  { id: 'groq', name: 'Groq', website: 'https://groq.com', apiBaseUrl: 'https://api.groq.com/openai/v1', documentationUrl: 'https://console.groq.com/docs', apiKeyUrl: 'https://console.groq.com/keys',
    adapter: 'openai-compatible', authenticationMethod: 'bearer', classification: 'FREEMIUM', keyPatterns: ['^gsk_'], hintPriority: 5 },
  { id: 'deepseek', name: 'DeepSeek', website: 'https://www.deepseek.com', apiBaseUrl: 'https://api.deepseek.com', documentationUrl: 'https://api-docs.deepseek.com', apiKeyUrl: 'https://platform.deepseek.com/api_keys',
    adapter: 'openai-compatible', authenticationMethod: 'bearer', classification: 'PAID', keyPatterns: ['^sk-[a-f0-9]{32}$'], hintPriority: 4 },
  { id: 'openrouter', name: 'OpenRouter', website: 'https://openrouter.ai', apiBaseUrl: 'https://openrouter.ai/api/v1', documentationUrl: 'https://openrouter.ai/docs', apiKeyUrl: 'https://openrouter.ai/keys',
    adapter: 'openai-compatible', authenticationMethod: 'bearer', classification: 'FREEMIUM', tags: ['aggregator'], keyPatterns: ['^sk-or-'], hintPriority: 5 },
  { id: 'xai', name: 'xAI', website: 'https://x.ai', apiBaseUrl: 'https://api.x.ai/v1', documentationUrl: 'https://docs.x.ai', apiKeyUrl: 'https://console.x.ai',
    adapter: 'openai-compatible', authenticationMethod: 'bearer', classification: 'PAID', keyPatterns: ['^xai-'], hintPriority: 5 },
  { id: 'mistral', name: 'Mistral AI', website: 'https://mistral.ai', apiBaseUrl: 'https://api.mistral.ai/v1', documentationUrl: 'https://docs.mistral.ai', apiKeyUrl: 'https://console.mistral.ai/api-keys',
    adapter: 'openai-compatible', authenticationMethod: 'bearer', classification: 'FREEMIUM', keyPatterns: ['^[A-Za-z0-9]{32}$'], hintPriority: 1 },
  { id: 'together', name: 'Together AI', website: 'https://www.together.ai', apiBaseUrl: 'https://api.together.xyz/v1', documentationUrl: 'https://docs.together.ai', apiKeyUrl: 'https://api.together.ai/settings/api-keys',
    adapter: 'openai-compatible', authenticationMethod: 'bearer', classification: 'PAID', keyPatterns: ['^[a-f0-9]{64}$'], hintPriority: 3 },
  { id: 'fireworks', name: 'Fireworks AI', website: 'https://fireworks.ai', apiBaseUrl: 'https://api.fireworks.ai/inference/v1', documentationUrl: 'https://docs.fireworks.ai', apiKeyUrl: 'https://fireworks.ai/account/api-keys',
    adapter: 'openai-compatible', authenticationMethod: 'bearer', classification: 'PAID', keyPatterns: ['^fw_[A-Za-z0-9]{16,}$'], hintPriority: 5 },
  { id: 'cerebras', name: 'Cerebras', website: 'https://www.cerebras.ai', apiBaseUrl: 'https://api.cerebras.ai/v1', documentationUrl: 'https://inference-docs.cerebras.ai', apiKeyUrl: 'https://cloud.cerebras.ai',
    adapter: 'openai-compatible', authenticationMethod: 'bearer', classification: 'FREEMIUM', keyPatterns: ['^csk-[A-Za-z0-9]{20,}$'], hintPriority: 5 },
  { id: 'nvidia', name: 'NVIDIA NIM', website: 'https://build.nvidia.com', apiBaseUrl: 'https://integrate.api.nvidia.com/v1', documentationUrl: 'https://docs.api.nvidia.com', apiKeyUrl: 'https://build.nvidia.com/settings/api-keys',
    adapter: 'openai-compatible', authenticationMethod: 'bearer', classification: 'FREEMIUM', keyPatterns: ['^nvapi-[A-Za-z0-9_-]{20,}$'], hintPriority: 5 },
  { id: 'huggingface', name: 'Hugging Face Inference', website: 'https://huggingface.co', apiBaseUrl: 'https://router.huggingface.co/v1', documentationUrl: 'https://huggingface.co/docs/inference-providers', apiKeyUrl: 'https://huggingface.co/settings/tokens',
    adapter: 'openai-compatible', authenticationMethod: 'bearer', classification: 'FREEMIUM', tags: ['aggregator'], keyPatterns: ['^hf_[A-Za-z0-9]{20,}$'], hintPriority: 5 },
  { id: 'sambanova', name: 'SambaNova', website: 'https://sambanova.ai', apiBaseUrl: 'https://api.sambanova.ai/v1', documentationUrl: 'https://docs.sambanova.ai', apiKeyUrl: 'https://cloud.sambanova.ai/apis',
    adapter: 'openai-compatible', authenticationMethod: 'bearer', classification: 'FREEMIUM', keyPatterns: ['^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'], hintPriority: 2 },
  { id: 'hyperbolic', name: 'Hyperbolic', website: 'https://hyperbolic.xyz', apiBaseUrl: 'https://api.hyperbolic.xyz/v1', documentationUrl: 'https://docs.hyperbolic.xyz', apiKeyUrl: 'https://app.hyperbolic.xyz/settings',
    adapter: 'openai-compatible', authenticationMethod: 'bearer', classification: 'PAID', keyPatterns: ['^eyJ[A-Za-z0-9_-]{30,}'], hintPriority: 2 },
  { id: 'deepinfra', name: 'DeepInfra', website: 'https://deepinfra.com', apiBaseUrl: 'https://api.deepinfra.com/v1/openai', documentationUrl: 'https://deepinfra.com/docs', apiKeyUrl: 'https://deepinfra.com/dash/api_keys',
    adapter: 'openai-compatible', authenticationMethod: 'bearer', classification: 'PAID', keyPatterns: [], hintPriority: 0 },
  { id: 'novita', name: 'Novita AI', website: 'https://novita.ai', apiBaseUrl: 'https://api.novita.ai/v3/openai', documentationUrl: 'https://novita.ai/docs', apiKeyUrl: 'https://novita.ai/settings/key-management',
    adapter: 'openai-compatible', authenticationMethod: 'bearer', classification: 'PAID', keyPatterns: ['^sk_[A-Za-z0-9_-]{20,}$'], hintPriority: 3 },
  { id: 'moonshot', name: 'Moonshot AI (Kimi)', website: 'https://www.moonshot.ai', apiBaseUrl: 'https://api.moonshot.ai/v1', documentationUrl: 'https://platform.moonshot.ai/docs', apiKeyUrl: 'https://platform.moonshot.ai/console/api-keys',
    adapter: 'openai-compatible', authenticationMethod: 'bearer', classification: 'PAID', keyPatterns: [], hintPriority: 0 },
  { id: 'zhipu', name: 'Z.ai (GLM)', website: 'https://z.ai', apiBaseUrl: 'https://api.z.ai/api/paas/v4', documentationUrl: 'https://docs.z.ai', apiKeyUrl: 'https://z.ai/manage-apikey/apikey-list',
    adapter: 'openai-compatible', authenticationMethod: 'bearer', classification: 'PAID', keyPatterns: ['^[a-f0-9]{32}\\.[A-Za-z0-9]{16}$'], hintPriority: 4 },
  { id: 'dashscope', name: 'Alibaba Qwen (DashScope Intl)', website: 'https://www.alibabacloud.com/product/modelstudio', apiBaseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', documentationUrl: 'https://www.alibabacloud.com/help/en/model-studio', apiKeyUrl: 'https://modelstudio.console.alibabacloud.com',
    adapter: 'openai-compatible', authenticationMethod: 'bearer', classification: 'PAID', keyPatterns: [], hintPriority: 0 }
];
const MOCK = { id: 'mock', name: 'DEVELOPMENT / MOCK PROVIDER', website: null, apiBaseUrl: 'https://mock.invalid/v1', documentationUrl: null, apiKeyUrl: null,
  adapter: 'mock', authenticationMethod: 'bearer', classification: 'UNKNOWN', tags: ['mock', 'development'], keyPatterns: ['^mock-'], hintPriority: 9 };

const PROTOCOL = { 'openai-compatible': 'openai-compatible', anthropic: 'anthropic', gemini: 'gemini', mock: 'mock' };
function normalize(d) {
  const adapter = d.adapter || 'openai-compatible';
  return { logo: d.logo || null, website: null, documentationUrl: null, apiKeyUrl: null, classification: 'UNKNOWN', tags: [], keyPatterns: [], hintPriority: 0,
    authenticationMethod: 'bearer', modelDiscoveryMethod: adapter === 'anthropic' ? 'GET /models (Anthropic)' : adapter === 'gemini' ? 'GET /models (Gemini)' : 'GET /models',
    capabilities: { chat: true, modelListing: true }, ...d, adapter, protocol: PROTOCOL[adapter] || adapter, custom: !!d.custom };
}

class Registry {
  constructor({ mock = false, configDir = null } = {}) {
    this.defs = new Map();
    BUILTIN.forEach((d) => this.register(d));
    if (mock) this.register(MOCK);
    if (configDir && fs.existsSync(configDir)) {
      for (const f of fs.readdirSync(configDir).filter((x) => x.endsWith('.json'))) {
        try { const j = JSON.parse(fs.readFileSync(path.join(configDir, f), 'utf8')); (Array.isArray(j) ? j : [j]).forEach((d) => this.register(d)); }
        catch (e) { console.warn(`[registry] skipped ${f}: ${e.message}`); }
      }
    }
  }
  register(def) {
    if (!def || !def.id || !def.name || !def.apiBaseUrl) throw new Error('ProviderDefinition requires id, name, apiBaseUrl');
    this.defs.set(def.id, normalize(def)); return this.defs.get(def.id);
  }
  get(id) { return this.defs.get(id) || null; }
  list() { return [...this.defs.values()]; }
}
module.exports = { Registry, BUILTIN, normalize };
