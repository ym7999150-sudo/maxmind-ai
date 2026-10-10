'use strict';
const { agentHealth, persistAgents } = require('./agents');
const J = (s, d = null) => { try { return s == null ? d : JSON.parse(s); } catch { return d; } };

/** Monitoring + AI Map data. Everything is read from real tables; nothing is simulated. */
function createInsights({ db, connections, cfg }) {
  function agents(userId) { const list = agentHealth(connections.loadCandidates(userId)); persistAgents(db, userId, list); return list; }

  function monitor(userId, days = 7) {
    const since = Date.now() - days * 86400000;
    const conns = connections.list(userId); const models = connections.listModels(userId);
    const hc = { HEALTHY: 0, DEGRADED: 0, RATE_LIMITED: 0, AUTH_FAILED: 0, UNAVAILABLE: 0, TIMEOUT: 0, UNKNOWN: 0 }; for (const m of models) hc[m.health.state] = (hc[m.health.state] || 0) + 1;
    const req = db.get('SELECT COUNT(*) n, SUM(input_tokens) i, SUM(output_tokens) o, SUM(total_tokens) t, SUM(est_cost) c, SUM(cache_hit) hits, AVG(latency_ms) lat, SUM(CASE WHEN measured=0 THEN 1 ELSE 0 END) est FROM token_usage WHERE user_id=? AND created_at>=?', userId, since);
    const calls = db.get(`SELECT COUNT(*) n, SUM(CASE WHEN status='OK' THEN 1 ELSE 0 END) ok, SUM(CASE WHEN status='RATE_LIMITED' THEN 1 ELSE 0 END) rl, SUM(CASE WHEN status NOT IN ('OK') THEN 1 ELSE 0 END) fail FROM model_usage WHERE user_id=? AND created_at>=? AND role<>'image'`, userId, since);
    const perModel = db.all(`SELECT u.model_pk k, COUNT(*) n, SUM(CASE WHEN status='OK' THEN 1 ELSE 0 END) ok, AVG(CASE WHEN status='OK' THEN latency_ms END) lat, SUM(COALESCE(input_tokens,0)) i, SUM(COALESCE(output_tokens,0)) o FROM model_usage u WHERE user_id=? AND created_at>=? AND model_pk IS NOT NULL GROUP BY model_pk ORDER BY n DESC LIMIT 30`, userId, since)
      .map((r) => { const m = models.find((x) => x.key === r.k); return { key: r.k, label: m ? `${m.providerName} · ${m.modelId}` : '(deleted model)', calls: r.n, success: r.ok, avgLatencyMs: r.lat ? Math.round(r.lat) : null, inputTokens: r.i, outputTokens: r.o }; });
    const errors = db.all(`SELECT u.created_at t, u.status, u.error, u.role, m.model_id FROM model_usage u LEFT JOIN ai_models m ON m.id=u.model_pk WHERE u.user_id=? AND u.status<>'OK' ORDER BY u.created_at DESC LIMIT 25`, userId);
    const daily = db.all(`SELECT strftime('%Y-%m-%d', created_at/1000, 'unixepoch') d, COUNT(*) n, SUM(total_tokens) t FROM token_usage WHERE user_id=? AND created_at>=? GROUP BY d ORDER BY d`, userId, since);
    return { windowDays: days, providers: conns.map((c) => ({ id: c.id, name: c.name, provider: c.provider.name, health: c.providerHealth, status: c.status, stats: c.stats, lastHealthAt: c.lastHealthAt })), modelHealth: hc, agents: agents(userId),
      requests: { total: req.n || 0, tokens: { input: req.i || 0, output: req.o || 0, total: req.t || 0 }, estimatedCost: req.c, costNote: 'Sum of requests whose model pricing is known; unknown pricing contributes nothing.', cacheHits: req.hits || 0, cacheHitRate: req.n ? +((req.hits || 0) / req.n).toFixed(3) : 0, avgLatencyMs: req.lat ? Math.round(req.lat) : null, estimatedTokenRequests: req.est || 0 },
      modelCalls: { total: calls.n || 0, ok: calls.ok || 0, failures: calls.fail || 0, rateLimited: calls.rl || 0 }, perModel, errors: errors.map((e) => ({ at: e.t, status: e.status, role: e.role, model: e.model_id, error: e.error })), daily, mockMode: cfg.mock };
  }

  function map(userId) {
    const conns = connections.list(userId); const models = connections.listModels(userId); const ags = agents(userId);
    const nodes = [], edges = [];
    const hasEnabled = models.some((m) => m.profile.enabled && m.health.state === 'HEALTHY');
    nodes.push({ id: 'core', type: 'core', label: 'MAXMIND AI', status: hasEnabled ? 'online' : 'idle' });
    const mem = db.get('SELECT COUNT(*) n FROM memories WHERE user_id=?', userId).n;
    nodes.push({ id: 'router', type: 'router', label: 'Router', status: hasEnabled ? 'online' : 'offline', detail: hasEnabled ? 'Routes across enabled healthy models' : 'No enabled healthy model' });
    nodes.push({ id: 'tokens', type: 'tokens', label: 'Token Engine', status: 'online', detail: 'Local; always available' });
    nodes.push({ id: 'memory', type: 'memory', label: 'Memory', status: mem ? 'online' : 'idle', detail: `${mem} item(s)` });
    nodes.push({ id: 'synth', type: 'agent', label: 'Synthesizer', status: ags.find((a) => a.id === 'synthesizer').state === 'OFFLINE' ? 'offline' : 'online' });
    edges.push({ from: 'core', to: 'router' }, { from: 'router', to: 'tokens' }, { from: 'router', to: 'memory' }, { from: 'router', to: 'synth' });
    for (const a of ags.filter((x) => x.id !== 'synthesizer')) { nodes.push({ id: 'agent:' + a.id, type: 'agent', label: a.name + ' Agent', status: a.state === 'READY' ? 'online' : a.state === 'DEGRADED' ? 'degraded' : 'offline', detail: a.detail }); edges.push({ from: 'router', to: 'agent:' + a.id }); }
    for (const c of conns) { const st = c.status !== 'VALID' ? 'offline' : ['HEALTHY', 'CONNECTED'].includes(c.providerHealth) ? 'online' : c.providerHealth === 'DEGRADED' || c.providerHealth === 'RATE_LIMITED' ? 'degraded' : 'offline';
      nodes.push({ id: 'prov:' + c.id, type: 'provider', label: c.name, status: st, detail: `${c.provider.name} · ${c.providerHealth}`, meta: { models: c.stats } }); edges.push({ from: 'core', to: 'prov:' + c.id }); }
    for (const m of models.slice(0, 150)) { const en = m.profile.enabled; const st = !en ? 'disabled' : m.health.state === 'HEALTHY' ? 'online' : m.health.state === 'DEGRADED' ? 'degraded' : 'offline';
      nodes.push({ id: 'model:' + m.key, type: 'model', label: m.modelId, status: st, detail: `${m.health.state}${en ? ' · enabled' : ' · disabled'}` }); edges.push({ from: 'prov:' + m.connectionId, to: 'model:' + m.key }); if (en) edges.push({ from: 'router', to: 'model:' + m.key, router: true }); }
    const last = db.get('SELECT json, created_at FROM routing_decisions WHERE user_id=? ORDER BY created_at DESC LIMIT 1', userId); const lj = last && J(last.json);
    return { nodes, edges, lastRoute: lj && lj.plan && lj.plan.steps ? { at: last.created_at, models: lj.plan.steps.map((s) => 'model:' + s.key) } : null, truncatedModels: Math.max(0, models.length - 150) };
  }
  const audit = (userId, limit = 100) => db.all('SELECT id,event,detail,ip,created_at FROM audit_log WHERE user_id=? ORDER BY id DESC LIMIT ?', userId, Math.min(500, limit)).map((r) => ({ id: r.id, event: r.event, detail: J(r.detail), ip: r.ip, at: r.created_at }));
  return { monitor, map, audit, agents };
}
module.exports = { createInsights };
