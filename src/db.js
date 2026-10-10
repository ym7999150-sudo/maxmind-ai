'use strict';
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MIGRATIONS = [{ version: 1, name: 'initial', sql: `
CREATE TABLE users(id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, must_change_password INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, last_login_at INTEGER);
CREATE TABLE sessions(id_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, csrf TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, ip TEXT, ua TEXT);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE TABLE user_settings(user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, json TEXT NOT NULL DEFAULT '{}');
CREATE TABLE providers(id TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL, base_url TEXT NOT NULL, protocol TEXT NOT NULL, classification TEXT DEFAULT 'UNKNOWN', created_at INTEGER NOT NULL, PRIMARY KEY(user_id,id));
CREATE TABLE connections(id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, provider_id TEXT NOT NULL, name TEXT NOT NULL, key_mask TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'UNKNOWN', provider_health TEXT NOT NULL DEFAULT 'UNKNOWN', detection TEXT, last_error TEXT, created_at INTEGER NOT NULL, last_validated_at INTEGER, last_health_at INTEGER);
CREATE INDEX idx_conn_user ON connections(user_id);
CREATE TABLE provider_credentials(connection_id TEXT PRIMARY KEY REFERENCES connections(id) ON DELETE CASCADE, ciphertext TEXT NOT NULL, iv TEXT NOT NULL, tag TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1);
CREATE TABLE ai_models(id TEXT PRIMARY KEY, connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE, model_id TEXT NOT NULL, name TEXT, kind TEXT, kind_source TEXT, context_window INTEGER,
  input_modalities TEXT, output_modalities TEXT, pricing TEXT, discovered_at INTEGER NOT NULL, UNIQUE(connection_id, model_id));
CREATE INDEX idx_models_conn ON ai_models(connection_id);
CREATE TABLE model_capabilities(model_pk TEXT PRIMARY KEY REFERENCES ai_models(id) ON DELETE CASCADE, json TEXT NOT NULL);
CREATE TABLE model_health(model_pk TEXT PRIMARY KEY REFERENCES ai_models(id) ON DELETE CASCADE, state TEXT NOT NULL, latency_ms INTEGER, http_status INTEGER, error TEXT, checked_at INTEGER NOT NULL);
CREATE TABLE model_profiles(model_pk TEXT PRIMARY KEY REFERENCES ai_models(id) ON DELETE CASCADE, enabled INTEGER NOT NULL DEFAULT 0, json TEXT NOT NULL DEFAULT '{}');
CREATE TABLE agents(id TEXT PRIMARY KEY, name TEXT NOT NULL, requires TEXT NOT NULL);
CREATE TABLE agent_health(user_id TEXT NOT NULL, agent_id TEXT NOT NULL, state TEXT NOT NULL, detail TEXT, checked_at INTEGER NOT NULL, PRIMARY KEY(user_id, agent_id));
CREATE TABLE chats(id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, title TEXT NOT NULL, pinned INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0, summary TEXT NOT NULL DEFAULT '', summary_upto INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX idx_chats_user ON chats(user_id, updated_at);
CREATE TABLE messages(id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE, seq INTEGER NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, meta TEXT, created_at INTEGER NOT NULL);
CREATE INDEX idx_messages_chat ON messages(chat_id, seq);
CREATE TABLE attachments(id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, chat_id TEXT, message_id TEXT, name TEXT NOT NULL, mime TEXT NOT NULL, kind TEXT NOT NULL, size INTEGER NOT NULL, path TEXT NOT NULL, text_tokens INTEGER, created_at INTEGER NOT NULL);
CREATE TABLE memories(id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, content TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'user', created_at INTEGER NOT NULL);
CREATE TABLE token_usage(id TEXT PRIMARY KEY, user_id TEXT NOT NULL, chat_id TEXT, message_id TEXT, input_tokens INTEGER, output_tokens INTEGER, total_tokens INTEGER, est_cost REAL, cache_hit INTEGER NOT NULL DEFAULT 0, compression_pct INTEGER, team_calls INTEGER, models INTEGER, measured INTEGER NOT NULL, latency_ms INTEGER, created_at INTEGER NOT NULL);
CREATE INDEX idx_tu_user ON token_usage(user_id, created_at);
CREATE TABLE model_usage(id TEXT PRIMARY KEY, user_id TEXT NOT NULL, model_pk TEXT, connection_id TEXT, chat_id TEXT, role TEXT, status TEXT NOT NULL, latency_ms INTEGER, input_tokens INTEGER, output_tokens INTEGER, measured INTEGER, error TEXT, created_at INTEGER NOT NULL);
CREATE INDEX idx_mu_model ON model_usage(model_pk, created_at);
CREATE INDEX idx_mu_user ON model_usage(user_id, created_at);
CREATE TABLE routing_decisions(id TEXT PRIMARY KEY, user_id TEXT NOT NULL, chat_id TEXT, message_id TEXT, json TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE team_runs(id TEXT PRIMARY KEY, user_id TEXT NOT NULL, chat_id TEXT, message_id TEXT, strategy TEXT, steps TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE cache_entries(id TEXT PRIMARY KEY, user_id TEXT NOT NULL, signature TEXT NOT NULL, query TEXT NOT NULL, query_norm TEXT NOT NULL, answer TEXT NOT NULL, model_pks TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, hits INTEGER NOT NULL DEFAULT 0);
CREATE INDEX idx_cache_user ON cache_entries(user_id, signature);
CREATE TABLE audit_log(id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, event TEXT NOT NULL, detail TEXT, ip TEXT, created_at INTEGER NOT NULL);
CREATE INDEX idx_audit_user ON audit_log(user_id, created_at);
` }];

function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, name TEXT, applied_at INTEGER)');
  const done = new Set(db.prepare('SELECT version FROM schema_migrations').all().map((r) => r.version));
  for (const m of MIGRATIONS) if (!done.has(m.version)) {
    db.exec('BEGIN'); try { db.exec(m.sql); db.prepare('INSERT INTO schema_migrations VALUES(?,?,?)').run(m.version, m.name, Date.now()); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
  }
  const api = {
    raw: db,
    get: (sql, ...p) => db.prepare(sql).get(...p),
    all: (sql, ...p) => db.prepare(sql).all(...p),
    run: (sql, ...p) => db.prepare(sql).run(...p),
    tx(fn) { db.exec('BEGIN'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } },
    id: () => crypto.randomUUID(),
    close: () => db.close()
  };
  return api;
}
module.exports = { openDb, MIGRATIONS };
