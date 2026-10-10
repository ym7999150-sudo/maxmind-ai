'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const zlib = require('zlib');
const crypto = require('crypto');
const core = require('@maxmind-ai/core');
const TE = require('@maxmind-ai/token-engine');
const R = require('@maxmind-ai/router');
const P = require('@maxmind-ai/providers');
const { createVault, maskKey, hashPassword, verifyPassword } = require('../src/crypto');
const { docxText, sniff } = require('../src/services/files');
const { loadEnv } = require('../src/env');

const serve = (handler) => new Promise((r) => { const s = http.createServer(handler); s.listen(0, '127.0.0.1', () => r({ url: `http://127.0.0.1:${s.address().port}`, close: () => new Promise((x) => s.close(x)), s })); });

test('core: HTTPS-only credentials, error normalization, bounded retry (never retry auth)', async () => {
  assert.throws(() => core.assertSafeUrl('http://example.com'), /HTTPS/);
  assert.doesNotThrow(() => core.assertSafeUrl('https://example.com'));
  assert.throws(() => core.assertSafeUrl('http://127.0.0.1:1'), /HTTPS/, 'loopback http needs explicit opt-in');
  let hits = { auth: 0, rl: 0, srv: 0 };
  const srv = await serve((req, res) => { const k = req.url.slice(1); hits[k]++; if (k === 'auth') { res.writeHead(401); res.end('{"error":{"message":"bad key sk-abcdefghijklmnop"}}'); } else if (k === 'rl') { res.writeHead(429, { 'retry-after': '0' }); res.end('{}'); } else { res.writeHead(500); res.end('{}'); } });
  const o = { allowInsecureLocal: true, baseDelayMs: 1 };
  await assert.rejects(core.request(srv.url + '/auth', { ...o, retries: 3 }), (e) => e.kind === 'AUTH_FAILED' && !/sk-abcdefgh/.test(e.message)); assert.equal(hits.auth, 1, 'auth failure is not retried, and secrets in messages are redacted');
  await assert.rejects(core.request(srv.url + '/rl', { ...o, retries: 2 }), (e) => e.kind === 'RATE_LIMITED'); assert.equal(hits.rl, 3);
  await assert.rejects(core.request(srv.url + '/srv', { ...o, retries: 1 }), (e) => e.kind === 'SERVER'); assert.equal(hits.srv, 2);
  await assert.rejects(core.request('http://127.0.0.1:1/x', { ...o, retries: 0, timeoutMs: 500 }), (e) => ['NETWORK', 'TIMEOUT'].includes(e.kind));
  await srv.close();
});

test('core: timeouts are normalized', async () => {
  const srv = await serve(() => { /* never answers */ });
  await assert.rejects(core.request(srv.url, { allowInsecureLocal: true, retries: 0, timeoutMs: 150 }), (e) => e.kind === 'TIMEOUT'); srv.s.closeAllConnections(); await srv.close();
});

test('crypto: AES-256-GCM is authenticated, AAD-bound, and keys are masked', () => {
  const v = createVault(crypto.randomBytes(32)); const enc = v.encrypt('sk-very-secret-1234', 'conn1');
  assert.ok(!JSON.stringify(enc).includes('very-secret')); assert.equal(v.decrypt(enc, 'conn1'), 'sk-very-secret-1234');
  assert.throws(() => v.decrypt(enc, 'conn2')); const t = { ...enc, ciphertext: Buffer.from(enc.ciphertext, 'base64').map((b, i) => (i === 0 ? b ^ 1 : b)).toString('base64') }; assert.throws(() => v.decrypt(t, 'conn1'));
  assert.notEqual(v.encrypt('x', 'a').ciphertext, v.encrypt('x', 'a').ciphertext, 'fresh IV per record');
  assert.equal(maskKey('sk-ant-abcdefghijklmnop1234').endsWith('1234'), true); assert.ok(!maskKey('sk-ant-abcdefghijklmnop1234').includes('abcdefgh'));
  const h = hashPassword('Correct Horse 9'); assert.ok(verifyPassword('Correct Horse 9', h)); assert.ok(!verifyPassword('wrong', h)); assert.ok(!h.includes('Correct'));
});

test('env validation gives helpful errors and forbids mock in production', () => {
  assert.throws(() => loadEnv({ root: '/nonexistent', overrides: { ENCRYPTION_KEY: '', AUTH_SECRET: '' } }), /ENCRYPTION_KEY[\s\S]*AUTH_SECRET/);
  const ok = { ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64'), AUTH_SECRET: 'x'.repeat(40) };
  assert.throws(() => loadEnv({ root: '/nonexistent', overrides: { ...ok, NODE_ENV: 'production', DEV_MOCK: '1' } }), /DEV_MOCK/);
  assert.throws(() => loadEnv({ root: '/nonexistent', overrides: { ENCRYPTION_KEY: 'c2hvcnQ=', AUTH_SECRET: 'x'.repeat(40) } }), /32 random bytes/);
  assert.equal(loadEnv({ root: '/nonexistent', overrides: ok }).mock, false);
});

test('token engine: compression, summary, retrieval, cache similarity, budgets, honest cost', () => {
  const hist = []; for (let i = 0; i < 16; i++) { hist.push({ role: 'user', content: `Q${i} about ${i % 4 === 0 ? 'react hooks and state' : 'cooking pasta'}. ` + 'filler words '.repeat(80) }); hist.push({ role: 'assistant', content: `A${i}. ` + 'details '.repeat(120) }); }
  const sum = TE.extendSummary('', hist.slice(0, 20)); assert.ok(sum.length <= 1800 && sum.includes('U:'));
  const ctx = TE.buildContext({ history: hist, summary: sum, query: 'more on react hooks please', systemTokens: 80, userTokens: 20, budget: { maxInputTokens: 2000 } });
  assert.ok(ctx.stats.sentTokens <= 2000, 'respects maxInputTokens'); assert.ok(ctx.stats.compressionPct > 40); assert.equal(ctx.messages[0].role, 'user'); assert.ok(ctx.stats.estimated === true);
  for (let i = 1; i < ctx.messages.length; i++) assert.notEqual(ctx.messages[i].role, ctx.messages[i - 1].role, 'roles alternate');
  assert.ok(TE.selectRelevant(hist, 'react hooks').every((m) => /react/.test(m.content)));
  assert.equal(TE.similarity('What is the capital of France?', 'what is the capital of france'), 1); assert.ok(TE.similarity('capital of France', 'best pasta recipe') < 0.2);
  assert.equal(TE.similarity('ما هي عاصمة فرنسا؟', 'ما هي عاصمه فرنسا'), 1, 'Arabic normalization');
  const now = Date.now(); assert.ok(TE.findCached([{ query: 'hello world there', queryNorm: 'hello world there', expiresAt: now + 1000 }], 'Hello world there!')); assert.equal(TE.findCached([{ query: 'hello world there', queryNorm: 'x', expiresAt: now - 1 }], 'hello world there'), null, 'expired entries ignored');
  assert.equal(TE.dedupeMessages([{ role: 'user', content: 'a' }, { role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }]).length, 2);
  const doc = Array.from({ length: 60 }, (_, i) => `Paragraph ${i} ${i === 37 ? 'mentions the quarterly revenue forecast explicitly' : 'lorem ipsum dolor sit amet'}`).join('\n\n');
  const sel = TE.selectDocumentChunks(doc, 'quarterly revenue forecast', 300); assert.ok(sel.truncated && sel.text.includes('quarterly revenue forecast') && TE.estimateTokens(sel.text) <= 330);
  assert.equal(TE.estimateCost({ input: 1000, output: 1000 }, null), null, 'unknown pricing → null, never invented'); assert.equal(TE.estimateCost({ input: 1e6, output: 0 }, { inputPer1M: 2, outputPer1M: 4 }), 2);
});

const cand = (o) => ({ key: o.key, providerId: 'p', connectionName: 'c', modelId: o.key, kind: 'chat', connectionStatus: 'VALID', capabilities: { chat: true, vision: 'unknown', ...(o.caps || {}) }, health: { state: o.health || 'HEALTHY', latencyMs: o.lat || 500 }, contextWindow: o.ctx || 32000, pricing: o.pricing || null,
  profile: { enabled: o.enabled !== false, role: '', strengths: '', weaknesses: '', bestFor: '', avoidFor: '', tasks: [], reasoning: 5, creativity: 5, accuracy: 5, speed: 5, cost: 5, trust: 5, flags: {}, capabilityOverrides: {}, ...(o.profile || {}) }, stats: o.stats || { n: 0, successes: 0 } });

test('router: hard gate (enabled + healthy + valid + capable) and transparent scoring', () => {
  const task = R.analyzeTask({ text: 'hello there' });
  const { scored, excluded } = R.scoreCandidates(task, [cand({ key: 'on' }), cand({ key: 'off', enabled: false }), cand({ key: 'sick', health: 'DEGRADED' }), cand({ key: 'rl', health: 'RATE_LIMITED' }), { ...cand({ key: 'badkey' }), connectionStatus: 'AUTH_FAILED' }, cand({ key: 'emb', caps: { chat: false } })]);
  assert.deepEqual(scored.map((s) => s.candidate.key), ['on']); assert.equal(excluded.length, 5);
  assert.ok(excluded.find((e) => e.candidate.key === 'off').reasons.includes('disabled_by_user')); assert.ok(excluded.find((e) => e.candidate.key === 'badkey').reasons.includes('credential_not_valid'));
  const b = scored[0].breakdown; assert.deepEqual(Object.keys(b).sort(), ['capability', 'cost', 'expertise', 'health', 'history', 'latency', 'performance', 'userPreference']);
  assert.ok(Math.abs(Object.values(b).reduce((a, x) => a + x.contribution, 0) - scored[0].score) < 0.2, 'score equals the sum of real contributions'); assert.equal(b.cost.note, 'pricing unknown');
  const v = R.analyzeTask({ text: 'what is in this picture', hasImage: true });
  const r = R.scoreCandidates(v, [cand({ key: 'novis' }), cand({ key: 'vis', caps: { vision: true } }), cand({ key: 'declared', profile: { capabilityOverrides: { vision: true } } })]);
  assert.deepEqual(r.scored.map((s) => s.candidate.key), ['vis', 'declared'], 'unknown vision is NOT treated as supported; user-declared ranks lower than confirmed');
  assert.ok(r.excluded[0].reasons[0].startsWith('missing_capability:vision'));
});

test('router plans: single/review/team by complexity; manual and team never substitute', () => {
  const mk = (n) => Array.from({ length: n }, (_, i) => cand({ key: 'm' + i, profile: { accuracy: 5 + i } }));
  const plan = (text, n, opts = {}) => { const task = R.analyzeTask({ text, critical: opts.critical }); const sc = R.scoreCandidates(task, opts.cands || mk(n)); return R.buildPlan({ mode: opts.mode || 'auto', task, ...sc, settings: opts.settings || {}, selection: opts.selection || {} }); };
  assert.equal(plan('hi there', 3).strategy, 'single'); assert.equal(plan('hi there', 3).expectedCalls, 1);
  assert.equal(plan('Compare these architectures and design a scalable authentication system step by step with trade-offs', 1).strategy, 'single');
  const cx = plan('Compare these architectures and design a scalable authentication system step by step with trade-offs. Which is better? Why? How would you migrate?', 3);
  assert.equal(cx.strategy, 'team'); assert.deepEqual(cx.steps.map((s) => s.role).slice(-2), ['reviewer', 'synthesizer']); assert.notEqual(cx.steps.find((s) => s.role === 'reviewer').key, cx.steps[0].key, 'reviewer differs from primary');
  const crit = plan('Explain it', 4, { critical: true, settings: { maxTeamSize: 3, maxCalls: 5 } }); assert.ok(crit.steps.filter((s) => !['reviewer', 'synthesizer'].includes(s.role)).length === 2 && crit.expectedCalls <= 5);
  assert.equal(plan('Compare these architectures and design a scalable authentication system step by step with trade-offs. Which is better?', 4, { settings: { multiModel: false } }).strategy, 'single');
  const m = plan('x', 2, { mode: 'manual', selection: { manualKey: 'ghost' } }); assert.equal(m.ok, false); assert.equal(m.code, 'MANUAL_MODEL_UNAVAILABLE');
  const tm = plan('x', 2, { mode: 'team', selection: { team: [{ key: 'm0' }, { key: 'nope' }] } }); assert.equal(tm.ok, false); assert.equal(tm.code, 'TEAM_MEMBER_UNAVAILABLE');
  const none = plan('x', 0); assert.equal(none.code, 'NO_COMPATIBLE_MODEL');
  const only = mk(3); only[2].profile.flags = { preferred: true };
  assert.deepEqual(plan('hello', 3, { cands: only, settings: { teamMode: 'manual' } }).steps.map((s) => s.key), ['m2'], 'manual team mode: only flagged models');
  assert.equal(plan('hello', 3, { cands: mk(3), settings: { teamMode: 'manual' } }).code, 'NO_SELECTED_MODELS');
  assert.equal(plan('hello', 3, { cands: only, settings: { teamMode: 'hybrid' } }).steps[0].key, 'm2', 'hybrid prefers flagged models');
});

test('providers: registry is extensible, detection is hint-only and never contacts non-matching providers', async () => {
  const reg = new P.Registry({}); assert.ok(reg.list().length >= 8); reg.register({ id: 'newco', name: 'NewCo', apiBaseUrl: 'https://api.newco.example/v1', keyPatterns: ['^nc-'] });
  assert.deepEqual(P.hints('nc-123456789', reg), ['newco']); assert.deepEqual(P.hints('totally unknown', reg), []); assert.throws(() => reg.register({ id: 'x' }));
  let contacted = 0; const fake = { validateKey: async () => { contacted++; throw new core.ProviderError('AUTH_FAILED', 'no'); } };
  const d = await P.detect('zz-unmatched-key-123', reg, () => fake); assert.equal(contacted, 0); assert.equal(d.provider, null); assert.equal(d.reason, 'no_matching_format');
  const d2 = await P.detect('sk-ant-api03-abcdefghijkl', reg, () => fake); assert.equal(contacted, 1, 'only the matching provider'); assert.equal(d2.provider, null); assert.equal(d2.attempted[0].result, 'AUTH_FAILED');
  assert.equal((await P.detect('has space in key 123', reg, () => fake)).reason, 'invalid_key_shape');
  const un = await P.adapters['openai-compatible'].embed(); assert.ok(core.isUnsupported(un), 'unsupported functions return UNSUPPORTED, not fake data');
});

test('anthropic adapter: x-api-key header, model list, chat + streaming usage mapping', async () => {
  const seen = []; const srv = await serve((req, res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
    seen.push({ url: req.url, key: req.headers['x-api-key'], ver: req.headers['anthropic-version'], auth: req.headers.authorization }); if (req.headers['x-api-key'] !== 'ant-key-1') { res.writeHead(401); return res.end('{"error":{"message":"invalid x-api-key"}}'); }
    if (req.url.startsWith('/v1/models')) { res.writeHead(200); return res.end(JSON.stringify({ data: [{ id: 'claude-x', display_name: 'Claude X', max_input_tokens: 200000, capabilities: { image_input: { supported: true } } }], has_more: false })); }
    const j = JSON.parse(b);
    if (j.stream) { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(`data: ${JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 11, output_tokens: 1 } } })}\n\n`); for (const w of ['Hel', 'lo']) res.write(`data: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: w } })}\n\n`); res.write(`data: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } })}\n\n`); return res.end(); }
    res.writeHead(200); res.end(JSON.stringify({ content: [{ type: 'text', text: 'Hello' }], stop_reason: 'end_turn', usage: { input_tokens: 9, output_tokens: 3 } })); }); });
  const A = P.adapters.anthropic; const conn = { baseUrl: srv.url + '/v1', apiKey: 'ant-key-1', allowInsecureLocal: true };
  const v = await A.validateKey(conn); assert.equal(v.modelCount, 1); assert.equal(v.models[0].capabilities.vision, true); assert.equal(v.models[0].contextWindow, 200000); assert.equal(v.models[0].capabilities.toolCalling, 'unknown');
  await assert.rejects(A.validateKey({ ...conn, apiKey: 'bad' }), (e) => e.kind === 'AUTH_FAILED');
  const c = await A.chat(conn, { model: 'claude-x', messages: [{ role: 'user', content: 'hi' }] }); assert.deepEqual([c.content, c.usage.input, c.usage.output, c.usage.total], ['Hello', 9, 3, 12]);
  let got = ''; const s = await A.streamChat(conn, { model: 'claude-x', messages: [{ role: 'user', content: 'hi' }] }, (d) => (got += d)); assert.equal(got, 'Hello'); assert.deepEqual([s.usage.input, s.usage.output], [11, 7]);
  const hc = await A.healthCheck(conn, 'claude-x'); assert.equal(hc.state, 'HEALTHY'); assert.ok(seen.every((x) => x.ver === '2023-06-01' && !x.auth && !x.url.includes('ant-key')), 'key only in x-api-key header'); await srv.close();
});

test('gemini adapter: key in header (never URL), methods → capabilities, usage mapping', async () => {
  const seen = []; const srv = await serve((req, res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { seen.push({ url: req.url, key: req.headers['x-goog-api-key'] });
    if (req.headers['x-goog-api-key'] !== 'AIzaGoodKey') { res.writeHead(403); return res.end('{"error":{"message":"API key not valid"}}'); }
    if (req.url.startsWith('/v1beta/models?')) { res.writeHead(200); return res.end(JSON.stringify({ models: [{ name: 'models/gem-chat', displayName: 'Gem', inputTokenLimit: 1000000, supportedGenerationMethods: ['generateContent', 'countTokens'] }, { name: 'models/gem-embed', supportedGenerationMethods: ['embedContent'] }] })); }
    if (req.url.includes(':streamGenerateContent')) { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Hi ' }] } }] })}\n\n`); res.write(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'there' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 5, totalTokenCount: 12 } })}\n\n`); return res.end(); }
    res.writeHead(200); res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'thinking...', thought: true }, { text: 'ok' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 1, totalTokenCount: 9 } })); }); });
  const G = P.adapters.gemini; const conn = { baseUrl: srv.url + '/v1beta', apiKey: 'AIzaGoodKey', allowInsecureLocal: true };
  const v = await G.validateKey(conn); assert.equal(v.models.find((m) => m.modelId === 'gem-chat').kind, 'chat'); assert.equal(v.models.find((m) => m.modelId === 'gem-embed').kind, 'embedding'); assert.equal(v.models[0].contextWindow, 1000000);
  const c = await G.chat(conn, { model: 'gem-chat', messages: [{ role: 'user', content: 'hi' }] }); assert.equal(c.content, 'ok', 'thought parts are not leaked'); assert.equal(c.usage.output, 5, 'output = total - prompt (includes thinking tokens)');
  let got = ''; const s = await G.streamChat(conn, { model: 'gem-chat', messages: [{ role: 'user', content: 'hi' }] }, (d) => (got += d)); assert.equal(got, 'Hi there'); assert.equal(s.usage.total, 12);
  await assert.rejects(G.validateKey({ ...conn, apiKey: 'nope' }), (e) => e.kind === 'AUTH_FAILED'); assert.ok(seen.every((x) => !x.url.includes('AIza')), 'key never in the URL'); await srv.close();
});

test('files: content sniffing (not just extension), DOCX extraction', () => {
  assert.equal(sniff('a.txt', Buffer.from('hello')).kind, 'text'); assert.equal(sniff('a.txt', Buffer.from([1, 0, 2, 3])), null, 'binary renamed .txt rejected');
  assert.equal(sniff('x.pdf', Buffer.from('%PDF-1.7 ...')).kind, 'pdf'); assert.equal(sniff('x.pdf', Buffer.from('nope')), null); assert.equal(sniff('x.js', Buffer.from('const a=1')).kind, 'text'); assert.equal(sniff('x.sh.exe', Buffer.from('MZ')), null);
  const xml = '<w:document><w:body><w:p><w:r><w:t>Hello</w:t></w:r></w:p><w:p><w:r><w:t>World &amp; co</w:t></w:r></w:p></w:body></w:document>'; const data = zlib.deflateRawSync(Buffer.from(xml)); const name = Buffer.from('word/document.xml');
  const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(8, 8); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(xml.length, 22); lh.writeUInt16LE(name.length, 26);
  const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(8, 10); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(xml.length, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(0, 42);
  const eo = Buffer.alloc(22); eo.writeUInt32LE(0x06054b50, 0); eo.writeUInt16LE(1, 8); eo.writeUInt16LE(1, 10); eo.writeUInt32LE(46 + name.length, 12); eo.writeUInt32LE(30 + name.length + data.length, 16);
  const docx = Buffer.concat([lh, name, data, ch, name, eo]); assert.equal(sniff('r.docx', docx).kind, 'docx'); assert.equal(docxText(docx), 'Hello\nWorld & co');
  assert.throws(() => docxText(Buffer.from('PK not really')), /DOCX/);
});
