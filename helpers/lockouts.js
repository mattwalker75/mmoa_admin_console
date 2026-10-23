// helpers/lockouts.js — admin ("manual") login locks on nonprofit accounts.
//
// The web app's login gate (middleware/loginLockout.js there) blocks a login
// while an 'account' row in login_lockouts has locked_until_ms in the
// future. An admin lock is such a row with MANUAL_LOCK_MS — a far-future
// sentinel (9999-12-31T23:59:59Z) the web app recognises and answers with
// "locked by MMoA" instead of a retry countdown. It never lapses: only
// deleting the row (unlockAccount here, or Locked Users → Unlock) ends it.
//
// A nonprofit can sign in with its login name OR its email, and the web app
// keys the account axis by whatever was typed (lower-cased), so a lock
// covers both keys and an unlock clears both.
//
// Remote-SQLite friendly: no reads inside a transaction — plain statements.

'use strict';

const kit = require('./pageKit');

const MANUAL_LOCK_MS = 253402300799000;

const isManual = (ms) => ms != null && Number(ms) >= MANUAL_LOCK_MS;

function keysOf(user) {
  return [...new Set([user.login_name, user.email].filter(Boolean).map(k => String(k).trim().toLowerCase()))];
}

async function lockAccount(db, user) {
  const now = kit.sqlTime();
  for (const key of keysOf(user)) {
    const r = await db.runAsync(
      'UPDATE login_lockouts SET locked_until_ms = ?, fail_count = 0, updated_at = ? WHERE scope = ? AND scope_key = ?',
      [MANUAL_LOCK_MS, now, 'account', key]);
    if (!r.changes) {
      try {
        await db.runAsync(
          'INSERT INTO login_lockouts (scope, scope_key, fail_count, locked_until_ms, updated_at) VALUES (?, ?, 0, ?, ?)',
          ['account', key, MANUAL_LOCK_MS, now]);
      } catch (e) { // lost a race with the web app's own upsert — update again
        await db.runAsync(
          'UPDATE login_lockouts SET locked_until_ms = ?, fail_count = 0, updated_at = ? WHERE scope = ? AND scope_key = ?',
          [MANUAL_LOCK_MS, now, 'account', key]);
      }
    }
  }
}

// Clears every 'account' lock for this user — manual or automatic.
async function unlockAccount(db, user) {
  let n = 0;
  for (const key of keysOf(user)) {
    const r = await db.runAsync('DELETE FROM login_lockouts WHERE scope = ? AND LOWER(scope_key) = ?', ['account', key]);
    n += r.changes || 0;
  }
  return n;
}

module.exports = { MANUAL_LOCK_MS, isManual, keysOf, lockAccount, unlockAccount };
