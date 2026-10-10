'use strict';
const { redact } = require('@maxmind-ai/core');
/** Security-event log. Details are scrubbed; secrets must never be passed in, and are redacted defensively. */
function audit(db, userId, event, detail, ip) {
  try { db.run('INSERT INTO audit_log(user_id,event,detail,ip,created_at) VALUES(?,?,?,?,?)', userId || null, event, detail ? redact(JSON.stringify(detail)).slice(0, 1000) : null, ip || null, Date.now()); } catch { /* auditing must not break requests */ }
}
module.exports = { audit };
