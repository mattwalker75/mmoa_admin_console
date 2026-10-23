// routes/profile.js — the signed-in admin's "edit my own account" page.
//
//   GET  /profile           → form (account details + change password)
//   POST /profile           → update name / email
//   POST /profile/password  → change password (requires current password)
//
// Edits the local-file admin record matched by req.session.user.username.
// Username is read-only here — to rename, use the Admins page or edit
// local_admins.json directly.

const express = require('express');
const { page, flash } = require('../views/layout');
const { escapeHtml } = require('../views/escapeHtml');
const {
  requireAdmin, hashPassword, verifyPassword, sessionFingerprint,
  getPasswordRules, validatePassword
} = require('../middleware/auth');
const localAdmins = require('../helpers/localAdmins');

module.exports = function (appConfig) {
  const router = express.Router();

  router.get('/profile', requireAdmin, (req, res) => {
    const user = req.session.user;
    const me = localAdmins.findByUsername(user.username);
    if (!me) {
      return res.redirect('/login?error=Account+not+found');
    }
    const rules = getPasswordRules(appConfig);

    const body = `
      <header class="mb-8">
        <h1 class="text-2xl font-bold text-slate-900 dark:text-slate-100">My profile</h1>
        <p class="mt-1 text-sm text-slate-500 dark:text-slate-400">Update your name, email, or password. Username can't be changed here — manage that under Admins.</p>
      </header>

      ${flash('error', req.query.error)}
      ${flash('success', req.query.msg)}

      <div class="grid lg:grid-cols-2 gap-6 max-w-5xl">

        <!-- Account details -->
        <section class="card surface-target card-pad space-y-4">
          <div>
            <h2 class="text-base font-semibold text-slate-900 dark:text-slate-100">Account details</h2>
            <p class="mt-0.5 text-xs text-slate-500 dark:text-slate-400">Your display name and contact email for this console.</p>
          </div>

          <form method="POST" action="/profile" class="space-y-4">
            <div>
              <label class="label">Username</label>
              <input class="input" type="text" value="${escapeHtml(me.username)}" disabled readonly>
              <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">Used to sign in. Not editable here.</p>
            </div>
            <div>
              <label class="label" for="pf-name">Name</label>
              <input id="pf-name" class="input" type="text" name="name" required autocomplete="name" maxlength="100" value="${escapeHtml(me.name || '')}">
            </div>
            <div>
              <label class="label" for="pf-email">Email</label>
              <input id="pf-email" class="input" type="email" name="email" required autocomplete="email" maxlength="255" value="${escapeHtml(me.email || '')}">
            </div>
            <div class="flex justify-end">
              <button type="submit" class="btn-primary">Save changes</button>
            </div>
          </form>
        </section>

        <!-- Change password -->
        <section class="card surface-target card-pad space-y-4">
          <div>
            <h2 class="text-base font-semibold text-slate-900 dark:text-slate-100">Change password</h2>
            <p class="mt-0.5 text-xs text-slate-500 dark:text-slate-400">Verify your current password, then set a new one that satisfies the configured complexity rules.</p>
          </div>

          <form method="POST" action="/profile/password" class="space-y-4"
                x-data="{ showCur: false, showNew: false, pw: '', pw2: '' }">
            <div>
              <label class="label" for="pf-cur">Current password</label>
              <div class="flex items-stretch gap-2">
                <input id="pf-cur" class="input flex-1" :type="showCur ? 'text' : 'password'" type="password" name="current_password" required autocomplete="current-password">
                <button type="button" class="btn-secondary text-xs px-3" x-on:click="showCur = !showCur" x-text="showCur ? 'Hide' : 'Show'"
                        aria-controls="pf-cur" title="Show or hide the current password"></button>
              </div>
            </div>
            <div>
              <label class="label" for="pf-new">New password</label>
              <div class="flex items-stretch gap-2">
                <input id="pf-new" class="input flex-1" :type="showNew ? 'text' : 'password'" type="password" name="new_password" required minlength="${rules.minLength}" autocomplete="new-password" x-model="pw">
                <button type="button" class="btn-secondary text-xs px-3" x-on:click="showNew = !showNew" x-text="showNew ? 'Hide' : 'Show'"
                        aria-controls="pf-new pf-conf" title="Show or hide both new-password fields"></button>
              </div>
              <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">${escapeHtml(rulesHint(rules))}</p>
            </div>
            <div>
              <label class="label" for="pf-conf">Confirm new password</label>
              <input id="pf-conf" class="input" :type="showNew ? 'text' : 'password'" type="password" name="confirm_password" required minlength="${rules.minLength}" autocomplete="new-password" x-model="pw2">
              <p class="mt-1 text-xs text-red-600 dark:text-red-300" x-show="pw && pw2 && pw !== pw2" x-cloak>Passwords do not match</p>
            </div>
            <div class="flex justify-end">
              <button type="submit" class="btn-primary">Update password</button>
            </div>
          </form>
        </section>

      </div>
    `;
    res.send(page({ title: 'My profile', body, appConfig, user, activeNav: 'profile' }));
  });

  router.post('/profile', requireAdmin, (req, res) => {
    try {
      const sessionUser = req.session.user;
      const name = (req.body.name || '').trim();
      const email = (req.body.email || '').trim().toLowerCase();
      if (!name) return res.redirect('/profile?error=Name+is+required');
      if (!email) return res.redirect('/profile?error=Email+is+required');

      const saved = localAdmins.update(sessionUser.username, { name, email });
      if (!saved) return res.redirect('/login?error=Account+not+found');

      // Keep the session's user object in sync so the sidebar and other
      // chrome show the new name/email without requiring a re-login.
      req.session.user = Object.assign({}, sessionUser, {
        name: saved.name || saved.username,
        email: saved.email || ''
      });
      res.redirect('/profile?msg=Profile+saved.');
    } catch (err) {
      console.error('[profile] update failed:', err);
      res.redirect('/profile?error=Save+failed');
    }
  });

  router.post('/profile/password', requireAdmin, async (req, res) => {
    try {
      const sessionUser = req.session.user;
      const cur = req.body.current_password || '';
      const next = req.body.new_password || '';
      const conf = req.body.confirm_password || '';
      const rules = getPasswordRules(appConfig);

      if (!cur || !next || !conf) {
        return res.redirect('/profile?error=All+password+fields+are+required');
      }
      if (next !== conf) {
        return res.redirect('/profile?error=New+passwords+do+not+match');
      }
      const pwErr = validatePassword(next, rules);
      if (pwErr) {
        return res.redirect('/profile?error=' + encodeURIComponent(pwErr));
      }

      const me = localAdmins.findByUsername(sessionUser.username);
      if (!me) return res.redirect('/login?error=Account+not+found');

      const ok = await verifyPassword(cur, me.password_hash);
      if (!ok) return res.redirect('/profile?error=Current+password+is+incorrect');

      const password_hash = await hashPassword(next);
      localAdmins.update(sessionUser.username, { password_hash });
      // requireAdmin compares the session's fingerprint with the stored
      // hash on every request; refresh it so THIS session survives the
      // change (every other session for this admin is ended).
      req.session.fp = sessionFingerprint(password_hash);
      res.redirect('/profile?msg=Password+updated.');
    } catch (err) {
      console.error('[profile] password change failed:', err);
      res.redirect('/profile?error=Update+failed');
    }
  });

  return router;
};

// Human-readable description of the active password rules, e.g.
// "Min 12 chars · 1 uppercase · 1 digit".
function rulesHint(rules) {
  const parts = [`Min ${rules.minLength} chars`];
  if (rules.requireUpper) parts.push('1 uppercase');
  if (rules.requireLower) parts.push('1 lowercase');
  if (rules.requireDigit) parts.push('1 digit');
  if (rules.requireSymbol) parts.push('1 special character');
  return parts.join(' · ');
}
