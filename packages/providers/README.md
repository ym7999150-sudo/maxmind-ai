# @maxmind-ai/providers
Provider registry + adapters (`openai-compatible`, `anthropic`, `gemini`) + key detection.
Every adapter exposes `validateKey, listModels, getCapabilities, healthCheck, chat, streamChat` and returns `UNSUPPORTED` for `generateImage, transcribe, embed, countTokens, getUsage` when not implemented. Capabilities are read from what the provider's API reports; anything else stays `'unknown'`.
```js
const { Registry, getAdapter, detect } = require('@maxmind-ai/providers');
const reg = new Registry({});
reg.register({ id: 'myco', name: 'MyCo', apiBaseUrl: 'https://api.myco.example/v1', adapter: 'openai-compatible', keyPatterns: ['^mc-'] });
const hit = await detect('mc-...', reg, getAdapter); // confirmed only after a real authenticated response
```
