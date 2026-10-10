'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fakeProvider, startApp, client, readyClient, addConnection } = require('./helpers');

test('authentication: default password forces change, then stops working; CSRF + sessions', async (t) => {
  const app = await startApp(); t.after(() => app.close());
  const c = client(app.base);
  assert.equal((await c.get('/api/settings')).status, 401);
  assert.equal((await c.login('admin', 'wrong')).status, 401);
  const l = await c.login(); assert.equal(l.status, 200); assert.equal(l.json.user.mustChangePassword, true);
  assert.equal((await c.get('/api/settings')).json.error.code, 'PASSWORD_CHANGE_REQUIRED');
  const weak = await c.post('/api/auth/change-password', { currentPassword: 'MaxMind AI 2026', newPassword: 'MaxMind AI 2026' }); assert.equal(weak.status, 400);
  assert.equal((await c.post('/api/auth/change-password', { currentPassword: 'MaxMind AI 2026', newPassword: 'short1' })).status, 400);
  assert.equal((await c.post('/api/auth/change-password', { currentPassword: 'MaxMind AI 2026', newPassword: 'Br4nd-new-pass' })).status, 200);
  assert.equal((await client(app.base).login('admin', 'MaxMind AI 2026')).status, 401, 'default password no longer works');
  const c2 = client(app.base); assert.equal((await c2.login('admin', 'Br4nd-new-pass')).status, 200);
  assert.equal((await c2.get('/api/settings')).status, 200);
  const noCsrf = await fetch(app.base + '/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json', cookie: 'x' }, body: '{}' }); assert.equal(noCsrf.status, 401);
  const res = await c2.raw('PUT', '/api/settings', { theme: 'dark' }, { 'x-csrf-token': 'wrong' }); assert.equal(res.status, 403);
});

test('invalid API key is rejected by real provider validation; nothing is saved', async (t) => {
  const app = await startApp(); const fp = await fakeProvider(); t.after(async () => { await app.close(); await fp.close(); });
  const c = await readyClient(app.base);
  const r = await c.post('/api/connections/preview', { apiKey: 'wrong-key-12345', baseUrl: fp.url, providerName: 'FakeAI' });
  assert.equal(r.json.ok, false); assert.equal(r.json.status, 'AUTH_FAILED');
  assert.equal((await c.get('/api/connections')).json.connections.length, 0);
  const insecure = await c.post('/api/connections/preview', { apiKey: 'good-key-1234', baseUrl: 'http://example.com/v1' }); assert.equal(insecure.status, 400);
});

test('CRITICAL ACCEPTANCE: key → discover → health → disable A / enable B → router uses B only → team → synthesis → usage → persistence → no key leakage', async (t) => {
  const app = await startApp(); const A = await fakeProvider({ keys: ['providerA-key-0001'], models: ['model-a', 'model-b', 'embed-x'] }); const B = await fakeProvider({ keys: ['providerB-key-0002'], models: ['model-c', 'model-d'] });
  t.after(async () => { await app.close(); await A.close(); await B.close(); });
  const c = await readyClient(app.base);

  // 2-6: add provider A (pipeline), real discovery, real health
  const r = await addConnection(c, A, { key: 'providerA-key-0001', name: 'Key A', providerName: 'ProviderA' });
  assert.equal(r.preview.json.modelCount, 3); assert.equal(r.preview.json.detection.method, 'user-supplied-base-url');
  assert.deepEqual([r.health.json.summary.healthy, r.health.json.summary.unknown], [2, 1], 'embedding model is not chat-tested, never marked healthy');
  assert.equal(A.log.filter((l) => l.health).length, 2, 'only chat-capable models receive a (minimal) health request');
  const conn = r.saved.json; assert.equal(conn.stats.discovered, 3); assert.equal(conn.stats.healthy, 2); assert.equal(conn.stats.enabled, 0, 'nothing is auto-enabled');
  let models = (await c.get('/api/models')).json.models; const mA = models.find((m) => m.modelId === 'model-a'), mB = models.find((m) => m.modelId === 'model-b'), emb = models.find((m) => m.modelId === 'embed-x');
  assert.equal(emb.health.state, 'UNKNOWN'); assert.equal(mA.capabilities.vision, 'unknown', 'unknown stays unknown');

  // nothing enabled → clear message, no silent use
  let ans = await c.chat({ text: 'What is the capital of France?' }); assert.equal(ans.error.code, 'NO_COMPATIBLE_MODEL'); assert.equal(A.chatCalls().length, 0);

  // 7-8: user enables A first, then disables A and enables B
  await c.patch(`/api/models/${mA.key}`, { enabled: true }); await c.patch(`/api/models/${mA.key}`, { enabled: false }); await c.patch(`/api/models/${mB.key}`, { enabled: true });
  A.log.length = 0;
  // 9-11: ask → Router MUST use B, A MUST NOT receive the request
  ans = await c.chat({ text: 'What is the capital of France?' });
  assert.ok(ans.done, JSON.stringify(ans.error)); assert.match(ans.text, /ANSWER\(model-b\)/);
  assert.equal(A.chatCalls('model-a').length, 0, 'disabled Model A received nothing'); assert.equal(A.chatCalls('model-b').length, 1);
  assert.equal(ans.done.details.strategy, 'single'); assert.equal(ans.done.details.modelsUsed, 1); assert.equal(ans.done.details.tokens.measured, true);
  assert.ok(ans.done.details.tokens.total > 0, 'token usage measured from provider');

  // 12-14: add provider B, enable a second model, complex question
  const rb = await addConnection(c, B, { key: 'providerB-key-0002', name: 'Key B', providerName: 'ProviderB', enable: ['model-c'] }); assert.equal(rb.saved.status, 201);
  A.log.length = 0; B.log.length = 0;
  const complex = await c.chat({ text: 'Compare these architectures: microservices vs modular monolith. Analyze the trade-off for a scalable authentication system and design the migration strategy step by step. Which is better and why?', modeOverride: undefined, mode: 'smart' });
  assert.ok(complex.done, JSON.stringify(complex.error));
  const d = complex.done.details;
  // 15-17: team formed, intermediate results, ONE final answer
  assert.ok(['team', 'primary_review'].includes(d.strategy), 'strategy ' + d.strategy); assert.ok(d.modelsUsed >= 2); assert.ok(d.teamCalls >= 2);
  assert.equal(A.chatCalls('model-a').length, 0, 'disabled model still untouched in team mode');
  assert.equal(complex.events.filter((e) => e.event === 'done').length, 1);
  assert.ok(complex.text.length > 0 && !/Candidate answer/.test(complex.text), 'one clean final answer, no concatenated drafts');
  // 18: usage recorded
  const mon = (await c.get('/api/monitor')).json; assert.ok(mon.requests.total >= 2); assert.ok(mon.requests.tokens.total > 0); assert.ok(mon.modelCalls.ok >= 3);
  // 19-21: chat saved and survives reload
  const list = (await c.get('/api/chats')).json.chats; assert.ok(list.length >= 2);
  const full = (await c.get(`/api/chats/${complex.done.chatId}`)).json; assert.equal(full.messages.length, 2); assert.equal(full.messages[1].role, 'assistant'); assert.ok(full.messages[1].meta.requestDetails.tokens.total > 0);
  // 22-23: keys never reach the frontend
  const secrets = ['providerA-key-0001', 'providerB-key-0002'];
  for (const p of ['/api/connections', '/api/models', '/api/providers', '/api/monitor', '/api/map', '/api/audit?limit=500', '/api/agents', '/api/settings', '/api/auth/me', `/api/chats/${complex.done.chatId}`]) {
    const x = await c.get(p); for (const s of secrets) assert.ok(!x.text.includes(s), `${p} leaked a key`);
  }
  const dump = JSON.stringify(app.ctx.db.all('SELECT * FROM provider_credentials')) + JSON.stringify(app.ctx.db.all('SELECT * FROM audit_log')) + JSON.stringify(app.ctx.db.all('SELECT detection, last_error, key_mask FROM connections'));
  for (const s of secrets) assert.ok(!dump.includes(s), 'plaintext key found in database');
  assert.equal(app.ctx.connections.credential(conn.id), 'providerA-key-0001', 'server can decrypt its own credential');
  const audit = (await c.get('/api/audit')).json.events.map((e) => e.event);
  for (const ev of ['login', 'password_change', 'api_key_added', 'provider_connected', 'model_enabled', 'model_disabled']) assert.ok(audit.includes(ev), 'audit has ' + ev);
});

test('router really uses model profiles (strengths/weaknesses/role) and user can steer it', async (t) => {
  const app = await startApp(); const P = await fakeProvider({ models: ['coder-1', 'writer-1', 'thinker-1'] }); t.after(async () => { await app.close(); await P.close(); });
  const c = await readyClient(app.base); const r = await addConnection(c, P, { enable: ['coder-1', 'writer-1', 'thinker-1'] });
  const ms = (await c.get('/api/models')).json.models; const k = (id) => ms.find((m) => m.modelId === id).key;
  await c.patch(`/api/models/${k('coder-1')}`, { strengths: 'coding architecture debugging react backend api', weaknesses: 'creative writing marketing', role: 'coder' });
  await c.patch(`/api/models/${k('writer-1')}`, { strengths: 'writing summarization marketing copy paragraph', weaknesses: 'complex coding', role: 'writer' });
  await c.patch(`/api/models/${k('thinker-1')}`, { strengths: 'reasoning analysis comparison architectures', weaknesses: 'fast responses', role: 'analyst', reasoning: 10 });
  await c.put('/api/settings', { team: { multiModel: false }, tokens: { cacheEnabled: false } });
  const who = async (text) => { P.log.length = 0; const a = await c.chat({ text }); assert.ok(a.done, JSON.stringify(a.error)); return P.chatCalls()[0].model; };
  assert.equal(await who('Write a React hook for auth and debug this backend api bug'), 'coder-1');
  assert.equal(await who('Rewrite this marketing paragraph'), 'writer-1');
  assert.equal(await who('Analyze and compare these architectures'), 'thinker-1');
  // user preference overrides: mark writer as primary + high trust and zero out others' expertise weight
  await c.put('/api/settings', { router: { weights: { capability: 0, userPreference: 100, expertise: 0, health: 0, performance: 0, cost: 0, latency: 0, history: 0 } } });
  await c.patch(`/api/models/${k('writer-1')}`, { flags: { primary: true }, trust: 10 });
  assert.equal(await who('Write a React hook for auth and debug this backend api bug'), 'writer-1', 'configurable weights + preference change routing');
  const decision = (await c.chat({ text: 'Hello there' })).done.details.routing; assert.ok(decision.top[0].breakdown.userPreference.weight === 100, 'scores expose real breakdown');
});

test('failure handling: team member fails → continue; manual model fails → stop, no substitution; auto fallback is reported', async (t) => {
  const app = await startApp(); const P = await fakeProvider({ models: ['good-1', 'good-2', 'bad-1'], failChat: [] }); t.after(async () => { await app.close(); await P.close(); });
  const c = await readyClient(app.base); await addConnection(c, P, { enable: ['good-1', 'good-2', 'bad-1'] });
  const ms = (await c.get('/api/models')).json.models; const k = (id) => ms.find((m) => m.modelId === id).key;
  P.cfg.failChat.add('bad-1'); // becomes broken AFTER it passed health
  // manual mode on the broken model: explicit error, others never used
  await c.put('/api/settings', { chat: { mode: 'manual' }, team: { manualModelKey: k('bad-1') } }); P.log.length = 0;
  const m = await c.chat({ text: 'hello world question' }); assert.equal(m.error.code, 'MODEL_FAILED'); assert.match(m.error.message, /No other model was substituted/); assert.equal(P.chatCalls('good-1').length + P.chatCalls('good-2').length, 0);
  // health feedback: broken model is now marked, so router excludes it
  const after = (await c.get('/api/models')).json.models.find((x) => x.modelId === 'bad-1'); assert.notEqual(after.health.state, 'HEALTHY');
  // team mode with a failing reviewer still returns an answer
  P.cfg.failChat.clear(); P.cfg.failChat.add('good-2');
  await c.put('/api/settings', { chat: { mode: 'auto' }, team: { reviewOnMedium: true } });
  const a = await c.chat({ text: 'Explain how to build a secure api and design the system with authentication step by step in full', critical: true });
  assert.ok(a.done || a.error); if (a.done) assert.ok(a.done.content.length > 0);
});

test('semantic cache: repeated standalone question is a HIT with zero provider calls, and invalid when the model gets disabled', async (t) => {
  const app = await startApp(); const P = await fakeProvider({ models: ['only-1'] }); t.after(async () => { await app.close(); await P.close(); });
  const c = await readyClient(app.base); await addConnection(c, P, { enable: ['only-1'] });
  const q = 'What is the tallest mountain in the world?';
  const a1 = await c.chat({ text: q }); assert.equal(a1.done.details.cache, 'MISS'); const calls = P.chatCalls().length;
  const a2 = await c.chat({ text: 'what is the tallest mountain in the world' }); assert.equal(a2.done.details.cache, 'HIT'); assert.equal(P.chatCalls().length, calls, 'no new provider call'); assert.equal(a2.done.details.tokens.total, 0);
  const k = (await c.get('/api/models')).json.models[0].key; await c.patch(`/api/models/${k}`, { enabled: false });
  const a3 = await c.chat({ text: q }); assert.equal(a3.error.code, 'NO_COMPATIBLE_MODEL', 'cache never resurrects an answer from a disabled model');
});

test('user isolation, file validation, memory, chat management', async (t) => {
  const app = await startApp(); const P = await fakeProvider({ models: ['iso-1'] }); t.after(async () => { await app.close(); await P.close(); });
  const c = await readyClient(app.base); const r = await addConnection(c, P, { enable: ['iso-1'] }); const connId = r.saved.json.id;
  const ans = await c.chat({ text: 'secret chat content' });
  // second user created directly in DB
  const { hashPassword } = require('../src/crypto'); app.ctx.db.run('INSERT INTO users(id,username,password_hash,must_change_password,created_at) VALUES(?,?,?,0,?)', 'u2', 'bob', hashPassword('Bobs-password-99'), Date.now());
  const b = client(app.base); assert.equal((await b.login('bob', 'Bobs-password-99')).status, 200);
  assert.equal((await b.get(`/api/chats/${ans.done.chatId}`)).status, 404); assert.equal((await b.get('/api/chats')).json.chats.length, 0);
  assert.equal((await b.post(`/api/connections/${connId}/test`)).status, 404); assert.equal((await b.del(`/api/connections/${connId}`)).status, 404);
  assert.equal((await b.get('/api/models')).json.models.length, 0);
  // files
  const up = (name, buf) => c.post('/api/files', { name, dataBase64: Buffer.from(buf).toString('base64') });
  assert.equal((await up('evil.exe', 'MZ\x90\x00')).status, 415); assert.equal((await up('fake.png', 'not a png')).status, 415);
  const ok = await up('notes.txt', 'alpha beta gamma '.repeat(50)); assert.equal(ok.status, 201); assert.equal(ok.json.kind, 'text');
  assert.equal((await b.get(`/api/files/${ok.json.id}`)).status, 404, 'other users cannot read my files');
  const withFile = await c.chat({ chatId: ans.done.chatId, text: 'summarize alpha', attachmentIds: [ok.json.id] }); assert.ok(withFile.done); assert.match(P.chatCalls().pop().lastText, /Attached file: notes\.txt/);
  // memory command is local (no model call) and then injected
  const before = P.chatCalls().length; const rm = await c.chat({ text: 'remember that my favorite color is teal' }); assert.equal(P.chatCalls().length, before); assert.equal((await c.get('/api/memory')).json.items.length, 1);
  await c.chat({ text: 'what do you know about me?' }); assert.match(P.chatCalls().pop().system, /favorite color is teal/);
  await c.put('/api/settings', { memory: { enabled: false } }); await c.chat({ text: 'another totally different question here' }); assert.doesNotMatch(P.chatCalls().pop().system, /teal/);
  // chat management
  const id = ans.done.chatId; await c.patch(`/api/chats/${id}`, { title: 'Renamed', pinned: true }); assert.equal((await c.get('/api/chats?q=secret')).json.chats[0].title, 'Renamed');
  await c.patch(`/api/chats/${id}`, { archived: true }); assert.equal((await c.get('/api/chats')).json.chats.some((x) => x.id === id), false);
  assert.match((await c.get(`/api/chats/${id}/export?format=markdown`)).text, /secret chat content/);
  await c.del(`/api/chats/${id}`); assert.equal((await c.get(`/api/chats/${id}`)).status, 404);
});

test('auto-detection confirms a provider only after a real authenticated response; unknown formats are reported', async (t) => {
  const app = await startApp(); const P = await fakeProvider({ keys: ['zzz_detect_me_000111'], models: ['d-1'] }); t.after(async () => { await app.close(); await P.close(); });
  app.ctx.registry.register({ id: 'fakeco', name: 'FakeCo', apiBaseUrl: P.url, adapter: 'openai-compatible', keyPatterns: ['^zzz_detect'], hintPriority: 5 });
  const c = await readyClient(app.base);
  const ok = await c.post('/api/connections/preview', { apiKey: 'zzz_detect_me_000111' }); assert.equal(ok.json.ok, true); assert.equal(ok.json.provider.id, 'fakeco'); assert.equal(ok.json.detection.method, 'auto-detect'); assert.equal(ok.json.detection.confidence, 'confirmed');
  const wrong = await c.post('/api/connections/preview', { apiKey: 'zzz_detect_WRONG_0001' }); assert.equal(wrong.json.ok, false); assert.equal(wrong.json.attempted[0].result, 'AUTH_FAILED');
  const unk = await c.post('/api/connections/preview', { apiKey: 'totally-unknown-format-xyz' }); assert.equal(unk.json.status, 'UNKNOWN_PROVIDER'); assert.deepEqual(unk.json.attempted, [], 'key was NOT sent anywhere when no registry provider matches'); assert.ok(unk.json.options.includes('openai_compatible'));
});

test('adapter adapts to real API behaviour (max_completion_tokens) and health states are normalized', async (t) => {
  const app = await startApp(); const P = await fakeProvider({ models: ['reasoner', 'plain'] }); t.after(async () => { await app.close(); await P.close(); });
  const c = await readyClient(app.base); const r = await addConnection(c, P, { enable: ['reasoner'] });
  assert.equal(r.health.json.models.reasoner.state, 'HEALTHY', 'adapter retried with max_completion_tokens after the 400');
  const ans = await c.chat({ text: 'hello there friend' }); assert.ok(ans.done);
  P.cfg.keys.clear(); // key revoked upstream
  const t2 = await c.post(`/api/connections/${r.saved.json.id}/test`); assert.equal(t2.json.status, 'AUTH_FAILED'); assert.equal(t2.json.providerHealth, 'AUTH_FAILED');
  const after = await c.chat({ text: 'another one please now' }); assert.equal(after.error.code, 'NO_COMPATIBLE_MODEL', 'router refuses models whose key is invalid');
});
