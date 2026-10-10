'use strict';
const express = require('express');
const { MaxMindError } = require('@maxmind-ai/core');
const { wrap, limiter, sse } = require('../http');
const { getSettings, updateSettings } = require('../services/settings');
const { audit } = require('../services/audit');

function buildRoutes(ctx) {
  const { auth, connections, engine, chats, files, memory, insights, db, cfg, registry } = ctx;
  const r = express.Router();
  const must = auth.requireAuth(); const pending = auth.requireAuth({ allowPendingPasswordChange: true });
  const big = express.json({ limit: '16mb' });
  const bad = (m, code = 'BAD_REQUEST') => { throw new MaxMindError(code, m, { status: 400 }); };
  const str = (v, n = 200) => (typeof v === 'string' ? v.slice(0, n) : '');

  r.get('/health', (req, res) => res.json({ status: 'ok', mock: cfg.mock }));
  r.get('/meta', (req, res) => res.json({ name: 'MAXMIND AI', version: require('../../package.json').version, mockMode: cfg.mock }));

  // ---- auth
  r.post('/auth/login', limiter({ windowMs: 60000, max: 20, message: 'Too many login attempts.' }), wrap((req, res) => {
    const out = auth.login(str(req.body.username), str(req.body.password, 200), req.ip, req.headers['user-agent']);
    if (out.error === 'RATE_LIMITED') return res.status(429).json({ error: { code: 'RATE_LIMITED', message: `Too many failed attempts. Try again in ${out.retryAfterSec}s.` } });
    if (out.error) return res.status(401).json({ error: { code: 'INVALID_CREDENTIALS', message: 'Invalid username or password.' } });
    res.setHeader('Set-Cookie', out.cookie); res.json({ user: out.user, csrf: out.csrf });
  }));
  r.post('/auth/logout', pending, wrap((req, res) => { res.setHeader('Set-Cookie', auth.logout(req)); res.json({ ok: true }); }));
  r.get('/auth/me', pending, wrap((req, res) => { const s = getSettings(db, req.userId); res.json({ user: { id: req.userId, username: req.session.username, mustChangePassword: req.session.mustChangePassword }, csrf: req.session.csrf, settings: s, mockMode: cfg.mock }); }));
  r.post('/auth/change-password', pending, wrap((req, res) => {
    const out = auth.changePassword(req.userId, str(req.body.currentPassword, 200), str(req.body.newPassword, 200), req.ip, req.session.hash);
    if (out.error === 'INVALID_CURRENT_PASSWORD') return res.status(400).json({ error: { code: out.error, message: 'Current password is incorrect.' } });
    if (out.error) return res.status(400).json({ error: { code: out.error, message: out.message } });
    res.json({ ok: true });
  }));

  // ---- everything below needs a fully active session
  const api = express.Router(); api.use(must);
  api.get('/settings', wrap((req, res) => res.json(getSettings(db, req.userId))));
  api.put('/settings', wrap((req, res) => { const out = updateSettings(db, req.userId, req.body || {}); if (out.applied.length) audit(db, req.userId, 'settings_changed', { paths: out.applied }, req.ip); res.json(out.settings); }));

  // ---- providers & connections
  api.get('/providers', wrap((req, res) => {
    const conns = connections.list(req.userId);
    const defs = registry.list().map((d) => connections.publicDef(d));
    const custom = db.all('SELECT * FROM providers WHERE user_id=?', req.userId).map((p) => connections.publicDef(connections.defFor(req.userId, p.id)));
    const all = [...defs, ...custom].map((d) => { const mine = conns.filter((c) => c.providerId === d.id); return { ...d, connected: mine.some((c) => c.status === 'VALID'), connections: mine.length, discovered: mine.reduce((a, c) => a + c.stats.discovered, 0), healthy: mine.reduce((a, c) => a + c.stats.healthy, 0), enabled: mine.reduce((a, c) => a + c.stats.enabled, 0), lastChecked: Math.max(0, ...mine.map((c) => c.lastHealthAt || 0)) || null, pricing: 'Unknown unless the provider API reports it (see model rows)' }; });
    res.json({ providers: all });
  }));
  api.get('/connections', wrap((req, res) => res.json({ connections: connections.list(req.userId) })));
  api.post('/connections/preview', limiter({ windowMs: 60000, max: 12, key: (q) => q.userId }), wrap(async (req, res) => {
    const b = req.body || {}; res.json(await connections.preview(req.userId, { apiKey: b.apiKey, providerId: str(b.providerId), baseUrl: str(b.baseUrl, 300), protocol: str(b.protocol, 30), providerName: str(b.providerName, 60) }));
  }));
  api.post('/connections/preview/:id/health', wrap(async (req, res) => res.json(await connections.previewHealth(req.userId, req.params.id))));
  api.post('/connections', wrap(async (req, res) => { const b = req.body || {}; if (!b.pendingId) bad('pendingId required'); res.status(201).json(await connections.save(req.userId, { pendingId: str(b.pendingId), name: str(b.name, 60), enableModelIds: Array.isArray(b.enableModelIds) ? b.enableModelIds.slice(0, 500).map(String) : [], ip: req.ip })); }));
  api.patch('/connections/:id', wrap((req, res) => res.json(connections.rename(req.userId, req.params.id, str(req.body.name, 60)))));
  api.put('/connections/:id/key', wrap(async (req, res) => res.json(await connections.replaceKey(req.userId, req.params.id, req.body.apiKey, req.ip))));
  api.post('/connections/:id/test', limiter({ windowMs: 60000, max: 6, key: (q) => q.userId }), wrap(async (req, res) => res.json(await connections.testConnection(req.userId, req.params.id, { onlyEnabled: req.body && req.body.onlyEnabled === true, ip: req.ip }))));
  api.delete('/connections/:id', wrap((req, res) => res.json(connections.remove(req.userId, req.params.id, req.ip))));

  // ---- models / profiles / agents
  api.get('/models', wrap((req, res) => res.json({ models: connections.listModels(req.userId, req.query.connectionId ? String(req.query.connectionId) : null) })));
  api.patch('/models/:key', wrap((req, res) => res.json(connections.updateProfile(req.userId, req.params.key, req.body || {}, req.ip))));
  api.get('/agents', wrap((req, res) => res.json({ agents: insights.agents(req.userId) })));

  // ---- chats
  api.get('/chats', wrap((req, res) => res.json({ chats: chats.list(req.userId, { q: str(req.query.q, 100), archived: req.query.archived === '1' }) })));
  api.post('/chats', wrap((req, res) => res.status(201).json(chats.create(req.userId, str(req.body.title, 120) || 'New chat'))));
  api.get('/chats/:id', wrap((req, res) => res.json(chats.get(req.userId, req.params.id))));
  api.patch('/chats/:id', wrap((req, res) => res.json(chats.update(req.userId, req.params.id, req.body || {}))));
  api.delete('/chats/:id', wrap((req, res) => res.json(chats.remove(req.userId, req.params.id))));
  api.get('/chats/:id/export', wrap((req, res) => { const f = chats.export(req.userId, req.params.id, req.query.format === 'json' ? 'json' : 'markdown'); res.setHeader('Content-Type', f.type); res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(f.name)}`); res.send(f.body); }));

  api.post('/chat/send', limiter({ windowMs: 60000, max: 40, key: (q) => q.userId, message: 'Too many messages. Slow down.' }), wrap(async (req, res) => {
    const b = req.body || {}; const text = str(b.text, 60000);
    const ac = new AbortController(); let finished = false; res.on('close', () => { if (!finished) ac.abort(); });
    const emit = sse(res);
    try {
      let t = text, regenerateOf = null, hidden = false, chatId = b.chatId ? str(b.chatId) : null;
      if (b.action === 'regenerate' || b.action === 'edit') {
        if (!chatId) bad('chatId required'); chats.own(req.userId, chatId);
        let userMsg;
        if (b.action === 'edit') { userMsg = db.get('SELECT seq FROM messages WHERE chat_id=? AND id=? AND role=?', chatId, str(b.messageId), 'user'); if (!userMsg) bad('Message not found', 'NOT_FOUND'); db.run('DELETE FROM messages WHERE chat_id=? AND seq>=?', chatId, userMsg.seq); db.run('UPDATE chats SET summary=?, summary_upto=0 WHERE id=?', '', chatId); }
        else { userMsg = db.get(`SELECT id,seq,content,meta FROM messages WHERE chat_id=? AND role='user' ORDER BY seq DESC LIMIT 1`, chatId); if (!userMsg) bad('Nothing to regenerate'); db.run('DELETE FROM messages WHERE chat_id=? AND seq>?', chatId, userMsg.seq); t = userMsg.content; regenerateOf = { userMsgId: userMsg.id }; try { b.attachmentIds = (JSON.parse(userMsg.meta || '{}').attachments || []).map((a) => a.id); } catch { /* none */ } }
      } else if (b.action === 'continue') { if (!chatId) bad('chatId required'); t = 'Continue exactly where your previous answer stopped. Do not repeat what you already wrote.'; hidden = true; }
      if (!t.trim()) bad('Message is empty');
      const result = await engine.send({ userId: req.userId, chatId, text: t, attachmentIds: Array.isArray(b.attachmentIds) ? b.attachmentIds.slice(0, 8) : [], critical: b.critical === true, modeOverride: ['auto', 'manual', 'team', 'smart'].includes(b.mode) ? b.mode : undefined, signal: ac.signal, emit, regenerateOf, hidden });
      void result;
    } catch (e) { emit('error', { code: e.code || 'INTERNAL', message: e instanceof MaxMindError ? e.message : 'Internal server error.', details: e.details }); if (!(e instanceof MaxMindError)) console.error('[chat]', e && e.message); }
    finished = true; res.end();
  }));

  // ---- files / images / voice
  api.post('/files', big, wrap(async (req, res) => res.status(201).json(await files.save(req.userId, { name: str(req.body.name, 200), dataBase64: req.body.dataBase64, chatId: req.body.chatId ? str(req.body.chatId) : null }))));
  api.get('/files/:id', wrap((req, res) => { const f = files.content(req.userId, req.params.id); res.setHeader('Content-Type', f.mime); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Content-Disposition', 'inline'); res.send(f.buf); }));
  api.post('/images/generate', wrap(async (req, res) => {
    const chatId = req.body.chatId ? str(req.body.chatId) : null; if (chatId) chats.own(req.userId, chatId);
    const out = await engine.generateImage(req.userId, { prompt: str(req.body.prompt, 4000), modelKey: req.body.modelKey ? str(req.body.modelKey) : null, chatId });
    if (chatId) { engine.addMessage(chatId, 'user', '🎨 ' + str(req.body.prompt, 4000), null); engine.addMessage(chatId, 'assistant', out.attachmentId ? `![generated image](/api/files/${out.attachmentId})` : `[generated image](${out.url})`, { generatedBy: out.model }); }
    res.json(out);
  }));
  api.post('/voice/transcribe', big, wrap(async (req, res) => { const audio = Buffer.from(String(req.body.audioBase64 || ''), 'base64'); if (!audio.length || audio.length > 20 * 1048576) bad('Invalid audio'); res.json(await engine.transcribe(req.userId, { audio, mime: str(req.body.mime, 60) || 'audio/webm' })); }));

  // ---- memory
  api.get('/memory', wrap((req, res) => res.json({ items: memory.list(req.userId), enabled: getSettings(db, req.userId).memory.enabled })));
  api.post('/memory', wrap((req, res) => res.status(201).json(memory.add(req.userId, req.body.content))));
  api.patch('/memory/:id', wrap((req, res) => res.json(memory.update(req.userId, req.params.id, req.body.content))));
  api.delete('/memory/:id', wrap((req, res) => res.json(memory.remove(req.userId, req.params.id))));
  api.delete('/memory', wrap((req, res) => res.json(memory.clear(req.userId))));

  // ---- observability
  api.get('/monitor', wrap((req, res) => res.json(insights.monitor(req.userId, Math.min(90, Math.max(1, Number(req.query.days) || 7))))));
  api.get('/map', wrap((req, res) => res.json(insights.map(req.userId))));
  api.get('/audit', wrap((req, res) => res.json({ events: insights.audit(req.userId, Number(req.query.limit) || 100) })));
  r.use(api);
  r.use((req, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Unknown API route.' } }));
  return r;
}
module.exports = { buildRoutes };
