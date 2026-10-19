// routes/public.js — sign-in + sign-out for the admin console.
//
// Admin auth is LOCAL FILE ONLY (local_admins.json on disk). The web app's
// database (mmoa_web_app's nonprofit accounts) is NOT
// consulted at login time — the admin console is an internal operator tool
// with only a handful of users, and going DB-down should never lock anyone
// out.

const express = require('express');
const { page, flash } = require('../views/layout');
const { verifyPassword } = require('../middleware/auth');
const localAdmins = require('../helpers/localAdmins');

module.exports = function (db, appConfig) {
  const router = express.Router();

  router.get('/login', (req, res) => {
    if (req.session && req.session.user) return res.redirect('/');
    const body = `
      <div class="card surface-target card-pad shadow-xl">
        ${flash('error', req.query.error)}
        <form method="POST" action="/login" class="space-y-4">
          <div>
            <label class="label" for="login-user">Login</label>
            <input id="login-user" class="input" type="text" name="username" required autocomplete="username" maxlength="100" autofocus>
          </div>
          <div>
            <label class="label" for="login-pw">Password</label>
            <input id="login-pw" class="input" type="password" name="password" required autocomplete="current-password">
          </div>
          <button type="submit" class="btn-primary w-full">Login</button>
        </form>
      </div>
    `;
    res.send(page({ title: null, body, appConfig, user: null, activeNav: 'login' }));
  });

  router.post('/login', async (req, res) => {
    const username = (req.body.username || '').trim().toLowerCase();
    const password = req.body.password || '';
    const generic = '/login?error=Invalid+login+or+password';

    // The auth rate limiter looks at req.loginFailed to decide whether
    // to count this request against the IP's failure budget.
    function fail(target) {
      req.loginFailed = true;
      return res.redirect(target);
    }

    if (!username || !password) return fail(generic);

    try {
      const local = localAdmins.findByUsername(username);
      if (!local) return fail(generic);
      const ok = await verifyPassword(password, local.password_hash);
      if (!ok) return fail(generic);

      req.session.user = {
        user_id: 'local:' + local.username,
        username: local.username,
        email: local.email || '',
        name: local.name || local.username,
        role: 'admin'
      };
      res.redirect('/');
    } catch (err) {
      console.error('[login] error:', err);
      return fail('/login?error=Something+went+wrong.+Please+try+again.');
    }
  });

  router.post('/logout', (req, res) => {
    req.session = null;
    res.redirect('/login');
  });

  return router;
};
