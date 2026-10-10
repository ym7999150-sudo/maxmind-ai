'use strict';
const { eligibility } = require('@maxmind-ai/router');
/**
 * Internal agents. Health is DERIVED from real state each time: capabilities + enabled healthy models + provider config.
 * READY / DEGRADED / OFFLINE — never animated or assumed.
 */
const AGENTS = [
  { id: 'planner', name: 'Planner', requires: {} }, { id: 'researcher', name: 'Research', requires: {} }, { id: 'coder', name: 'Coding', requires: {} },
  { id: 'vision', name: 'Vision', requires: { vision: true } }, { id: 'reasoning', name: 'Reasoning', requires: {} },
  { id: 'reviewer', name: 'Reviewer', requires: {}, wantsDistinct: true }, { id: 'synthesizer', name: 'Synthesizer', requires: {} }, { id: 'document', name: 'Document', requires: {} }
];
function agentHealth(candidates) {
  return AGENTS.map((a) => {
    const task = { requiredCaps: a.requires };
    const ok = candidates.filter((c) => eligibility(c, task).ok);
    let state = 'OFFLINE', detail = 'No enabled healthy model has the required capabilities.';
    if (!candidates.length) detail = 'No provider connected.';
    else if (ok.length) {
      const bad = ok.filter((c) => ['DEGRADED', 'RATE_LIMITED'].includes(c.providerHealth)).length;
      if (a.wantsDistinct && ok.length < 2) { state = 'DEGRADED'; detail = 'Only one eligible model: cannot cross-review with a different model.'; }
      else if (bad === ok.length) { state = 'DEGRADED'; detail = 'All capable models sit on degraded/rate-limited providers.'; }
      else { state = 'READY'; detail = `${ok.length} eligible model(s).`; }
    } else if (a.requires.vision) detail = 'No enabled healthy model with vision (provider-confirmed or user-declared).';
    return { id: a.id, name: a.name, state, detail, eligibleModels: ok.length, requires: Object.keys(a.requires) };
  });
}
function persistAgents(db, userId, list) {
  const now = Date.now();
  for (const a of AGENTS) db.run('INSERT OR IGNORE INTO agents(id,name,requires) VALUES(?,?,?)', a.id, a.name, JSON.stringify(a.requires));
  for (const h of list) db.run('INSERT INTO agent_health(user_id,agent_id,state,detail,checked_at) VALUES(?,?,?,?,?) ON CONFLICT(user_id,agent_id) DO UPDATE SET state=excluded.state,detail=excluded.detail,checked_at=excluded.checked_at', userId, h.id, h.state, h.detail, now);
}
module.exports = { AGENTS, agentHealth, persistAgents };
