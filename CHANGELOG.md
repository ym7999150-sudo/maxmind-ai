# Changelog

## 2.1.0
- Providers: +12 OpenAI-compatible registry entries (Together, Fireworks, Cerebras, NVIDIA NIM, Hugging Face, SambaNova, Hyperbolic, DeepInfra, Novita, Moonshot, Z.ai, Alibaba DashScope). Key shapes are only hints; each key is still confirmed against the real provider. NOT verified against live services.
- AI Map: interactive (select + highlight neighbours, details panel, search, status filters, collapse/expand provider models, drag nodes, pinch/wheel zoom, fit, fullscreen, keyboard).
- Token engine: whitespace squeeze, code-block trimming, IDF-weighted retrieval with stop-words, near-duplicate chunk removal, better token estimate. API unchanged.
- UI/UX: additive CSS polish, mobile touch targets, i18n keys (EN/AR).

## 2.0.0
Rebuilt from the v1 proxy (kept under `legacy/`) into the architecture described in the master prompt.
- Server-side encrypted API keys (AES-256-GCM); keys never reach the browser (v1 kept them in `localStorage`).
- Real key validation, model discovery, and minimal real health checks for OpenAI-compatible, Anthropic and Gemini protocols.
- Auto provider detection (format hint + real authenticated validation; only matching known providers are contacted).
- Model Control Center, model profiles that drive routing, configurable router weights, AI Team (single / review / team) with synthesis.
- Token engine (compression, rolling summary, relevant retrieval, lexical cache, budgets), real usage accounting.
- Auth (scrypt, HTTP-only sessions, CSRF, rate limiting), forced change of the initial password, audit log.
- Bilingual UI (English / Arabic, full RTL), themes + accent, AI Map, monitoring, memory, files, voice, image generation (where supported).
- npm workspaces: `@maxmind-ai/core`, `providers`, `router`, `token-engine`.
