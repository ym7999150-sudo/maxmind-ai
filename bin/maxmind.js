#!/usr/bin/env node
'use strict';
// MAXMIND AI launcher: creates .env if missing, starts the server, opens the browser.
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const port = process.env.PORT || 3000;
const url = `http://localhost:${port}`;

// 1) first run: generate .env (it never overwrites an existing one)
spawnSync(process.execPath, [path.join(root, 'scripts', 'ensure-env.js')], { cwd: root, stdio: 'inherit' });

// 2) start the server
const server = spawn(process.execPath, [path.join(root, 'server.js')], { cwd: root, stdio: 'inherit' });
server.on('exit', (code) => process.exit(code || 0));
process.on('SIGINT', () => { server.kill(); process.exit(0); });

// 3) open the browser once the server answers
function openBrowser() {
  const p = process.platform;
  if (p === 'win32') spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', detached: true }).unref();
  else spawn(p === 'darwin' ? 'open' : 'xdg-open', [url], { stdio: 'ignore', detached: true }).unref();
}
let tries = 0;
(function wait() {
  const req = http.get(url, (res) => { res.resume(); openBrowser(); });
  req.on('error', () => { if (++tries < 40) setTimeout(wait, 500); });
})();
