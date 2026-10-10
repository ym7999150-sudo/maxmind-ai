'use strict';
const path = require('path');
const express = require('express');
const { Registry } = require('@maxmind-ai/providers');
const { openDb } = require('./db');
const { createVault } = require('./crypto');
const { createAuth } = require('./services/auth');
const { createConnections } = require('./services/connections');
const { createChats } = require('./services/chats');
const { createMemory } = require('./services/memory');
const { createFiles } = require('./services/files');
const { createEngine } = require('./services/engine');
const { createInsights } = require('./services/insights');
const { buildRoutes } = require('./routes');
const { errorHandler, limiter } = require('./http');

/** Composition root. Everything receives its dependencies from here (testable with an in-memory DB). */
function createApp(cfg) {
  const db = openDb(cfg.dbPath);
  const vault = createVault(cfg.encKey);
  const registry = new Registry({ mock: cfg.mock, configDir: path.join(cfg.root, 'config', 'providers') });
  const ctx = { cfg, db, vault, registry };
  ctx.auth = createAuth(ctx); ctx.auth.seedDefaultUser();
  ctx.connections = createConnections(ctx); ctx.chats = createChats(ctx); ctx.memory = createMemory(ctx); ctx.files = createFiles(ctx);
  ctx.engine = createEngine(ctx); ctx.insights = createInsights(ctx);

  const app = express();
  app.disable('x-powered-by'); app.set('trust proxy', cfg.isProd ? 1 : false);
  app.use((req, res, next) => {
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('X-Frame-Options', 'DENY'); res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('Permissions-Policy', 'microphone=(self), camera=()');
    if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use('/api', limiter({ windowMs: 60000, max: 600 }));
  app.use('/api', express.json({ limit: '1mb' }));
  app.use('/api', buildRoutes(ctx));
  app.use(express.static(path.join(cfg.root, 'public'), { index: 'index.html', maxAge: cfg.isProd ? '1h' : 0 }));
  app.get('*', (req, res) => res.sendFile(path.join(cfg.root, 'public', 'index.html')));
  app.use(errorHandler(cfg.isProd));
  let timer = null;
  const startBackground = () => { timer = setInterval(() => ctx.connections.refreshStale().catch(() => {}), 5 * 60000); timer.unref(); };
  return { app, ctx, startBackground, close: () => { if (timer) clearInterval(timer); db.close(); } };
}
module.exports = { createApp };
