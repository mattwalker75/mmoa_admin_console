// middleware/auth.js — admin-only auth gates + password helpers.
//
// The admin console only serves its own operators (local_admins.json — see
// routes/public.js). Nonprofit accounts in the web app's `users` table can NOT sign
// in here; every page is gated by
// requireAdmin, which only accepts the session written by the local login
// AND re-checks it against local_admins.json on every request (see
// sessionProblem below) — removing an admin or changing a password ends
// that admin's existing sessions immediately.

const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { appConfig } = require('../config/appConfig');
const localAdmins = require('../helpers/localAdmins');

// bcrypt cost factor 10 — same rationale as the other two apps.
const BCRYPT_COST = 10;

// A throwaway hash the login route compares against when the username is
// unknown, so a bad username costs the same bcrypt time as a bad password
// and response timing can't be used to enumerate admin usernames. Made at
// boot with the same cost factor as real hashes; the value never matters.
const DUMMY_HASH = bcrypt.hashSync('dummy-' + crypto.randomBytes(16).toString('hex'), BCRYPT_COST);

// Short fingerprint of an admin's password hash, stored in the session at
// login (req.session.fp). requireAdmin compares it on every request, so a
// cookie minted before the password was changed / the admin was replaced
// stops working — the cookie itself is signed-only and has no server-side
// store to revoke. 16 hex chars of sha256 is plenty to detect a change and
// reveals nothing about the hash.
function sessionFingerprint(password_hash) {
  return crypto.createHash('sha256').update(String(password_hash || '')).digest('hex').slice(0, 16);
}

// Why an otherwise well-formed admin session must NOT be honoured, or null
// if it is still good. Re-reads local_admins.json (a small synchronous file
// read — the first-run setup gate already does the same per request):
//   removed — the admin is no longer in local_admins.json
//   changed — the password hash differs from the one the session was
//             minted against (password changed, or the admin re-added)
//   expired — older than sessionMaxAgeHours, regardless of the cookie's own
//             maxAge (which the browser enforces, and a client can ignore)
//   stale   — a session from before iat / fp were recorded
function sessionProblem(session) {
  const u = session && session.user;
  if (!u || typeof u.username !== 'string') return 'removed';
  if (!Number.isFinite(session.iat) || typeof session.fp !== 'string') return 'stale';
  const maxAgeMs = (appConfig.sessionMaxAgeHours || 8) * 60 * 60 * 1000;
  if (Date.now() - session.iat > maxAgeMs || session.iat > Date.now() + 60 * 1000) return 'expired';
  const local = localAdmins.findByUsername(u.username);
  if (!local) return 'removed';
  if (sessionFingerprint(local.password_hash) !== session.fp) return 'changed';
  return null;
}

const SESSION_PROBLEM_MESSAGES = {
  expired: 'Your session has expired. Please sign in again.',
  removed: 'This admin account no longer exists.',
  changed: 'The password for this account was changed. Please sign in again.',
  stale: 'Please sign in again.'
};

function requireAdmin(req, res, next) {
  if (!(req.session && req.session.user && req.session.user.role === 'admin')) return res.redirect('/login');
  const problem = sessionProblem(req.session);
  if (!problem) return next();
  console.warn(`[auth] session for "${req.session.user.username}" rejected: ${problem}`);
  req.session = null; // clears the cookie on this response
  res.redirect('/login?error=' + encodeURIComponent(SESSION_PROBLEM_MESSAGES[problem] || SESSION_PROBLEM_MESSAGES.stale));
}

async function hashPassword(password) {
  return bcrypt.hash(password, BCRYPT_COST);
}

async function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash);
}

// Read the current password rules from appConfig, falling back to safe
// defaults if the security.password block is missing or malformed.
// Top-level `passwordMinLength` is honored as a fallback for older configs
// written before the security.password block existed.
function getPasswordRules(appConfig) {
  const pw = (appConfig && appConfig.security && appConfig.security.password) || {};
  const explicit = Number.isInteger(pw.minLength) && pw.minLength > 0 ? pw.minLength : null;
  const legacy = Number.isInteger(appConfig && appConfig.passwordMinLength) && appConfig.passwordMinLength > 0
    ? appConfig.passwordMinLength
    : null;
  return {
    minLength: explicit || legacy || 8,
    requireUpper: !!pw.requireUpper,
    requireLower: !!pw.requireLower,
    requireDigit: !!pw.requireDigit,
    requireSymbol: !!pw.requireSymbol
  };
}

// Returns null if the password satisfies the rules, otherwise a
// human-readable error string describing the first failing rule.
function validatePassword(password, rules) {
  const r = rules || { minLength: 8 };
  if (typeof password !== 'string' || password.length < r.minLength) {
    return `Password must be at least ${r.minLength} characters`;
  }
  if (r.requireUpper && !/[A-Z]/.test(password)) return 'Password must contain at least one uppercase letter';
  if (r.requireLower && !/[a-z]/.test(password)) return 'Password must contain at least one lowercase letter';
  if (r.requireDigit && !/[0-9]/.test(password)) return 'Password must contain at least one digit';
  if (r.requireSymbol && !/[^A-Za-z0-9]/.test(password)) return 'Password must contain at least one special character';
  return null;
}

module.exports = {
  requireAdmin,
  hashPassword,
  verifyPassword,
  sessionFingerprint,
  sessionProblem,
  DUMMY_HASH,
  getPasswordRules,
  validatePassword
};
