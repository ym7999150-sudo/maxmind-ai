'use strict';
const { assertSafeUrl, MaxMindError, HEALTH, PROVIDER_HEALTH } = require('@maxmind-ai/core');
const { detect, getAdapter, validKeyShape, NON_CHAT_KINDS } = require('@maxmind-ai/providers');
const { maskKey } = require('../crypto');
const { audit } = require('./audit');

const ROLES = ['', 'planner', 'researcher', 'coder', 'analyst', 'critic', 'vision', 'document', 'synthesizer', 'writer', 'generalist'];
const CAPS = ['chat', 'vision', 'audioInput', 'audioOutput', 'imageGeneration', 'toolCalling', 'streaming', 'embeddings', 'structuredOutput'];
const DEFAULT_PROFILE = () => ({ role: '', strengths: '', weaknesses: '', bestFor: '', avoidFor: '', tasks: [], reasoning: 5, creativity: 5, accuracy: 5, speed: 5, cost: 5, trust: 5, notes: '', flags: {}, capabilityOverrides: {} });
const J = (s, d = null) => { try { return s == null ? d : JSON.parse(s); } catch { return d; } };

function createConnections(ctx) {
  const { cfg, db, vault, registry } = ctx;
  const pending = new Map();
  const allowLocal = cfg.allowInsecureLocal;
  const purge = () => { const now = Date.now(); for (const [k, v] of pending) if (v.expires < now) pending.delete(k); };

  const { normalize } = require('@maxmind-ai/providers/registry');
  function defFor(userId, providerId) {
    const b = registry.get(providerId); if (b) return b;
    const r = db.get('SELECT * FROM providers WHERE user_id=? AND id=?', userId, providerId);
    return r ? normalize({ id: r.id, name: r.name, apiBaseUrl: r.base_url, adapter: r.protocol, classification: r.classification, custom: true, tags: ['custom'] }) : null;
  }
  const connOf = (def, apiKey) => ({ baseUrl: def.apiBaseUrl, apiKey, allowInsecureLocal: allowLocal });

  // ------------------------------------------------------------- validation + discovery (no persistence)
  async function preview(userId, { apiKey, providerId, baseUrl, protocol, providerName }) {
    purge();
    apiKey = String(apiKey || '').trim();
    if (!validKeyShape(apiKey)) throw new MaxMindError('INVALID_KEY', 'The key looks invalid (empty, too short/long or contains spaces).', { status: 400 });
    if ([...pending.values()].filter((p) => p.userId === userId).length >= 8) throw new MaxMindError('TOO_MANY_PENDING', 'Too many unsaved previews. Save or wait.', { status: 429 });
    let def = null, detection;
    if (baseUrl) {
      assertSafeUrl(baseUrl, { allowInsecureLocal: allowLocal });
      const proto = ['openai-compatible', 'anthropic', 'gemini'].includes(protocol) ? protocol : 'openai-compatible';
      const slug = 'custom-' + (String(providerName || new URL(baseUrl).hostname).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'provider');
      def = normalize({ id: slug, name: providerName || new URL(baseUrl).hostname, apiBaseUrl: baseUrl.replace(/\/+$/, ''), adapter: proto, custom: true, tags: ['custom'] });
      detection = { method: 'user-supplied-base-url', confidence: 'user_specified' };
    } else if (providerId && providerId !== 'auto') {
      def = defFor(userId, providerId); if (!def) throw new MaxMindError('UNKNOWN_PROVIDER_ID', 'Provider not found in registry.', { status: 404 });
      detection = { method: 'user-selected', confidence: 'user_specified' };
    }
    let validation;
    if (def) {
      try { validation = await getAdapter(def).validateKey(connOf(def, apiKey)); }
      catch (e) { return { ok: false, status: e.kind === 'AUTH_FAILED' ? 'AUTH_FAILED' : 'VALIDATION_FAILED', provider: { id: def.id, name: def.name }, error: e.message, errorKind: e.kind || null }; }
      detection.confidence = detection.confidence === 'user_specified' ? 'confirmed (authenticated response received)' : 'confirmed';
    } else {
      const d = await detect(apiKey, registry, getAdapter, { allowInsecureLocal: allowLocal });
      if (!d.provider) return { ok: false, status: 'UNKNOWN_PROVIDER', attempted: d.attempted, reason: d.reason, options: ['select_provider', 'enter_base_url', 'openai_compatible'] };
      if (d.confidence !== 'confirmed') return { ok: false, status: 'RATE_LIMITED', provider: { id: d.provider }, attempted: d.attempted };
      def = registry.get(d.provider); validation = d.validation; detection = { method: 'auto-detect', confidence: 'confirmed', attempted: d.attempted };
    }
    const id = db.id();
    pending.set(id, { userId, apiKey, def, models: validation.models, health: new Map(), detection, expires: Date.now() + 10 * 60000 });
    return { ok: true, pendingId: id, status: 'VALID', provider: publicDef(def), detection: { ...detection, attempted: detection.attempted }, models: validation.models.map(pubModel), modelCount: validation.models.length, keyMask: maskKey(apiKey) };
  }
  const pubModel = (m) => ({ modelId: m.modelId, name: m.name, kind: m.kind, kindSource: m.kindSource, capabilities: m.capabilities, contextWindow: m.contextWindow, inputModalities: m.inputModalities, outputModalities: m.outputModalities, pricing: m.pricing });
  const publicDef = (d) => ({ id: d.id, name: d.name, logo: d.logo, website: d.website, documentationUrl: d.documentationUrl, apiKeyUrl: d.apiKeyUrl, protocol: d.protocol, classification: d.classification, tags: d.tags, custom: d.custom, apiBaseUrl: d.apiBaseUrl, authenticationMethod: d.authenticationMethod, modelDiscoveryMethod: d.modelDiscoveryMethod });

  // ------------------------------------------------------------- health checks (real minimal requests)
  const testable = (m) => !NON_CHAT_KINDS.includes(m.kind) && m.kind !== 'other' && m.capabilities.chat !== false;
  async function runHealth(def, apiKey, models, { max = cfg.healthMaxModels, concurrency = 4, only = null, onResult } = {}) {
    const adapter = getAdapter(def); const conn = connOf(def, apiKey);
    const results = new Map(); const list = only ? models.filter((m) => only.includes(m.modelId)) : models;
    const todo = []; let skippedCap = 0;
    for (const m of list) {
      if (!testable(m)) results.set(m.modelId, { state: HEALTH.UNKNOWN, latencyMs: null, httpStatus: null, error: 'Not chat-tested (non-chat model kind: ' + m.kind + ')' });
      else if (todo.length >= max) { skippedCap++; results.set(m.modelId, { state: HEALTH.UNKNOWN, latencyMs: null, httpStatus: null, error: 'Not tested: HEALTHCHECK_MAX_MODELS cap reached (enable & re-test to check)' }); }
      else todo.push(m);
    }
    let stop = null, rl = 0, i = 0;
    const worker = async () => {
      while (i < todo.length && !stop) {
        const m = todo[i++];
        const r = await adapter.healthCheck(conn, m.modelId);
        if (r.state === HEALTH.AUTH_FAILED) stop = 'AUTH_FAILED';
        if (r.state === HEALTH.RATE_LIMITED && ++rl >= 3) stop = 'RATE_LIMITED';
        results.set(m.modelId, r); if (onResult) onResult(m.modelId, r);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, todo.length) }, worker));
    for (const m of todo) if (!results.has(m.modelId)) results.set(m.modelId, { state: stop === 'AUTH_FAILED' ? HEALTH.AUTH_FAILED : HEALTH.RATE_LIMITED, latencyMs: null, httpStatus: null, error: 'Skipped: ' + stop });
    return { results, stop, skippedCap };
  }
  const summarize = (results) => {
    const c = { total: 0, healthy: 0, degraded: 0, unavailable: 0, unknown: 0, rateLimited: 0, authFailed: 0, timeout: 0 };
    const key = { HEALTHY: 'healthy', DEGRADED: 'degraded', UNKNOWN: 'unknown', RATE_LIMITED: 'rateLimited', AUTH_FAILED: 'authFailed', TIMEOUT: 'timeout' };
    for (const r of results.values()) { c.total++; c[key[r.state] || 'unavailable']++; }
    return c;
  };
  async function previewHealth(userId, pendingId) {
    purge(); const p = pending.get(pendingId); if (!p || p.userId !== userId) throw new MaxMindError('PENDING_EXPIRED', 'Preview expired. Paste the key again.', { status: 404 });
    const { results, stop, skippedCap } = await runHealth(p.def, p.apiKey, p.models);
    p.health = results; p.expires = Date.now() + 10 * 60000;
    return { summary: summarize(results), stoppedEarly: stop, skippedByCap: skippedCap, models: Object.fromEntries([...results].map(([k, v]) => [k, v])) };
  }

  // ------------------------------------------------------------- persistence
  function upsertModels(connId, models, health) {
    const now = Date.now(); const keep = [];
    for (const m of models) {
      const ex = db.get('SELECT id FROM ai_models WHERE connection_id=? AND model_id=?', connId, m.modelId);
      const pk = ex ? ex.id : db.id(); keep.push(pk);
      if (ex) db.run('UPDATE ai_models SET name=?,kind=?,kind_source=?,context_window=?,input_modalities=?,output_modalities=?,pricing=?,discovered_at=? WHERE id=?', m.name, m.kind, m.kindSource, m.contextWindow, JSON.stringify(m.inputModalities), JSON.stringify(m.outputModalities), JSON.stringify(m.pricing), now, pk);
      else { db.run('INSERT INTO ai_models(id,connection_id,model_id,name,kind,kind_source,context_window,input_modalities,output_modalities,pricing,discovered_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)', pk, connId, m.modelId, m.name, m.kind, m.kindSource, m.contextWindow, JSON.stringify(m.inputModalities), JSON.stringify(m.outputModalities), JSON.stringify(m.pricing), now);
        db.run('INSERT INTO model_profiles(model_pk,enabled,json) VALUES(?,0,?)', pk, JSON.stringify(DEFAULT_PROFILE())); }
      db.run('INSERT INTO model_capabilities(model_pk,json) VALUES(?,?) ON CONFLICT(model_pk) DO UPDATE SET json=excluded.json', pk, JSON.stringify(m.capabilities));
      const h = health && health.get(m.modelId);
      if (h) db.run('INSERT INTO model_health(model_pk,state,latency_ms,http_status,error,checked_at) VALUES(?,?,?,?,?,?) ON CONFLICT(model_pk) DO UPDATE SET state=excluded.state,latency_ms=excluded.latency_ms,http_status=excluded.http_status,error=excluded.error,checked_at=excluded.checked_at', pk, h.state, h.latencyMs, h.httpStatus, h.error ? String(h.error).slice(0, 300) : null, now);
    }
    return keep;
  }
  function recomputeProviderHealth(connId) {
    const c = db.get('SELECT status FROM connections WHERE id=?', connId); if (!c) return;
    const rows = db.all(`SELECT h.state s FROM model_health h JOIN ai_models m ON m.id=h.model_pk WHERE m.connection_id=? AND m.kind NOT IN ('embedding','audio','image','moderation','other')`, connId);
    let ph = PROVIDER_HEALTH.CONNECTED;
    if (c.status === 'AUTH_FAILED') ph = PROVIDER_HEALTH.AUTH_FAILED; else if (c.status === 'OFFLINE') ph = PROVIDER_HEALTH.OFFLINE;
    else if (rows.length) { const n = (s) => rows.filter((r) => r.s === s).length; const h = n('HEALTHY'), t = rows.filter((r) => r.s !== 'UNKNOWN').length;
      if (n('AUTH_FAILED') && !h) ph = PROVIDER_HEALTH.AUTH_FAILED; else if (n('RATE_LIMITED') && !h) ph = PROVIDER_HEALTH.RATE_LIMITED;
      else if (t === 0) ph = PROVIDER_HEALTH.CONNECTED; else if (h === 0) ph = PROVIDER_HEALTH.DEGRADED; else if (h / t >= 0.7) ph = PROVIDER_HEALTH.HEALTHY; else ph = PROVIDER_HEALTH.DEGRADED; }
    db.run('UPDATE connections SET provider_health=? WHERE id=?', ph, connId);
  }
  function ensureCustomProvider(userId, def) {
    if (!def.custom || registry.get(def.id)) return;
    db.run('INSERT OR IGNORE INTO providers(id,user_id,name,base_url,protocol,classification,created_at) VALUES(?,?,?,?,?,?,?)', def.id, userId, def.name, def.apiBaseUrl, def.adapter, def.classification, Date.now());
  }
  async function save(userId, { pendingId, name, enableModelIds = [], ip }) {
    purge(); const p = pending.get(pendingId); if (!p || p.userId !== userId) throw new MaxMindError('PENDING_EXPIRED', 'Preview expired. Paste the key again.', { status: 404 });
    const connId = db.id(); const label = String(name || '').trim().slice(0, 60) || `${p.def.name} key`;
    db.tx(() => {
      ensureCustomProvider(userId, p.def);
      db.run('INSERT INTO connections(id,user_id,provider_id,name,key_mask,status,provider_health,detection,created_at,last_validated_at,last_health_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)', connId, userId, p.def.id, label, maskKey(p.apiKey), 'VALID', 'CONNECTED', JSON.stringify(p.detection), Date.now(), Date.now(), p.health.size ? Date.now() : null);
      const enc = vault.encrypt(p.apiKey, connId);
      db.run('INSERT INTO provider_credentials(connection_id,ciphertext,iv,tag,version) VALUES(?,?,?,?,?)', connId, enc.ciphertext, enc.iv, enc.tag, enc.version);
      upsertModels(connId, p.models, p.health);
      for (const mid of enableModelIds) { const m = db.get('SELECT id FROM ai_models WHERE connection_id=? AND model_id=?', connId, String(mid)); if (m) db.run('UPDATE model_profiles SET enabled=1 WHERE model_pk=?', m.id); }
    });
    recomputeProviderHealth(connId); pending.delete(pendingId);
    audit(db, userId, 'api_key_added', { connectionId: connId, provider: p.def.id }, ip); audit(db, userId, 'provider_connected', { provider: p.def.id }, ip);
    for (const mid of enableModelIds) audit(db, userId, 'model_enabled', { connectionId: connId, model: mid }, ip);
    if (!p.health.size) testConnection(userId, connId, { onlyEnabled: true }).catch(() => {}); // background health when skipped in UI
    return getConnection(userId, connId);
  }

  // ------------------------------------------------------------- reads
  function ownedConn(userId, connId) { const c = db.get('SELECT * FROM connections WHERE id=? AND user_id=?', connId, userId); if (!c) throw new MaxMindError('NOT_FOUND', 'Connection not found.', { status: 404 }); return c; }
  function credential(connId) { const r = db.get('SELECT * FROM provider_credentials WHERE connection_id=?', connId); if (!r) throw new MaxMindError('NO_CREDENTIAL', 'Missing credential', { status: 500 }); return vault.decrypt(r, connId); }
  function connStats(connId) {
    const r = db.get(`SELECT COUNT(*) total,
      SUM(CASE WHEN h.state='HEALTHY' THEN 1 ELSE 0 END) healthy, SUM(CASE WHEN h.state='DEGRADED' THEN 1 ELSE 0 END) degraded,
      SUM(CASE WHEN h.state IN ('UNAVAILABLE','TIMEOUT','AUTH_FAILED','RATE_LIMITED') THEN 1 ELSE 0 END) failed,
      SUM(CASE WHEN p.enabled=1 THEN 1 ELSE 0 END) enabled FROM ai_models m LEFT JOIN model_health h ON h.model_pk=m.id LEFT JOIN model_profiles p ON p.model_pk=m.id WHERE m.connection_id=?`, connId);
    return { discovered: r.total || 0, healthy: r.healthy || 0, degraded: r.degraded || 0, failed: r.failed || 0, enabled: r.enabled || 0 };
  }
  function pubConn(c) { const def = defFor(c.user_id, c.provider_id);
    return { id: c.id, name: c.name, providerId: c.provider_id, provider: def ? publicDef(def) : { id: c.provider_id, name: c.provider_id }, keyMask: c.key_mask, status: c.status, providerHealth: c.provider_health,
      detection: J(c.detection), lastError: c.last_error, createdAt: c.created_at, lastValidatedAt: c.last_validated_at, lastHealthAt: c.last_health_at, stats: connStats(c.id) }; }
  const getConnection = (userId, id) => pubConn(ownedConn(userId, id));
  const list = (userId) => db.all('SELECT * FROM connections WHERE user_id=? ORDER BY created_at', userId).map(pubConn);

  function modelRows(userId, where = '', ...params) {
    return db.all(`SELECT m.*, c.name conn_name, c.provider_id, c.key_mask, c.status conn_status, c.provider_health, c.user_id,
        h.state h_state, h.latency_ms h_lat, h.http_status h_http, h.error h_err, h.checked_at h_at, p.enabled, p.json prof, k.json caps
      FROM ai_models m JOIN connections c ON c.id=m.connection_id LEFT JOIN model_health h ON h.model_pk=m.id LEFT JOIN model_profiles p ON p.model_pk=m.id LEFT JOIN model_capabilities k ON k.model_pk=m.id
      WHERE c.user_id=? ${where} ORDER BY c.created_at, m.model_id`, userId, ...params);
  }
  const pubModelRow = (r) => { const def = defFor(r.user_id, r.provider_id); return { key: r.id, connectionId: r.connection_id, connectionName: r.conn_name, providerId: r.provider_id, providerName: def ? def.name : r.provider_id, keyMask: r.key_mask,
    modelId: r.model_id, name: r.name, kind: r.kind, kindSource: r.kind_source, capabilities: J(r.caps, {}), contextWindow: r.context_window, inputModalities: J(r.input_modalities), outputModalities: J(r.output_modalities), pricing: J(r.pricing),
    connectionStatus: r.conn_status, providerHealth: r.provider_health, health: { state: r.h_state || 'UNKNOWN', latencyMs: r.h_lat, httpStatus: r.h_http, error: r.h_err, checkedAt: r.h_at },
    profile: { ...DEFAULT_PROFILE(), ...J(r.prof, {}), enabled: !!r.enabled } }; };
  const listModels = (userId, connId) => modelRows(userId, connId ? 'AND c.id=?' : '', ...(connId ? [connId] : [])).map(pubModelRow);
  function getModel(userId, key) { const r = modelRows(userId, 'AND m.id=?', key)[0]; if (!r) throw new MaxMindError('NOT_FOUND', 'Model not found.', { status: 404 }); return pubModelRow(r); }

  /** Candidates for the router: public model rows + usage stats from real model_usage records. */
  function loadCandidates(userId) {
    const models = listModels(userId);
    const rows = db.all(`SELECT model_pk, status, latency_ms FROM model_usage WHERE user_id=? AND model_pk IS NOT NULL AND role<>'image' ORDER BY created_at DESC LIMIT 3000`, userId);
    const by = new Map();
    for (const r of rows) { // rows are newest-first
      let s = by.get(r.model_pk); if (!s) { s = { n: 0, ok: 0, latSum: 0, latN: 0, recent: [] }; by.set(r.model_pk, s); }
      s.n++; if (r.status === 'OK') { s.ok++; if (r.latency_ms != null) { s.latSum += r.latency_ms; s.latN++; } } if (s.recent.length < 10) s.recent.push(r.status === 'OK' ? 0 : 1);
    }
    return models.map((m) => { const s = by.get(m.key); m.stats = s ? { n: s.n, successes: s.ok, avgLatencyMs: s.latN ? s.latSum / s.latN : null, recentFailRate: s.recent.reduce((a, b) => a + b, 0) / s.recent.length } : { n: 0, successes: 0 }; return m; });
  }

  // ------------------------------------------------------------- mutations
  async function testConnection(userId, connId, { onlyEnabled = false, ip } = {}) {
    const c = ownedConn(userId, connId); const def = defFor(userId, c.provider_id); const key = credential(connId);
    let validation;
    try { validation = await getAdapter(def).validateKey(connOf(def, key)); }
    catch (e) {
      const status = e.kind === 'AUTH_FAILED' ? 'AUTH_FAILED' : (e.kind === 'NETWORK' || e.kind === 'TIMEOUT') ? 'OFFLINE' : 'VALIDATION_FAILED';
      db.run('UPDATE connections SET status=?, last_error=?, last_validated_at=? WHERE id=?', status, String(e.message).slice(0, 300), Date.now(), connId);
      if (status === 'AUTH_FAILED') db.run(`UPDATE model_health SET state='AUTH_FAILED', error='API key rejected', checked_at=? WHERE model_pk IN (SELECT id FROM ai_models WHERE connection_id=?)`, Date.now(), connId);
      recomputeProviderHealth(connId); audit(db, userId, 'api_key_tested', { connectionId: connId, result: status }, ip); return getConnection(userId, connId);
    }
    db.run('UPDATE connections SET status=?, last_error=NULL, last_validated_at=? WHERE id=?', 'VALID', Date.now(), connId);
    // models that disappeared upstream become unavailable (kept, so user settings survive)
    const present = new Set(validation.models.map((m) => m.modelId));
    for (const r of db.all('SELECT id, model_id FROM ai_models WHERE connection_id=?', connId)) if (!present.has(r.model_id)) db.run(`INSERT INTO model_health(model_pk,state,error,checked_at) VALUES(?,'UNAVAILABLE','No longer listed by provider',?) ON CONFLICT(model_pk) DO UPDATE SET state='UNAVAILABLE', error='No longer listed by provider', checked_at=excluded.checked_at`, r.id, Date.now());
    const enabledIds = new Set(db.all('SELECT m.model_id id FROM ai_models m JOIN model_profiles p ON p.model_pk=m.id WHERE m.connection_id=? AND p.enabled=1', connId).map((r) => r.id));
    const neverChecked = new Set(db.all('SELECT m.model_id id FROM ai_models m LEFT JOIN model_health h ON h.model_pk=m.id WHERE m.connection_id=? AND h.model_pk IS NULL', connId).map((r) => r.id));
    upsertModels(connId, validation.models, null);
    const only = onlyEnabled ? [...new Set([...enabledIds, ...neverChecked])].filter((id) => present.has(id)) : null;
    const { results } = await runHealth(def, key, validation.models, { only, max: Math.max(cfg.healthMaxModels, enabledIds.size) });
    const byId = new Map(db.all('SELECT id, model_id FROM ai_models WHERE connection_id=?', connId).map((r) => [r.model_id, r.id]));
    const now = Date.now();
    for (const [mid, h] of results) { const pk = byId.get(mid); if (pk) db.run('INSERT INTO model_health(model_pk,state,latency_ms,http_status,error,checked_at) VALUES(?,?,?,?,?,?) ON CONFLICT(model_pk) DO UPDATE SET state=excluded.state,latency_ms=excluded.latency_ms,http_status=excluded.http_status,error=excluded.error,checked_at=excluded.checked_at', pk, h.state, h.latencyMs, h.httpStatus, h.error ? String(h.error).slice(0, 300) : null, now); }
    db.run('UPDATE connections SET last_health_at=? WHERE id=?', now, connId);
    recomputeProviderHealth(connId); audit(db, userId, 'api_key_tested', { connectionId: connId, result: 'VALID' }, ip);
    return getConnection(userId, connId);
  }
  async function replaceKey(userId, connId, newKey, ip) {
    const c = ownedConn(userId, connId); const def = defFor(userId, c.provider_id); newKey = String(newKey || '').trim();
    if (!validKeyShape(newKey)) throw new MaxMindError('INVALID_KEY', 'The key looks invalid.', { status: 400 });
    try { await getAdapter(def).validateKey(connOf(def, newKey)); } catch (e) { throw new MaxMindError('VALIDATION_FAILED', `The new key was rejected by ${def.name}: ${e.message}`, { status: 400 }); }
    const enc = vault.encrypt(newKey, connId);
    db.run('UPDATE provider_credentials SET ciphertext=?, iv=?, tag=? WHERE connection_id=?', enc.ciphertext, enc.iv, enc.tag, connId);
    db.run('UPDATE connections SET key_mask=?, status=?, last_error=NULL WHERE id=?', maskKey(newKey), 'VALID', connId);
    audit(db, userId, 'api_key_edited', { connectionId: connId }, ip);
    return testConnection(userId, connId, { onlyEnabled: true, ip });
  }
  function rename(userId, connId, name) { ownedConn(userId, connId); db.run('UPDATE connections SET name=? WHERE id=?', String(name).trim().slice(0, 60) || 'Connection', connId); return getConnection(userId, connId); }
  function remove(userId, connId, ip) { const c = ownedConn(userId, connId); db.run('DELETE FROM connections WHERE id=?', connId); audit(db, userId, 'api_key_deleted', { connectionId: connId, provider: c.provider_id }, ip); audit(db, userId, 'provider_disconnected', { provider: c.provider_id }, ip); return { ok: true }; }
  function setEnabled(userId, key, enabled, ip) { const m = getModel(userId, key); db.run('UPDATE model_profiles SET enabled=? WHERE model_pk=?', enabled ? 1 : 0, key); audit(db, userId, enabled ? 'model_enabled' : 'model_disabled', { model: m.modelId, connectionId: m.connectionId }, ip); return getModel(userId, key); }
  function updateProfile(userId, key, patch, ip) {
    const m = getModel(userId, key); const p = { ...m.profile }; delete p.enabled;
    const str = (v, n = 1000) => typeof v === 'string' ? v.slice(0, n) : undefined; const sl = (v) => { v = Number(v); return Number.isFinite(v) ? Math.min(10, Math.max(0, v)) : undefined; };
    for (const k of ['strengths', 'weaknesses', 'bestFor', 'avoidFor', 'notes']) if (patch[k] !== undefined) { const v = str(patch[k]); if (v !== undefined) p[k] = v; }
    if (patch.role !== undefined && ROLES.includes(patch.role)) p.role = patch.role;
    if (Array.isArray(patch.tasks)) p.tasks = patch.tasks.filter((t) => typeof t === 'string').map((t) => t.trim().slice(0, 40)).filter(Boolean).slice(0, 12);
    for (const k of ['reasoning', 'creativity', 'accuracy', 'speed', 'cost', 'trust']) if (patch[k] !== undefined) { const v = sl(patch[k]); if (v !== undefined) p[k] = v; }
    if (patch.flags && typeof patch.flags === 'object') { p.flags = {}; for (const k of ['preferred', 'backup', 'primary', 'reviewer', 'specialist']) if (patch.flags[k] === true) p.flags[k] = true; }
    if (patch.capabilityOverrides && typeof patch.capabilityOverrides === 'object') { p.capabilityOverrides = {}; for (const k of CAPS) if (patch.capabilityOverrides[k] === true) p.capabilityOverrides[k] = true; }
    db.run('UPDATE model_profiles SET json=? WHERE model_pk=?', JSON.stringify(p), key);
    if (patch.enabled !== undefined && !!patch.enabled !== m.profile.enabled) setEnabled(userId, key, !!patch.enabled, ip);
    audit(db, userId, 'settings_changed', { scope: 'model_profile', model: m.modelId }, ip);
    return getModel(userId, key);
  }

  /** Live signal from real traffic: keeps health honest between scheduled checks. */
  function recordLive(modelPk, state, err) {
    if (!modelPk) return;
    if (state === HEALTH.HEALTHY) return; // success is recorded in model_usage; do not overwrite measured health latency
    db.run('INSERT INTO model_health(model_pk,state,latency_ms,http_status,error,checked_at) VALUES(?,?,NULL,NULL,?,?) ON CONFLICT(model_pk) DO UPDATE SET state=excluded.state,error=excluded.error,checked_at=excluded.checked_at', modelPk, state, String(err || '').slice(0, 300), Date.now());
    const m = db.get('SELECT connection_id FROM ai_models WHERE id=?', modelPk); if (m) recomputeProviderHealth(m.connection_id);
  }
  /** Background TTL refresh: re-check ENABLED models (+never-checked) whose health is older than ttl. */
  async function refreshStale(ttlMs = cfg.healthTtlMs) {
    const rows = db.all(`SELECT DISTINCT c.id, c.user_id FROM connections c JOIN ai_models m ON m.connection_id=c.id JOIN model_profiles p ON p.model_pk=m.id LEFT JOIN model_health h ON h.model_pk=m.id
      WHERE c.status IN ('VALID','OFFLINE') AND p.enabled=1 AND (h.checked_at IS NULL OR h.checked_at < ?)`, Date.now() - ttlMs);
    for (const r of rows) { try { await testConnection(r.user_id, r.id, { onlyEnabled: true }); } catch { /* keep going */ } }
    return rows.length;
  }
  return { preview, previewHealth, save, list, getConnection, listModels, getModel, loadCandidates, testConnection, replaceKey, rename, remove, setEnabled, updateProfile, recordLive, refreshStale,
    credential, defFor, publicDef, DEFAULT_PROFILE, ROLES, pendingCount: () => pending.size, recomputeProviderHealth, connOf };
}
module.exports = { createConnections, ROLES, DEFAULT_PROFILE };
