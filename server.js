'use strict';
const { loadEnv } = require('./src/env');
let cfg;
try { cfg = loadEnv(); } catch (e) { console.error('\n[MAXMIND AI] ' + e.message + '\n'); process.exit(1); }
const { createApp } = require('./src/app');
const { app, startBackground } = createApp(cfg);
startBackground();
app.listen(cfg.port, () => {
  console.log(`MAXMIND AI listening on http://localhost:${cfg.port}`);
  if (cfg.mock) console.log('*** DEVELOPMENT / MOCK MODE: the MOCK provider is enabled. Responses from it are NOT real. ***');
  console.log('First login: user "admin", initial password "MaxMind AI 2026" (you will be forced to change it).');
});
