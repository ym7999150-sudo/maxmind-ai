# MAXMIND AI — v2
**EN:** A unified AI workspace. You bring your own API keys; MAXMIND validates them against the real provider, discovers the models that key can actually use, health-checks them, and lets **you** decide which models it may use. A router (with your model profiles) picks one model or an AI team and returns one final answer.
**AR:** مساحة عمل موحّدة للذكاء الاصطناعي. تضيف مفاتيح API الخاصة بك، فيتحقق MAXMIND منها لدى المزوّد الحقيقي، ويكتشف النماذج المتاحة فعليًا لهذا المفتاح، ويفحص صحتها، ثم **تقرر أنت** أي النماذج يستخدمها. يختار الموجّه (بحسب ملفات النماذج التي تضبطها) نموذجًا واحدًا أو فريقًا ويعيد لك إجابة نهائية واحدة.

## Quick start / التشغيل السريع
```bash
npm install          # installs express, links the @maxmind-ai/* workspaces / يثبّت الحزم ويربط الـ workspaces
npm start            # creates .env with fresh random secrets on first run, then starts / ينشئ .env بأسرار عشوائية جديدة أول مرة
# open http://localhost:3000
```
- First login / أول دخول: user `admin`, initial password `MaxMind AI 2026` → **you are forced to change it**; afterwards the initial password no longer works. / سيُطلب منك تغييرها فورًا وبعدها لا تعمل.
- Requires **Node.js ≥ 22.13** (uses the built-in `node:sqlite`; Node prints an "experimental" notice — harmless).
- **Back up `.env`**: losing `ENCRYPTION_KEY` makes saved API keys unrecoverable. / احتفظ بنسخة من `.env`.
- Development without real providers / للتطوير بلا مزوّدين حقيقيين: `npm run dev` (adds a clearly-labelled **MOCK** provider; refused when `NODE_ENV=production`; paste the key `mock-valid-key`).
- Tests / الاختبارات: `npm test` (20 tests: unit + integration against local fake provider servers).
- Packages / الحزم: `npm run pack:all` → `dist/*.tgz`. Nothing is published automatically. / لا يُنشر شيء تلقائيًا.

## How it works / كيف يعمل
1. **Providers → Add API key**: paste a key. Auto-detect uses the key *format* only as a hint, then confirms with a real authenticated request — and only contacts known registry providers whose format matches. Unknown? choose a provider, enter a base URL, or use any OpenAI-compatible endpoint (HTTPS only).
2. Models are **discovered** from the provider's API and **health-checked** with a minimal real request. Nothing is enabled automatically.
3. **Model Control Center**: enable/disable each model; edit its **profile** (role, strengths, weaknesses, sliders, flags). Every field is used by the router.
4. **Chat**: Auto / Smart Team / Manual / Team. Simple → 1 model; medium → 1 (+ optional review); complex → specialists + cross-review + synthesis; critical → up to your maximum. Each answer shows *Request details* (models, tokens measured by the provider, cache, latency, why).
5. The router can **only** choose models that are *enabled + healthy + valid key + capable*. If none qualifies you get a clear message. Manual/Team selections are never silently replaced.

## Security / الأمان
Keys: AES-256-GCM at rest, server-side only, masked in the UI, never in responses/logs/URLs (tested). scrypt password hashing, HTTP-only SameSite=Strict session cookie, CSRF token, rate limiting, per-user isolation, strict CSP, upload content sniffing, audit log. Credentials are sent only over HTTPS (loopback `http` only when `ALLOW_INSECURE_LOCAL=1`, non-production).

## Honest status / الحالة بصدق
Verified here / تم التحقق: backend + adapters against **local fake provider servers** (real HTTP/SSE), and the whole UI in headless Chromium (EN + AR/RTL).
**Not verified / لم يُتحقق منه:** calls to the *live* OpenAI/Anthropic/Gemini/etc. services (no internet in the build environment). Provider APIs change — if one behaves differently from its docs, adjust only that adapter in `packages/providers/src/adapters/`.
Known limits / حدود معروفة:
- Capabilities are only what a provider's API reports; many OpenAI-style `/models` lists report none, so they show **Unknown** (you may *declare* a capability in the model profile; it's labelled "declared").
- The "semantic" cache is **lexical similarity**, not embeddings. Summaries/compression are extractive and local (no extra API calls). Local token counts are estimates; real usage is shown when the provider returns it.
- Health checks run one tiny request per chat model (cap `HEALTHCHECK_MAX_MODELS`, default 40; enabled models are re-checked in the background every `HEALTH_TTL_MINUTES`). Non-chat models (embeddings, audio…) are not chat-tested.
- PDF text extraction needs the optional `pdf-parse` package. Image generation / transcription only work through providers whose models report/declare them; Anthropic and Gemini adapters return `UNSUPPORTED` for them.
- AI Map is a custom SVG graph with zoom/pan/hover (no third-party graph library). One seeded user (`admin`); there is no sign-up screen (the data model is multi-user and isolation is tested).
- SQLite single-file database (`data/maxmind.db`); migrations in `src/db.js`.

## Layout / الهيكل
`server.js` · `src/` (env, db, crypto, services, routes) · `packages/` (core, providers, router, token-engine) · `public/` (UI, i18n EN/AR) · `config/providers/*.json` (add providers without code) · `test/` · `legacy/` (your original v1, untouched).
