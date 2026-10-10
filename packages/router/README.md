# @maxmind-ai/router
Task analysis (EN + AR), a hard eligibility gate (enabled + healthy + valid key + required capabilities), transparent weighted scoring (default weights: capability 30, preference 20, expertise 15, health 10, performance 10, cost 5, latency 5, history 5 — configurable) and plan building (single / primary+review / team) within user constraints. Never selects outside the eligible set; manual and team selections are never silently substituted.
```js
const R = require('@maxmind-ai/router');
const task = R.analyzeTask({ text: 'Compare these architectures' });
const { scored, excluded } = R.scoreCandidates(task, candidates);
const plan = R.buildPlan({ mode: 'auto', task, scored, excluded, settings: { maxTeamSize: 3 } });
```
