'use strict';
/** Creates .env with fresh random secrets on first run. Never overwrites an existing .env. */
const fs = require('fs'); const path = require('path'); const crypto = require('crypto');
const file = path.join(__dirname, '..', '.env');
if (fs.existsSync(file)) { console.log('.env already exists — left untouched.'); process.exit(0); }
const ex = fs.readFileSync(path.join(__dirname, '..', '.env.example'), 'utf8')
  .replace(/^ENCRYPTION_KEY=.*$/m, 'ENCRYPTION_KEY=' + crypto.randomBytes(32).toString('base64'))
  .replace(/^AUTH_SECRET=.*$/m, 'AUTH_SECRET=' + crypto.randomBytes(48).toString('base64url'));
fs.writeFileSync(file, ex, { mode: 0o600 });
console.log('Created .env with newly generated ENCRYPTION_KEY and AUTH_SECRET. Back them up: losing ENCRYPTION_KEY makes saved API keys unrecoverable.');
