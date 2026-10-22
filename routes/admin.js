// routes/admin.js — admin-only pages.
//   GET  /              → dashboard / system overview
//   GET  /admins        → list / add / remove LOCAL admins (local_admins.json)
//   POST /admins        → add or update a local admin
//   POST /admins/delete → remove a local admin by username
//
// Ported from car_show_admin_console/routes/admin.js (dashboard + admins
// sections). Nonprofit accounts live in routes/nonprofits.js; the car-show
// Deployments section, reaper and cleanup sweeper are gone.
//
// Every DB query is wrapped in safeGet / safeAll so a logged-in operator
// can still navigate the UI when the web app's database is unreachable —
// pages render with empty data + a "Database unavailable" banner.

const express = require('express');
const { page, flash } = require('../views/layout');
const { escapeHtml } = require('../views/escapeHtml');
const { requireAdmin, hashPassword, getPasswordRules, validatePassword } = require('../middleware/auth');
const localAdmins = require('../helpers/localAdmins');

function dbBanner(err) {
  if (!err) return '';
  return `<div class="flash-error mb-6">
    <strong class="font-semibold">Database unavailable.</strong>
    ${escapeHtml(err.message || 'unknown error')}. Some data on this page could not be loaded.
  </div>`;
}

function pageHeader(title, subtitle, actions) {
  return `<header class="flex items-start justify-between mb-8">
    <div>
      <h1 class="text-2xl font-bold text-slate-900 dark:text-slate-100">${escapeHtml(title)}</h1>
      ${subtitle ? `<p class="mt-1 text-sm text-slate-500 dark:text-slate-400">${escapeHtml(subtitle)}</p>` : ''}
    </div>
    ${actions ? `<div class="flex items-center gap-2">${actions}</div>` : ''}
  </header>`;
}

// One dashboard tile. `href` (optional) makes the whole tile a link to the
// page that explains the number.
function statCard(label, value, accent, href) {
  const dot = accent || 'bg-brand-500';
  const display = (value === null || value === undefined) ? '—' : String(value);
  const inner = `<span class="inline-block w-2 h-10 rounded-full ${dot}"></span>
    <div>
      <div class="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400">${escapeHtml(label)}</div>
      <div class="mt-1 text-2xl font-semibold text-slate-900 dark:text-slate-100">${escapeHtml(display)}</div>
    </div>`;
  return href
    ? `<a href="${escapeHtml(href)}" class="stat-card card surface-target card-pad flex items-center gap-4 hover:ring-2 hover:ring-brand-500/30 transition">${inner}</a>`
    : `<div class="stat-card card surface-target card-pad flex items-center gap-4">${inner}</div>`;
}

async function safeGet(db, sql, params, fallback) {
  try { return { value: await db.getAsync(sql, params), err: null }; }
  catch (err) { return { value: fallback, err }; }
}

module.exports = function (db, appConfig) {
  const router = express.Router();

  // ── Dashboard ─────────────────────────────────────────────────────────
  // Counts only — every query is a portable COUNT(*). "Upcoming" is the web
  // app's rule (published, starts_at ≥ now − 12 h) and "currently locked"
  // binds JS's Date.now() against the epoch-ms column, so no engine-specific
  // time function is needed. The "Pending verification" list is the board's
  // to-do list: nonprofits waiting to be checked before they're listed.
  router.get('/', requireAdmin, async (req, res) => {
    const user = req.session.user;
    const c = {};
    let firstErr = null;
    const now = Date.now();
    const upcomingCut = new Date(now - 12 * 3600 * 1000).toISOString().replace('T', ' ').replace(/\..+/, '');
    for (const [key, sql, params] of [
      ['verified',     "SELECT COUNT(*) AS c FROM organizations WHERE verification_status = 'verified'", []],
      ['pending',      "SELECT COUNT(*) AS c FROM organizations WHERE verification_status = 'unverified'", []],
      ['rejected',     "SELECT COUNT(*) AS c FROM organizations WHERE verification_status = 'rejected'", []],
      ['upcoming',     "SELECT COUNT(*) AS c FROM events WHERE status = 'published' AND starts_at >= ?", [upcomingCut]],
      ['drafts',       "SELECT COUNT(*) AS c FROM events WHERE status = 'draft'", []],
      ['openRaffles',  "SELECT COUNT(*) AS c FROM raffles WHERE status = 'open'", []],
      ['lockedIps',    "SELECT COUNT(*) AS c FROM login_lockouts WHERE scope = 'ip' AND locked_until_ms > ?", [now]],
      ['lockedAccts',  "SELECT COUNT(*) AS c FROM login_lockouts WHERE scope <> 'ip' AND locked_until_ms > ?", [now]]
    ]) {
      const { value, err } = await safeGet(db, sql, params, { c: null });
      c[key] = value && value.c != null ? Number(value.c) : null;
      if (err && !firstErr) firstErr = err;
    }
    const localCount = localAdmins.count();
    let pending = [];
    try {
      pending = await db.allAsync(`SELECT o.user_id, o.name, o.ein, o.city, o.created_at, u.email
                                     FROM organizations o JOIN users u ON u.user_id = o.user_id
                                    WHERE o.verification_status = 'unverified'
                                    ORDER BY o.created_at ASC, o.org_id ASC LIMIT 25`, []);
    } catch (err) { if (!firstErr) firstErr = err; }
    const locked = (c.lockedIps == null && c.lockedAccts == null) ? null : (c.lockedIps || 0) + (c.lockedAccts || 0);

    const pendingHtml = pending.length
      ? `<div class="table-wrap surface-target"><table class="table-base">
          <thead><tr><th>Organization</th><th>EIN</th><th>City</th><th>Email</th><th>Signed up</th></tr></thead>
          <tbody>${pending.map(p => `<tr>
            <td class="font-medium"><a class="text-brand-600 hover:underline" href="/nonprofits/${Number(p.user_id)}">${escapeHtml(p.name || '(no name)')}</a></td>
            <td class="font-mono text-xs">${escapeHtml(p.ein || '—')}</td>
            <td>${escapeHtml(p.city || '—')}</td>
            <td class="text-xs">${escapeHtml(p.email || '')}</td>
            <td class="text-xs text-slate-500 whitespace-nowrap">${escapeHtml(p.created_at ? String(p.created_at) : '—')}</td>
          </tr>`).join('')}</tbody></table></div>
          ${c.pending > pending.length ? `<p class="mt-2 text-xs text-slate-500"><a class="text-brand-600 hover:underline" href="/nonprofits?status=unverified">All ${c.pending} pending →</a></p>` : ''}`
      : `<p class="text-sm text-slate-500 dark:text-slate-400">${firstErr ? 'Unavailable.' : 'Nothing waiting — every nonprofit has been reviewed.'}</p>`;

    const body = `
      ${pageHeader('Dashboard', `Welcome back, ${user.name || user.username}.`)}

      ${dbBanner(firstErr)}

      <section class="mb-10">
        <h2 class="text-sm font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-3">Nonprofits</h2>
        <div class="grid grid-cols-2 lg:grid-cols-4 gap-4">
          ${statCard('Verified', c.verified, 'bg-emerald-500', '/nonprofits?status=verified')}
          ${statCard('Pending verification', c.pending, 'bg-amber-500', '/nonprofits?status=unverified')}
          ${statCard('Rejected', c.rejected, 'bg-red-500', '/nonprofits?status=rejected')}
        </div>
      </section>

      <section class="mb-10">
        <h2 class="text-sm font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-3">Website</h2>
        <div class="grid grid-cols-2 lg:grid-cols-4 gap-4">
          ${statCard('Upcoming events', c.upcoming, 'bg-sky-500', '/events')}
          ${statCard('Event drafts', c.drafts, 'bg-slate-400', '/events?tab=drafts')}
          ${statCard('Open raffles', c.openRaffles, 'bg-indigo-500', '/raffles?status=open')}
        </div>
      </section>

      <section class="mb-10">
        <h2 class="text-sm font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-3">Security &amp; console</h2>
        <div class="grid grid-cols-2 lg:grid-cols-4 gap-4">
          ${statCard('Locked logins', locked, 'bg-orange-500', '/locked-users')}
          ${statCard('Console admins', localCount, 'bg-brand-500', '/admins')}
        </div>
      </section>

      <section>
        <h2 class="text-sm font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-3">Pending verification</h2>
        ${pendingHtml}
      </section>
    `;
    res.send(page({ title: 'Dashboard', body, appConfig, user, activeNav: 'home' }));
  });

  // ── Console admins (LOCAL FILE — no DB) ───────────────────────────────
  router.get('/admins', requireAdmin, (req, res) => {
    const user = req.session.user;
    const rows = localAdmins.loadAll();
    const myUsername = (user.username || '').toLowerCase();
    const tbody = rows.map(a => {
      const isSelf = a.username.toLowerCase() === myUsername;
      return `
        <tr>
          <td class="font-mono font-semibold text-slate-900 dark:text-slate-100">${escapeHtml(a.username)}</td>
          <td>${escapeHtml(a.email || '')}</td>
          <td>${escapeHtml(a.name || '')}</td>
          <td class="text-right">
            ${!isSelf
              ? `<form method="POST" action="/admins/delete" class="inline"
                       x-data x-on:submit.prevent="window.uiConfirmSubmit($event.target, 'Remove this admin?', { title: 'Remove admin', confirmLabel: 'Remove' })">
                   <input type="hidden" name="username" value="${escapeHtml(a.username)}">
                   <button type="submit" class="btn-danger text-xs px-3 py-1.5">Remove</button>
                 </form>`
              : '<span class="text-xs text-slate-400">(you)</span>'}
          </td>
        </tr>
      `;
    }).join('');
    const minLen = getPasswordRules(appConfig).minLength;
    const body = `
      ${pageHeader('Console admins', 'Operators who can sign in to this admin console. Stored locally in local_admins.json (gitignored). Web app accounts (nonprofits) are managed under Nonprofits.')}
      ${flash('error', req.query.error)}
      ${flash('success', req.query.msg)}

      <div class="grid lg:grid-cols-5 gap-6">
        <div class="lg:col-span-3">
          <div class="table-wrap surface-target">
            <table class="table-base">
              <thead><tr><th>Username</th><th>Email</th><th>Name</th><th class="text-right"></th></tr></thead>
              <tbody>${tbody || '<tr><td colspan="4" class="text-center py-8 text-slate-400">No admins.</td></tr>'}</tbody>
            </table>
          </div>
        </div>

        <div class="lg:col-span-2">
          <div class="card surface-target card-pad">
            <h2 class="text-sm font-semibold text-slate-900 dark:text-slate-100">Add an admin</h2>
            <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">Re-using an existing username replaces that admin's record.</p>
            <form method="POST" action="/admins" class="mt-4 space-y-3"
                  x-data="{ password: '', passwordConfirm: '', showPassword: false }"
                  x-on:submit="if (password !== passwordConfirm) { $event.preventDefault(); window.uiConfirm('The two passwords do not match.', { title: 'Check the password', confirmLabel: 'OK', danger: false }); }">
              <div>
                <label class="label" for="adm-user">Username</label>
                <input id="adm-user" class="input" type="text" name="username" required autocomplete="username" maxlength="100" pattern="[A-Za-z0-9._\\-]+" title="Letters, digits, dot, dash, underscore">
              </div>
              <div>
                <label class="label" for="adm-email">Email</label>
                <input id="adm-email" class="input" type="email" name="email" required autocomplete="email" maxlength="255">
              </div>
              <div>
                <label class="label" for="adm-name">Name</label>
                <input id="adm-name" class="input" type="text" name="name" required autocomplete="name" maxlength="100">
              </div>
              <div>
                <label class="label" for="adm-pw">Password</label>
                <div class="flex items-stretch gap-2">
                  <input id="adm-pw" class="input flex-1" :type="showPassword ? 'text' : 'password'" type="password" name="password" required minlength="${minLen}" autocomplete="new-password" x-model="password">
                  <button type="button" class="btn-secondary text-xs px-3" x-on:click="showPassword = !showPassword" x-text="showPassword ? 'Hide' : 'Show'"
                          aria-controls="adm-pw adm-pw2" title="Show or hide both passwords"></button>
                </div>
              </div>
              <div>
                <label class="label" for="adm-pw2">Confirm password</label>
                <input id="adm-pw2" class="input" :type="showPassword ? 'text' : 'password'" type="password" name="confirm_password" required minlength="${minLen}" autocomplete="new-password" x-model="passwordConfirm">
                <p class="mt-1 text-xs text-red-600 dark:text-red-300" x-show="password && passwordConfirm && password !== passwordConfirm" x-cloak>Passwords do not match</p>
              </div>
              <button type="submit" class="btn-primary w-full">Save admin</button>
            </form>
          </div>
        </div>
      </div>
    `;
    res.send(page({ title: 'Console admins', body, appConfig, user, activeNav: 'admins' }));
  });

  router.post('/admins', requireAdmin, async (req, res) => {
    try {
      const username = (req.body.username || '').trim().toLowerCase();
      const email = (req.body.email || '').trim().toLowerCase();
      const name = (req.body.name || '').trim();
      const password = req.body.password || '';
      const confirm = req.body.confirm_password || '';
      const rules = getPasswordRules(appConfig);
      if (!username || !email || !name || !password) return res.redirect('/admins?error=All+fields+are+required');
      if (!/^[A-Za-z0-9._-]+$/.test(username)) {
        return res.redirect('/admins?error=Username+may+only+contain+letters%2C+digits%2C+dot%2C+dash%2C+underscore');
      }
      if (password !== confirm) return res.redirect('/admins?error=Passwords+do+not+match');
      const pwErr = validatePassword(password, rules);
      if (pwErr) return res.redirect('/admins?error=' + encodeURIComponent(pwErr));

      const password_hash = await hashPassword(password);
      const existed = !!localAdmins.findByUsername(username);
      localAdmins.upsert({ username, email, name, password_hash });
      res.redirect('/admins?msg=' + encodeURIComponent(existed ? `Admin "${username}" updated.` : `Admin "${username}" added.`));
    } catch (err) {
      console.error('[admin] add local admin failed:', err);
      res.redirect('/admins?error=Save+failed');
    }
  });

  router.post('/admins/delete', requireAdmin, (req, res) => {
    const username = (req.body.username || '').trim().toLowerCase();
    if (!username) return res.redirect('/admins?error=Username+is+required');
    if (username === (req.session.user.username || '').toLowerCase()) {
      return res.redirect('/admins?error=You+cannot+remove+yourself');
    }
    if (localAdmins.count() <= 1) {
      return res.redirect('/admins?error=At+least+one+admin+must+remain');
    }
    const removed = localAdmins.remove(username);
    if (removed) return res.redirect('/admins?msg=' + encodeURIComponent(`Admin "${username}" removed.`));
    res.redirect('/admins?error=Admin+not+found');
  });

  return router;
};
