// helpers/localAdmins.js — local-file backed admin credentials.
//
// Reads `local_admins.json` from the repo root. The file is intentionally
// outside the database so the admin console can start up and an operator
// can sign in even when the shared database is unreachable — a "break
// glass" / "DB is on fire and I need to investigate" capability.
//
// File format (the file is gitignored — it contains password hashes):
//   [
//     { "username": "matt", "email": "admin@example.org", "name": "Matt", "password_hash": "$2b$10$..." }
//   ]
//
// Login lookups are case-insensitive on username. Email is informational
// only. Writes preserve hash strings as-is.

const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, '..', 'local_admins.json');

function loadAll() {
  if (!fs.existsSync(filePath)) return [];
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      console.warn('[localAdmins] local_admins.json is not an array — ignoring');
      return [];
    }
    return parsed.filter(e => e && typeof e.username === 'string' && typeof e.password_hash === 'string');
  } catch (err) {
    console.warn('[localAdmins] failed to parse local_admins.json:', err.message);
    return [];
  }
}

function findByUsername(username) {
  if (!username) return null;
  const needle = username.trim().toLowerCase();
  return loadAll().find(e => e.username.trim().toLowerCase() === needle) || null;
}

function findByEmail(email) {
  if (!email) return null;
  const needle = email.trim().toLowerCase();
  return loadAll().find(e => (e.email || '').trim().toLowerCase() === needle) || null;
}

function saveAll(admins) {
  // Atomic write (temp + rename) so a crash / full disk mid-write can't
  // truncate the sole break-glass credential file. Create the temp at 0600
  // from the start (not chmod-after-write) so the hashes are never briefly
  // world-readable.
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(admins, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, filePath);
  // 0600 — owner-only read/write. Contains bcrypt hashes; lock it down.
  try { fs.chmodSync(filePath, 0o600); } catch (e) { /* best effort */ }
}

// Add or replace an entry by username. Returns the saved record.
function upsert({ username, email, name, password_hash }) {
  if (!username || !password_hash) throw new Error('username and password_hash are required');
  const userLower = username.trim().toLowerCase();
  const all = loadAll();
  const idx = all.findIndex(e => e.username.trim().toLowerCase() === userLower);
  const record = {
    username: userLower,
    email: (email || '').trim().toLowerCase(),
    name: (name || '').trim(),
    password_hash
  };
  if (idx >= 0) all[idx] = record;
  else all.push(record);
  saveAll(all);
  return record;
}

// Partial update of an existing entry, looked up by username (immutable
// here — to rename a user, edit local_admins.json by hand or remove +
// re-add via /admins). `partial` may include any of:
//   email, name, password_hash
// Fields not provided in `partial` are preserved. Returns the saved
// record, or null if the username isn't found.
function update(username, partial) {
  const userLower = (username || '').trim().toLowerCase();
  if (!userLower) return null;
  const all = loadAll();
  const idx = all.findIndex(e => e.username.trim().toLowerCase() === userLower);
  if (idx < 0) return null;
  const existing = all[idx];
  const next = {
    username: existing.username,
    email: partial.email !== undefined ? (partial.email || '').trim().toLowerCase() : (existing.email || ''),
    name: partial.name !== undefined ? (partial.name || '').trim() : (existing.name || ''),
    password_hash: partial.password_hash || existing.password_hash
  };
  all[idx] = next;
  saveAll(all);
  return next;
}

function remove(username) {
  const lower = (username || '').trim().toLowerCase();
  const all = loadAll();
  const next = all.filter(e => e.username.trim().toLowerCase() !== lower);
  if (next.length === all.length) return false;
  saveAll(next);
  return true;
}

function count() {
  return loadAll().length;
}

// True when the credential file EXISTS but can't be read as a valid admin
// array (corrupt/truncated JSON, or not an array). The first-run setup gate
// must treat this as "locked" — an operator exists but the file is damaged —
// NOT as "zero admins", which would silently re-open unauthenticated /setup
// and let anyone mint a new admin. Fails safe: any doubt ⇒ report an error.
function fileError() {
  if (!fs.existsSync(filePath)) return false; // genuinely absent → first-run
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return !Array.isArray(parsed);
  } catch (e) {
    return true;
  }
}

module.exports = { loadAll, findByUsername, findByEmail, upsert, update, remove, count, fileError, filePath };
