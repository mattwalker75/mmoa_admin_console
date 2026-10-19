#!/usr/bin/env node
// scripts/create-local-admin.js — add or replace a local-file admin.
//
// These admins live in local_admins.json on disk (gitignored) and are
// the "break glass" credentials that let an operator sign in when the
// web app's database is down.
//
// Usage:   node scripts/create-local-admin.js <username> <email> '<name>' '<password>'
// Idempotent: re-running with the same username replaces the existing entry.

const { appConfig } = require('../config/appConfig');
const { hashPassword, getPasswordRules, validatePassword } = require('../middleware/auth');
const localAdmins = require('../helpers/localAdmins');

async function main() {
  const [, , usernameRaw, emailRaw, nameRaw, passwordRaw] = process.argv;
  if (!usernameRaw || !emailRaw || !nameRaw || !passwordRaw) {
    console.error('Usage: node scripts/create-local-admin.js <username> <email> <name> <password>');
    process.exit(1);
  }
  const username = usernameRaw.trim().toLowerCase();
  if (!/^[A-Za-z0-9._-]+$/.test(username)) {
    console.error('Username may only contain letters, digits, dot, dash, underscore.');
    process.exit(1);
  }
  const email = emailRaw.trim().toLowerCase();
  const name = nameRaw.trim();
  const password = passwordRaw;
  const pwErr = validatePassword(password, getPasswordRules(appConfig));
  if (pwErr) {
    console.error(pwErr + '.');
    process.exit(1);
  }

  const password_hash = await hashPassword(password);
  const before = localAdmins.findByUsername(username);
  localAdmins.upsert({ username, email, name, password_hash });
  console.log(`${before ? 'Updated' : 'Created'} local admin: ${username} (${email})`);
  console.log(`File: ${localAdmins.filePath}`);
  console.log(`Total local admins: ${localAdmins.count()}`);
}

main().catch(err => {
  console.error('[create-local-admin] failed:', err);
  process.exit(1);
});
