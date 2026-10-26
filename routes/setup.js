// routes/setup.js — first-run admin creation.
//
// Active only while local_admins.json is empty or missing. Both GET and
// POST /setup short-circuit to /login the moment at least one local admin
// exists, so this route cannot be used to add additional admins after
// the initial setup.

// Who may run it: a browser on this machine (loopback), or anyone holding
// the one-time setup token printed to the console's terminal at start-up —
// so a console reachable on a network can't be claimed by whoever finds it
// first.

const express = require('express');
const crypto = require('crypto');
const { page, flash } = require('../views/layout');
const { hashPassword, getPasswordRules, validatePassword } = require('../middleware/auth');
const localAdmins = require('../helpers/localAdmins');

function isLoopback(ip) {
  const a = String(ip || '').replace(/^::ffff:/, '');
  return a === '127.0.0.1' || a === '::1' || a.startsWith('127.');
}

module.exports = function (appConfig) {
  const router = express.Router();
  const setupToken = crypto.randomBytes(16).toString('hex');
  if (localAdmins.count() === 0 && !localAdmins.fileError()) {
    const port = appConfig.port || 3005;
    console.log(`[setup] No admins yet. Create the first one at http://localhost:${port}/setup — or, from another machine, /setup?token=${setupToken}`);
  }
  const tokenOk = (t) => {
    const a = Buffer.from(String(t || '')), b = Buffer.from(setupToken);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  };
  const allowed = (req, t) => isLoopback(req.ip) || tokenOk(t);
  const refuse = (res) => res.status(403).send(page({ title: 'First-run setup', appConfig, user: null, body: `
      <div class="card surface-target card-pad w-full max-w-md mx-auto">
        <h1 class="text-xl font-bold text-slate-900 dark:text-slate-100">First-run setup</h1>
        <p class="mt-2 text-sm text-slate-600 dark:text-slate-300">Create the first admin from the machine the console runs on (http://localhost:…/setup), or open the setup link printed in the console's terminal when it started.</p>
      </div>` }));

  router.get('/setup', (req, res) => {
    if (localAdmins.count() > 0) return res.redirect('/login');
    if (!allowed(req, req.query.token)) return refuse(res);
    const tokenField = isLoopback(req.ip) ? '' : `<input type="hidden" name="setup_token" value="${String(req.query.token || '').replace(/[^a-f0-9]/g, '')}">`;
    const minLen = getPasswordRules(appConfig).minLength;
    const body = `
      <div class="card surface-target card-pad shadow-xl w-full max-w-md mx-auto">
        <h1 class="text-xl font-bold text-slate-900 dark:text-slate-100">Create the first admin</h1>
        <p class="mt-1 text-sm text-slate-500 dark:text-slate-400">No admin accounts are configured yet. Set one up to start using the console.</p>

        <div class="mt-5">${flash('error', req.query.error)}</div>

        <form method="POST" action="/setup" class="space-y-4">
          ${tokenField}
          <div>
            <label class="label" for="su-user">Username</label>
            <input id="su-user" class="input" type="text" name="username" required autocomplete="username" maxlength="100" pattern="[A-Za-z0-9._\\-]+" title="Letters, digits, dot, dash, underscore" autofocus>
          </div>
          <div>
            <label class="label" for="su-email">Email</label>
            <input id="su-email" class="input" type="email" name="email" required autocomplete="email" maxlength="255">
          </div>
          <div>
            <label class="label" for="su-name">Name</label>
            <input id="su-name" class="input" type="text" name="name" required autocomplete="name" maxlength="100">
          </div>
          <div>
            <label class="label" for="su-pw">Password</label>
            <input id="su-pw" class="input" type="password" name="password" required minlength="${minLen}" autocomplete="new-password">
          </div>
          <div>
            <label class="label" for="su-pw2">Confirm password</label>
            <input id="su-pw2" class="input" type="password" name="confirm_password" required minlength="${minLen}" autocomplete="new-password">
          </div>
          <button type="submit" class="btn-primary w-full">Create admin</button>
        </form>

        <p class="mt-6 text-xs text-slate-500 dark:text-slate-400">
          This admin is stored locally in <code class="font-mono">local_admins.json</code> (gitignored). It works even when the
          web app's database is unreachable — a deliberate break-glass capability. After setup
          you can manage admins from the running app.
        </p>
      </div>
    `;
    res.send(page({ title: 'First-run setup', body, appConfig, user: null }));
  });

  router.post('/setup', async (req, res) => {
    if (localAdmins.count() > 0) return res.redirect('/login');
    const tok = req.body.setup_token;
    if (!allowed(req, tok)) return refuse(res);
    const back = (msg) => res.redirect('/setup?' + (isLoopback(req.ip) ? '' : 'token=' + encodeURIComponent(String(tok || '')) + '&') + 'error=' + encodeURIComponent(msg));
    try {
      const username = (req.body.username || '').trim().toLowerCase();
      const email = (req.body.email || '').trim().toLowerCase();
      const name = (req.body.name || '').trim();
      const password = req.body.password || '';
      const confirm = req.body.confirm_password || '';
      const rules = getPasswordRules(appConfig);

      if (!username || !email || !name || !password) {
        return back('All fields are required');
      }
      if (!/^[A-Za-z0-9._-]+$/.test(username)) {
        return back('Username may only contain letters, digits, dot, dash, underscore');
      }
      const pwErr = validatePassword(password, rules);
      if (pwErr) {
        return back(pwErr);
      }
      if (password !== confirm) {
        return back('Passwords do not match');
      }

      const password_hash = await hashPassword(password);
      // Re-check after the (slow) hash: a second request racing this one
      // must not create a second "first" admin.
      if (localAdmins.count() > 0) return res.redirect('/login');
      localAdmins.upsert({ username, email, name, password_hash });
      console.log(`[setup] First admin created: ${username} (${email})`);
      res.redirect('/login');
    } catch (err) {
      console.error('[setup] failed:', err);
      back('Something went wrong. Please try again.');
    }
  });

  return router;
};
