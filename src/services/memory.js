'use strict';
const { MaxMindError } = require('@maxmind-ai/core');
function createMemory({ db }) {
  const pub = (r) => ({ id: r.id, content: r.content, source: r.source, createdAt: r.created_at });
  return {
    list: (userId) => db.all('SELECT * FROM memories WHERE user_id=? ORDER BY created_at DESC LIMIT 200', userId).map(pub),
    recent: (userId, n = 15) => db.all('SELECT content FROM memories WHERE user_id=? ORDER BY created_at DESC LIMIT ?', userId, n).map((r) => r.content),
    add(userId, content, source = 'user') {
      content = String(content || '').trim().slice(0, 500); if (!content) throw new MaxMindError('EMPTY', 'Memory cannot be empty.', { status: 400 });
      if (db.get('SELECT COUNT(*) n FROM memories WHERE user_id=?', userId).n >= 200) throw new MaxMindError('LIMIT', 'Memory limit (200) reached.', { status: 400 });
      const id = db.id(); db.run('INSERT INTO memories(id,user_id,content,source,created_at) VALUES(?,?,?,?,?)', id, userId, content, source, Date.now()); return pub(db.get('SELECT * FROM memories WHERE id=?', id));
    },
    update(userId, id, content) { const r = db.run('UPDATE memories SET content=? WHERE id=? AND user_id=?', String(content).trim().slice(0, 500), id, userId); if (!r.changes) throw new MaxMindError('NOT_FOUND', 'Not found', { status: 404 }); return pub(db.get('SELECT * FROM memories WHERE id=?', id)); },
    remove(userId, id) { const r = db.run('DELETE FROM memories WHERE id=? AND user_id=?', id, userId); if (!r.changes) throw new MaxMindError('NOT_FOUND', 'Not found', { status: 404 }); return { ok: true }; },
    clear: (userId) => { db.run('DELETE FROM memories WHERE user_id=?', userId); return { ok: true }; }
  };
}
module.exports = { createMemory };
