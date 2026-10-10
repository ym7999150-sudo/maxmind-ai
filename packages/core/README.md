# @maxmind-ai/core
Shared primitives for MAXMIND AI: `HEALTH` / `PROVIDER_HEALTH` states, `UNSUPPORTED`, error classes (`MaxMindError`, `ProviderError`), `redact`, `assertSafeUrl` (HTTPS-only credentials) and `request` (timeout, normalized errors, bounded exponential-backoff retry; auth and invalid-request errors are never retried).
```js
const { request, ProviderError } = require('@maxmind-ai/core');
```
