// middleware/auth.js — admin-only auth gates + password helpers.
//
// The admin console only serves its own operators (local_admins.json — see
// routes/public.js). Members in the web app's `users` table can NOT sign
// in here; every page is gated by
// requireAdmin, which only accepts the session written by the local login.

const bcrypt = require('bcrypt');

function requireAdmin(req, res, next) {
  if (req.session && req.session.user && req.session.user.role === 'admin') return next();
  res.redirect('/login');
}

// bcrypt cost factor 10 — same rationale as the other two apps.
async function hashPassword(password) {
  return bcrypt.hash(password, 10);
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
  getPasswordRules,
  validatePassword
};
