'use strict';
const { MaxMindError } = require('@maxmind-ai/core');
const J = (s, d = null) => { try { return s == null ? d : JSON.parse(s); } catch { return d; } };

function createChats({ db }) {
  const own = (userId, id) => { const c = db.get('SELECT * FROM chats WHERE id=? AND user_id=?', id, userId); if (!c) throw new MaxMindError('NOT_FOUND', 'Chat not found.', { status: 404 }); return c; };
  const pub = (c) => ({ id: c.id, title: c.title, pinned: !!c.pinned, archived: !!c.archived, createdAt: c.created_at, updatedAt: c.updated_at });
  const msg = (m) => ({ id: m.id, seq: m.seq, role: m.role, content: m.content, meta: J(m.meta, {}), createdAt: m.created_at });
  return {
    own,
    create(userId, title = 'New chat') { const id = db.id(); const now = Date.now(); db.run('INSERT INTO chats(id,user_id,title,created_at,updated_at) VALUES(?,?,?,?,?)', id, userId, String(title).slice(0, 120), now, now); return pub(own(userId, id)); },
    list(userId, { q = '', archived = false } = {}) {
      const like = `%${String(q).replace(/[%_\\]/g, (m) => '\\' + m)}%`;
      const rows = q
        ? db.all(`SELECT DISTINCT c.* FROM chats c LEFT JOIN messages m ON m.chat_id=c.id WHERE c.user_id=? AND c.archived=? AND (c.title LIKE ? ESCAPE '\\' OR m.content LIKE ? ESCAPE '\\') ORDER BY c.pinned DESC, c.updated_at DESC LIMIT 200`, userId, archived ? 1 : 0, like, like)
        : db.all('SELECT * FROM chats WHERE user_id=? AND archived=? ORDER BY pinned DESC, updated_at DESC LIMIT 500', userId, archived ? 1 : 0);
      return rows.map(pub);
    },
    get(userId, id, { limit = 500, before = null } = {}) {
      const c = own(userId, id);
      const rows = before ? db.all('SELECT * FROM messages WHERE chat_id=? AND seq<? ORDER BY seq DESC LIMIT ?', id, before, limit).reverse() : db.all('SELECT * FROM (SELECT * FROM messages WHERE chat_id=? ORDER BY seq DESC LIMIT ?) ORDER BY seq', id, limit);
      return { ...pub(c), messages: rows.map(msg) };
    },
    update(userId, id, patch) {
      own(userId, id);
      if (typeof patch.title === 'string') db.run('UPDATE chats SET title=? WHERE id=?', patch.title.trim().slice(0, 120) || 'Untitled', id);
      if (typeof patch.pinned === 'boolean') db.run('UPDATE chats SET pinned=? WHERE id=?', patch.pinned ? 1 : 0, id);
      if (typeof patch.archived === 'boolean') db.run('UPDATE chats SET archived=? WHERE id=?', patch.archived ? 1 : 0, id);
      return pub(own(userId, id));
    },
    remove(userId, id) { own(userId, id); db.run('DELETE FROM chats WHERE id=?', id); return { ok: true }; },
    export(userId, id, format = 'markdown') {
      const c = this.get(userId, id, { limit: 5000 });
      if (format === 'json') return { type: 'application/json', name: `${slug(c.title)}.json`, body: JSON.stringify({ title: c.title, exportedAt: new Date().toISOString(), messages: c.messages.map((m) => ({ role: m.role, content: m.content, at: new Date(m.createdAt).toISOString() })) }, null, 2) };
      return { type: 'text/markdown; charset=utf-8', name: `${slug(c.title)}.md`, body: `# ${c.title}\n\n` + c.messages.map((m) => `**${m.role === 'user' ? 'You' : 'MAXMIND AI'}**\n\n${m.content}\n`).join('\n---\n\n') };
    }
  };
}
const slug = (s) => String(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 50) || 'chat';
module.exports = { createChats };
