'use strict';
const http = require('http');
const crypto = require('crypto');
const { loadEnv } = require('../src/env');
const { createApp } = require('../src/app');

/** A local fake OpenAI-compatible provider: real HTTP, real SSE, records every request it receives. */
function fakeProvider({ keys = ['good-key'], models = ['m-a', 'm-b'], failChat = [], reviewerSays = 'OK', latency = 0 } = {}) {
  const log = []; const cfg = { keys: new Set(keys), models, failChat: new Set(failChat), reviewerSays };
  const server = http.createServer((req, res) => {
    let body = ''; req.on('data', (c) => (body += c)); req.on('end', async () => {
      const auth = (req.headers.authorization || '').replace('Bearer ', '');
      const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (!cfg.keys.has(auth)) return send(401, { error: { message: 'Incorrect API key provided' } });
      if (req.method === 'GET' && req.url === '/v1/models') return send(200, { data: cfg.models.map((id) => ({ id, object: 'model', owned_by: 'fake', ...(id.startsWith('embed') ? {} : {}) })) });
      if (req.method === 'POST' && req.url === '/v1/chat/completions') {
        const b = JSON.parse(body || '{}'); const sys = (b.messages.find((m) => m.role === 'system') || {}).content || '';
        const last = b.messages[b.messages.length - 1]; const lastText = typeof last.content === 'string' ? last.content : last.content.map((p) => p.text || '').join(' ');
        const isHealth = /single word: ok/.test(lastText);
        log.push({ model: b.model, system: sys, lastText, stream: !!b.stream, health: isHealth, messages: b.messages });
        if (!cfg.models.includes(b.model)) return send(404, { error: { message: 'model not found' } });
        if (b.model === 'reasoner' && b.max_tokens !== undefined) return send(400, { error: { message: "Unsupported parameter: 'max_tokens'. Use 'max_completion_tokens' instead." } });
        if (cfg.failChat.has(b.model)) return send(500, { error: { message: 'upstream exploded' } });
        if (latency) await new Promise((r) => setTimeout(r, latency));
        let content;
        if (isHealth) content = 'ok'; else if (/strict reviewer/.test(sys)) content = cfg.reviewerSays; else if (/final answer writer/.test(sys)) content = `FINAL(${b.model})`; else content = `ANSWER(${b.model}): ${lastText.slice(0, 40)}`;
        const usage = { prompt_tokens: Math.ceil(JSON.stringify(b.messages).length / 4), completion_tokens: Math.ceil(content.length / 4) }; usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
        if (b.stream) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          for (const w of content.split(/(?<= )/)) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: w } }] })}\n\n`);
          res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage })}\n\n`); res.write('data: [DONE]\n\n'); return res.end();
        }
        return send(200, { choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }], usage });
      }
      send(404, { error: { message: 'nope' } });
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}/v1`, log, cfg, close: () => new Promise((r) => server.close(r)),
    chatCalls: (model) => log.filter((l) => !l.health && (!model || l.model === model)) })));
}

async function startApp(overrides = {}) {
  const cfg = loadEnv({ overrides: { DATABASE_URL: ':memory:', ALLOW_INSECURE_LOCAL: '1', UPLOAD_DIR: require('os').tmpdir() + '/mm-test-' + crypto.randomBytes(4).toString('hex'), ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64'), AUTH_SECRET: crypto.randomBytes(40).toString('base64url'), ...overrides } });
  const a = createApp(cfg);
  const server = await new Promise((r) => { const s = a.app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { ...a, cfg, base, close: async () => { await new Promise((r) => server.close(r)); a.close(); } };
}

/** Cookie + CSRF aware API client. */
function client(base) {
  let cookie = ''; let csrf = '';
  const c = {
    async raw(method, path, body, headers = {}) {
      const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}), ...(csrf && method !== 'GET' ? { 'x-csrf-token': csrf } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
      const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
      return res;
    },
    async call(method, path, body, headers) { const res = await c.raw(method, path, body, headers); const text = await res.text(); let json; try { json = JSON.parse(text); } catch { json = text; } return { status: res.status, json, text }; },
    get: (p) => c.call('GET', p), post: (p, b) => c.call('POST', p, b ?? {}), put: (p, b) => c.call('PUT', p, b), patch: (p, b) => c.call('PATCH', p, b), del: (p) => c.call('DELETE', p),
    async login(username = 'admin', password = 'MaxMind AI 2026') { const r = await c.call('POST', '/api/auth/login', { username, password }); if (r.status === 200) csrf = r.json.csrf; return r; },
    async refreshCsrf() { const r = await c.get('/api/auth/me'); csrf = r.json.csrf; return r; },
    /** POST /api/chat/send and collect SSE events */
    async chat(body) {
      const res = await c.raw('POST', '/api/chat/send', body); const text = await res.text(); const events = [];
      for (const block of text.split('\n\n')) { const m = block.match(/^event: (.+)\ndata: (.+)$/s); if (m) events.push({ event: m[1], data: JSON.parse(m[2]) }); }
      const done = events.find((e) => e.event === 'done'); const error = events.find((e) => e.event === 'error');
      return { status: res.status, events, done: done && done.data, error: error && error.data, text: events.filter((e) => e.event === 'delta').map((e) => e.data.text).join('') };
    }
  };
  return c;
}
/** log in, pass the forced password change, return ready client */
async function readyClient(base, newPassword = 'Str0ng-Passw0rd!') {
  const c = client(base); await c.login(); await c.post('/api/auth/change-password', { currentPassword: 'MaxMind AI 2026', newPassword }); await c.login('admin', newPassword); return c;
}
/** add a fake-provider connection through the real preview → health → save pipeline */
async function addConnection(c, fp, { key = 'good-key', name = 'Test', enable = [], providerName = 'FakeAI' } = {}) {
  const pv = await c.post('/api/connections/preview', { apiKey: key, baseUrl: fp.url, providerName }); if (!pv.json.ok) return { preview: pv };
  const h = await c.post(`/api/connections/preview/${pv.json.pendingId}/health`);
  const saved = await c.post('/api/connections', { pendingId: pv.json.pendingId, name, enableModelIds: enable });
  return { preview: pv, health: h, saved };
}
module.exports = { fakeProvider, startApp, client, readyClient, addConnection };
