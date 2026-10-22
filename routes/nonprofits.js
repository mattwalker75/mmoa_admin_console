// routes/nonprofits.js — nonprofit accounts and their "Need Help?" directory
// profiles (the web app's `users` + `organizations` tables and the org_*
// children). Replaces the v1 Members page: the only people with web-app
// logins are other nonprofits, each with exactly one organization profile.
//
//   GET  /nonprofits                        → list + search + status / listing filters
//   GET  /nonprofits/:id                    → whole profile (incl. hidden fields + photos),
//                                             account, verification, IRS / ProPublica panel
//   GET  /nonprofits/:id/propublica         → JSON: server-side ProPublica lookup of the EIN
//   POST /nonprofits/:id/verification       → status=verified|rejected|unverified + note
//   POST /nonprofits/:id/active             → state=1 activate / state=0 deactivate the login
//   POST /nonprofits/:id/verify-email       → state=1 mark email verified / state=0 unverified
//   POST /nonprofits/:id/update             → edit the account (name / login / email / phone)
//   POST /nonprofits/:id/reset-password     → bcrypt cost 10, like the web app
//   POST /nonprofits/:id/images/:imageId/delete → remove one profile photo (moderation)
//   POST /nonprofits/:id/delete             → delete the account, its organization, every
//                                             child row and the photo files
//   GET  /members[/*]                       → redirect here (v1 URL)
//
// :id is the USER id — the account always exists, the organization row is
// 1:1 with it (an account created outside the sign-up flow may lack one; the
// page then says so).
//
// Only `verified` + listed organizations appear in the public directory; the
// web app never shows the EIN or fields the org marked hidden. The console
// sees everything.
//
// Remote SQLite has no FK enforcement and no reads inside transactions, so
// Delete reads the photo paths first, then deletes every child explicitly in
// one transaction (and nulls the soft references from events / raffles).

const express = require('express');
const { page, flash } = require('../views/layout');
const { escapeHtml, jsAttrStr } = require('../views/escapeHtml');
const { requireAdmin, hashPassword, getPasswordRules, validatePassword } = require('../middleware/auth');
const kit = require('../helpers/pageKit');
const uploads = require('../helpers/webAppUploads');
const { renderMarkdownLite } = require('../helpers/markdownLite');

const STATUS_PILL = { verified: 'pill-running', unverified: 'pill-pending', rejected: 'pill-failed' };
const STATUS_LABEL = { verified: 'Verified', unverified: 'Pending verification', rejected: 'Rejected' };
const DEFAULT_PUBLIC = ['address', 'phone', 'public_email', 'website_url', 'facebook_url', 'instagram_url',
  'other_social_url', 'description', 'hours', 'what_to_bring', 'contacts', 'images', 'service_cities', 'categories'];
const PROPUBLICA_API = 'https://projects.propublica.org/nonprofits/api/v2/organizations/';
const PROPUBLICA_PAGE = 'https://projects.propublica.org/nonprofits/organizations/';
const IRS_TEOS = 'https://apps.irs.gov/app/eos/';

function einDigits(ein) {
  const d = String(ein || '').replace(/\D/g, '');
  return d.length === 9 ? d : null;
}

function parsePublicFields(raw) {
  if (raw == null || raw === '') return DEFAULT_PUBLIC.slice();
  try {
    const a = JSON.parse(raw);
    return Array.isArray(a) ? a.map(String) : DEFAULT_PUBLIC.slice();
  } catch (e) { return DEFAULT_PUBLIC.slice(); }
}

// Login names are case-insensitive in the web app; emails are stored
// lowercased. `exceptId` skips the account being edited.
async function findConflict(db, login_name, email, exceptId) {
  const row = await db.getAsync(
    `SELECT user_id, login_name, email FROM users
      WHERE (LOWER(login_name) = LOWER(?) OR LOWER(email) = LOWER(?)) AND user_id <> ? LIMIT 1`,
    [login_name, email, exceptId || 0]);
  if (!row) return null;
  if (String(row.login_name || '').toLowerCase() === login_name.toLowerCase()) return 'Login name is already taken';
  return 'Email is already in use';
}
function uniqueMessage(err) {
  const m = String((err && err.message) || '');
  if (/UNIQUE|Duplicate entry/i.test(m)) {
    if (/email/i.test(m)) return 'Email is already in use';
    if (/login/i.test(m)) return 'Login name is already taken';
    return 'Login name or email is already in use';
  }
  return null;
}

function readAccount(b) {
  const f = {
    login_name: (b.login_name || '').trim(),
    email: (b.email || '').trim().toLowerCase(),
    first_name: (b.first_name || '').trim(),
    last_name: (b.last_name || '').trim(),
    phone_number: (b.phone_number || '').trim() || null
  };
  if (!f.login_name) return { error: 'Login name is required' };
  if (!/^[^\s]+$/.test(f.login_name)) return { error: 'Login name cannot contain spaces' };
  if (!f.email) return { error: 'Email is required' };
  if (!/^[^\s@]+@[^\s@]+$/.test(f.email)) return { error: 'Email does not look valid' };
  if (!f.first_name) return { error: 'First name is required' };
  if (!f.last_name) return { error: 'Last name is required' };
  return { fields: f };
}

function resetPasswordModal(userId, minLen) {
  return `
    <div x-show="openReset" x-transition x-cloak x-on:keydown.escape.window="openReset = false"
         class="fixed inset-0 z-40 flex items-center justify-center p-4 bg-black/60 overflow-y-auto" x-on:click.self="openReset = false">
      <div class="card surface-target card-pad w-full max-w-md my-8"
           x-data="{ password: '', passwordConfirm: '', showPassword: false, reset() { this.password = ''; this.passwordConfirm = ''; this.showPassword = false; } }"
           x-init="$watch('openReset', v => { if (v) reset(); })">
        <h2 class="text-lg font-semibold text-slate-900 dark:text-slate-100">Reset password</h2>
        <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">Sets a new password for this account (bcrypt, same hashing as the web app). Takes effect immediately; outstanding password-reset links are invalidated.</p>
        <form method="POST" action="/nonprofits/${userId}/reset-password" class="mt-5 space-y-4"
              x-on:submit="if (password !== passwordConfirm) { $event.preventDefault(); window.uiConfirm('The two passwords do not match.', { title: 'Check the password', confirmLabel: 'OK', danger: false }); }">
          <div>
            <label class="label" for="rp-pw">New password *</label>
            <div class="flex items-stretch gap-2">
              <input id="rp-pw" class="input flex-1" :type="showPassword ? 'text' : 'password'" name="password" required minlength="${minLen}" autocomplete="new-password" x-model="password">
              <button type="button" class="btn-secondary text-xs px-3" x-on:click="showPassword = !showPassword" x-text="showPassword ? 'Hide' : 'Show'"></button>
            </div>
          </div>
          <div>
            <label class="label" for="rp-pw2">Confirm password *</label>
            <input id="rp-pw2" class="input" :type="showPassword ? 'text' : 'password'" name="password_confirm" required minlength="${minLen}" autocomplete="new-password" x-model="passwordConfirm">
            <p class="mt-1 text-xs text-red-600 dark:text-red-300" x-show="password && passwordConfirm && password !== passwordConfirm">Passwords do not match</p>
          </div>
          <div class="flex justify-end gap-2 pt-2">
            <button type="button" class="btn-secondary" x-on:click="openReset = false">Cancel</button>
            <button type="submit" class="btn-primary">Reset password</button>
          </div>
        </form>
      </div>
    </div>`;
}

// Edit-account modal, seeded from data-* attributes (safe for names like
// O'Brien — see views/escapeHtml.js jsAttrStr notes).
function modifyAccountModal(m) {
  const dataAttrs = [
    `data-first-name="${escapeHtml(m.first_name || '')}"`, `data-last-name="${escapeHtml(m.last_name || '')}"`,
    `data-login-name="${escapeHtml(m.login_name || '')}"`, `data-email="${escapeHtml(m.email || '')}"`,
    `data-phone-number="${escapeHtml(m.phone_number || '')}"`
  ].join(' ');
  return `
    <div x-show="openModify" x-transition x-cloak x-on:keydown.escape.window="openModify = false"
         class="fixed inset-0 z-40 flex items-center justify-center p-4 bg-black/60 overflow-y-auto" x-on:click.self="openModify = false">
      <div class="card surface-target card-pad w-full max-w-2xl my-8" ${dataAttrs}
           x-data="{ firstName: '', lastName: '', loginName: '', email: '', phoneNumber: '',
             seed() { const d = $el.dataset; this.firstName = d.firstName; this.lastName = d.lastName; this.loginName = d.loginName; this.email = d.email; this.phoneNumber = d.phoneNumber; } }"
           x-init="seed(); $watch('openModify', v => { if (v) seed(); })">
        <h2 class="text-lg font-semibold text-slate-900 dark:text-slate-100">Edit account</h2>
        <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">The login account and its primary contact person. Login name and email must stay unique.</p>
        <form method="POST" action="/nonprofits/${Number(m.user_id)}/update" class="mt-5 space-y-4">
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div><label class="label" for="ma-first">First name *</label><input id="ma-first" class="input" type="text" name="first_name" required maxlength="100" x-model="firstName"></div>
            <div><label class="label" for="ma-last">Last name *</label><input id="ma-last" class="input" type="text" name="last_name" required maxlength="100" x-model="lastName"></div>
            <div><label class="label" for="ma-login">Login name *</label><input id="ma-login" class="input" type="text" name="login_name" required maxlength="100" x-model="loginName"></div>
            <div><label class="label" for="ma-email">Email *</label><input id="ma-email" class="input" type="email" name="email" required maxlength="255" autocomplete="off" x-model="email"></div>
            <div><label class="label" for="ma-phone">Phone number</label><input id="ma-phone" class="input" type="tel" name="phone_number" maxlength="40" x-model="phoneNumber"></div>
          </div>
          <div class="flex justify-end gap-2 pt-2">
            <button type="button" class="btn-secondary" x-on:click="openModify = false">Cancel</button>
            <button type="submit" class="btn-primary">Save changes</button>
          </div>
        </form>
      </div>
    </div>`;
}

function field(label, valueHtml, isPublic) {
  const badge = isPublic === undefined ? ''
    : isPublic ? ' <span class="pill-running">public</span>' : ' <span class="pill-terminated">hidden</span>';
  return `<div>
    <div class="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400">${escapeHtml(label)}${badge}</div>
    <div class="mt-0.5 text-sm font-medium text-slate-900 dark:text-slate-100 break-words">${valueHtml}</div>
  </div>`;
}
function textOr(v) { return v ? escapeHtml(v) : '<span class="text-slate-400">—</span>'; }
function linkOr(v) {
  return v && /^https?:\/\//i.test(v)
    ? `<a class="text-brand-600 hover:underline break-all" href="${escapeHtml(v)}" target="_blank" rel="noopener noreferrer">${escapeHtml(v)}</a>`
    : textOr(v);
}

module.exports = function (db, appConfig) {
  const router = express.Router();

  // v1 URLs (bookmarks, old docs) → the page that replaced Members.
  router.get(['/members', '/members/*rest'], requireAdmin, (req, res) => res.redirect(301, '/nonprofits'));

  // ── List ────────────────────────────────────────────────────────────
  router.get('/nonprofits', requireAdmin, async (req, res) => {
    const user = req.session.user;
    const { rows, err } = await kit.safeAll(db, `
      SELECT u.user_id, u.login_name, u.email, u.first_name, u.last_name, u.is_active, u.email_verified_at,
             u.created_at, u.last_login_at, o.org_id, o.name AS org_name, o.ein, o.city, o.verification_status, o.is_listed
        FROM users u LEFT JOIN organizations o ON o.user_id = u.user_id
       ORDER BY u.created_at DESC, u.user_id DESC`, []);
    const list = rows.map(r => {
      const contact = [r.first_name, r.last_name].filter(Boolean).join(' ');
      const status = r.org_id ? (r.verification_status || 'unverified') : 'no-org';
      return {
        id: r.user_id, name: r.org_name || '', ein: r.ein || '', contact, email: r.email || '',
        status, listed: r.org_id ? !!Number(r.is_listed) : false, active: !!Number(r.is_active),
        emailVerified: !!r.email_verified_at, city: r.city || '',
        created: r.created_at ? String(r.created_at) : '',
        search: [r.org_name, r.ein, contact, r.email, r.login_name, r.city].filter(Boolean).join(' ').toLowerCase()
      };
    });
    const initStatus = ['unverified', 'verified', 'rejected', 'no-org'].includes(req.query.status) ? req.query.status : '';
    const body = `
      <div data-rows="${escapeHtml(JSON.stringify(list))}" data-status="${escapeHtml(initStatus)}"
           x-data="{ rows: [], query: '', status: '', listing: '', account: '', sortKey: 'created', sortDir: 'desc',
             init() { this.rows = JSON.parse(this.$el.dataset.rows); this.status = this.$el.dataset.status || ''; },
             get visible() {
               const q = this.query.trim().toLowerCase();
               let a = this.rows.slice();
               if (q) a = a.filter(r => r.search.includes(q));
               if (this.status) a = a.filter(r => r.status === this.status);
               if (this.listing === 'listed') a = a.filter(r => r.listed);
               if (this.listing === 'hidden') a = a.filter(r => !r.listed);
               if (this.account === 'inactive') a = a.filter(r => !r.active);
               if (this.account === 'email-unverified') a = a.filter(r => !r.emailVerified);
               const d = this.sortDir === 'asc' ? 1 : -1, k = this.sortKey;
               a.sort((x, y) => { const p = String(x[k] || '').toLowerCase(), q2 = String(y[k] || '').toLowerCase(); return p < q2 ? -d : p > q2 ? d : 0; });
               return a;
             },
             sortBy(k) { if (this.sortKey === k) this.sortDir = this.sortDir === 'asc' ? 'desc' : 'asc'; else { this.sortKey = k; this.sortDir = 'asc'; } },
             icon(k) { return this.sortKey !== k ? '' : (this.sortDir === 'asc' ? '▲' : '▼'); } }">
        ${kit.pageHeader('Nonprofits', 'Organizations with a login on the website. Verify them here before they appear in the public "Need Help?" directory.')}
        ${flash('error', req.query.error)}
        ${flash('success', req.query.msg)}
        ${kit.dbBanner(err)}
        <div class="mb-4 flex flex-wrap items-center gap-3">
          <input class="input max-w-md" type="search" placeholder="Search name, EIN, contact, email, city…" autocomplete="off" x-model="query" aria-label="Search">
          <select class="input max-w-[13rem]" x-model="status" aria-label="Verification status">
            <option value="">Any verification</option>
            <option value="unverified">Pending verification</option>
            <option value="verified">Verified</option>
            <option value="rejected">Rejected</option>
            <option value="no-org">No organization profile</option>
          </select>
          <select class="input max-w-[11rem]" x-model="listing" aria-label="Directory listing">
            <option value="">Listed or hidden</option>
            <option value="listed">Listed by the org</option>
            <option value="hidden">Hidden by the org</option>
          </select>
          <select class="input max-w-[13rem]" x-model="account" aria-label="Account">
            <option value="">Any account state</option>
            <option value="inactive">Deactivated logins</option>
            <option value="email-unverified">Email not verified</option>
          </select>
          <span class="text-xs text-slate-500 dark:text-slate-400" x-text="visible.length + ' of ' + rows.length"></span>
        </div>
        <div class="table-wrap surface-target">
          <table class="table-base">
            <thead><tr>
              <th class="cursor-pointer select-none" x-on:click="sortBy('name')">Name <span class="text-xs text-slate-400" x-text="icon('name')"></span></th>
              <th class="cursor-pointer select-none" x-on:click="sortBy('ein')">EIN <span class="text-xs text-slate-400" x-text="icon('ein')"></span></th>
              <th class="cursor-pointer select-none" x-on:click="sortBy('contact')">Contact <span class="text-xs text-slate-400" x-text="icon('contact')"></span></th>
              <th class="cursor-pointer select-none" x-on:click="sortBy('email')">Email <span class="text-xs text-slate-400" x-text="icon('email')"></span></th>
              <th class="cursor-pointer select-none" x-on:click="sortBy('status')">Status <span class="text-xs text-slate-400" x-text="icon('status')"></span></th>
              <th class="cursor-pointer select-none" x-on:click="sortBy('created')">Created <span class="text-xs text-slate-400" x-text="icon('created')"></span></th>
            </tr></thead>
            <tbody>
              <template x-for="r in visible" :key="r.id">
                <tr class="cursor-pointer" x-on:click="window.location = '/nonprofits/' + r.id">
                  <td class="font-medium text-slate-900 dark:text-slate-100"><a class="hover:underline" :href="'/nonprofits/' + r.id" x-text="r.name || '(no organization profile)'"></a>
                    <div class="text-xs text-slate-400" x-text="r.city"></div></td>
                  <td class="font-mono text-xs" x-text="r.ein || '—'"></td>
                  <td x-text="r.contact || '—'"></td>
                  <td class="text-xs" x-text="r.email"></td>
                  <td class="space-x-1 whitespace-nowrap">
                    <span x-show="r.status === 'verified'" class="pill-running">Verified</span>
                    <span x-show="r.status === 'unverified'" class="pill-pending">Pending</span>
                    <span x-show="r.status === 'rejected'" class="pill-failed">Rejected</span>
                    <span x-show="r.status === 'no-org'" class="pill-terminated">No profile</span>
                    <span x-show="r.status !== 'no-org' && !r.listed" class="pill-terminated">Hidden</span>
                    <span x-show="!r.active" class="pill-failed">Inactive</span>
                    <span x-show="!r.emailVerified" class="pill-pending">Email unverified</span>
                  </td>
                  <td class="text-slate-500 text-xs whitespace-nowrap" x-text="r.created || '—'"></td>
                </tr>
              </template>
              <tr x-show="!visible.length"><td colspan="6" class="text-center py-8 text-slate-400">${err ? 'Unavailable.' : 'No matching nonprofits.'}</td></tr>
            </tbody>
          </table>
        </div>
      </div>`;
    res.send(page({ title: 'Nonprofits', body, appConfig, user, activeNav: 'nonprofits' }));
  });

  // ── Detail ──────────────────────────────────────────────────────────
  router.get('/nonprofits/:id', requireAdmin, async (req, res) => {
    const user = req.session.user;
    const id = kit.idParam(req.params.id);
    if (!id) return res.redirect('/nonprofits?error=Invalid+id');
    const { value: m, err: mErr } = await kit.safeGet(db,
      `SELECT user_id, login_name, email, first_name, last_name, phone_number, is_active, email_verified_at, created_at, last_login_at
         FROM users WHERE user_id = ?`, [id], null);
    if (mErr || !m) {
      return res.status(mErr ? 200 : 404).send(page({ title: 'Nonprofit', appConfig, user, activeNav: 'nonprofits',
        body: `${kit.pageHeader(mErr ? 'Nonprofit' : 'Nonprofit not found')}${kit.dbBanner(mErr)}
               ${mErr ? '' : `<p class="text-slate-500">No account with id <code class="font-mono">${id}</code>.</p>`}
               <p class="mt-4"><a class="text-brand-600 hover:underline" href="/nonprofits">← Back to nonprofits</a></p>` }));
    }
    const { value: o, err: oErr } = await kit.safeGet(db, 'SELECT * FROM organizations WHERE user_id = ?', [id], null);
    let contacts = { rows: [] }, images = { rows: [] }, cats = { rows: [] }, cities = { rows: [] };
    if (o) {
      contacts = await kit.safeAll(db, 'SELECT * FROM org_contacts WHERE org_id = ? ORDER BY sort, contact_id', [o.org_id]);
      images = await kit.safeAll(db, 'SELECT image_id, path, alt FROM org_images WHERE org_id = ? ORDER BY sort, image_id', [o.org_id]);
      cats = await kit.safeAll(db, 'SELECT c.name, c.is_active FROM org_categories oc JOIN categories c ON c.category_id = oc.category_id WHERE oc.org_id = ? ORDER BY c.sort, c.name', [o.org_id]);
      cities = await kit.safeAll(db, 'SELECT c.name, c.is_active FROM org_cities ox JOIN cities c ON c.city_id = ox.city_id WHERE ox.org_id = ? ORDER BY c.sort, c.name', [o.org_id]);
    }
    const now = kit.sqlTime();
    const { value: vRow, err: vErr } = await kit.safeGet(db,
      'SELECT COUNT(*) AS c FROM email_verification_tokens WHERE user_id = ? AND consumed_at IS NULL AND expires_at > ?', [id, now], { c: null });
    const { value: pRow, err: pErr } = await kit.safeGet(db,
      'SELECT COUNT(*) AS c FROM password_reset_tokens WHERE user_id = ? AND consumed_at IS NULL AND expires_at > ?', [id, now], { c: null });
    const { rows: lockRows, err: lErr } = await kit.safeAll(db,
      `SELECT scope, scope_key, fail_count, locked_until_ms FROM login_lockouts
        WHERE scope <> 'ip' AND (LOWER(scope_key) = LOWER(?) OR LOWER(scope_key) = LOWER(?))`, [m.login_name || '', m.email || '']);
    const firstErr = oErr || contacts.err || images.err || cats.err || cities.err || vErr || pErr || lErr || null;
    const lockedNow = lockRows.filter(l => l.locked_until_ms != null && Number(l.locked_until_ms) > Date.now());

    const contactName = [m.first_name, m.last_name].filter(Boolean).join(' ');
    const title = (o && o.name) || contactName || m.login_name || ('#' + id);
    const status = o ? (o.verification_status || 'unverified') : null;
    const pub = new Set(o ? parsePublicFields(o.public_fields) : []);
    const isPub = (k) => pub.has(k);
    const minLen = getPasswordRules(appConfig).minLength;

    // ── Organization profile card ──
    let profile;
    if (!o) {
      profile = `<section class="card surface-target card-pad">
        <h2 class="text-sm font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-2">Organization</h2>
        <p class="text-sm text-slate-500 dark:text-slate-400">This account has no organization profile (it was created outside the website's nonprofit sign-up). It can't be verified or listed until one exists — the organization fills it in from the website's portal after signing in, or add a row under <a class="text-brand-600 hover:underline" href="/data/organizations">Data Browser → organizations</a>.</p>
      </section>`;
    } else {
      const addr = [o.address_line1, o.address_line2, [o.city, o.state].filter(Boolean).join(', ') + (o.zip ? ' ' + o.zip : '')].filter(x => x && x.trim()).map(escapeHtml).join('<br>');
      const bring = String(o.what_to_bring || '').split('\n').map(s => s.trim()).filter(Boolean);
      const contactsHtml = contacts.rows.length ? `<ul class="space-y-2">${contacts.rows.map(c => `<li class="text-sm">
          <span class="font-medium">${textOr(c.name)}</span>${c.role ? ` <span class="text-slate-500">— ${escapeHtml(c.role)}</span>` : ''}
          ${Number(c.is_public) ? '<span class="pill-running">public</span>' : '<span class="pill-terminated">hidden</span>'}
          <div class="text-xs text-slate-500">${[c.email, c.phone ? c.phone + (c.phone_ext ? ' ext. ' + c.phone_ext : '') : ''].filter(Boolean).map(escapeHtml).join(' · ') || '—'}</div></li>`).join('')}</ul>`
        : '<span class="text-slate-400">—</span>';
      const imagesHtml = images.rows.length ? `<div class="grid grid-cols-2 md:grid-cols-5 gap-3">${images.rows.map(im => `
          <div class="space-y-1">
            <a href="/wa-uploads/${escapeHtml(im.path)}" target="_blank" rel="noopener">${kit.uploadImg(im.path, im.alt, 'h-28 w-full rounded object-cover border border-slate-200 dark:border-slate-700')}</a>
            <div class="text-xs text-slate-500 truncate" title="${escapeHtml(im.alt || '')}">${escapeHtml(im.alt || '(no alt text)')}</div>
            <form method="POST" action="/nonprofits/${id}/images/${Number(im.image_id)}/delete" class="m-0" x-data
                  x-on:submit.prevent="window.uiConfirmSubmit($event.target, 'Remove this photo from the organization profile? The file is deleted from the Web App.', { title: 'Remove photo', confirmLabel: 'Remove' })">
              <button type="submit" class="btn-ghost text-xs px-2 py-1 text-red-600">Remove</button></form>
          </div>`).join('')}</div>`
        : '<span class="text-slate-400">—</span>';
      const chips = (rows) => rows.length ? rows.map(r => `<span class="pill-terminated mr-1 mb-1">${escapeHtml(r.name)}${Number(r.is_active) ? '' : ' (inactive)'}</span>`).join('') : '<span class="text-slate-400">—</span>';
      profile = `<section class="card surface-target card-pad space-y-5">
        <div class="flex items-center justify-between gap-2 flex-wrap">
          <h2 class="text-sm font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">Organization profile</h2>
          <span class="text-xs text-slate-500">${Number(o.is_listed) ? '<span class="pill-running">Listed</span> the org wants to appear in the directory' : '<span class="pill-terminated">Hidden</span> the org has hidden its whole profile'}</span>
        </div>
        <div class="grid sm:grid-cols-2 gap-4">
          ${field('Name', textOr(o.name), true)}
          ${field('EIN', `<span class="font-mono">${textOr(o.ein)}</span>`, false)}
          ${field('Address', addr || '<span class="text-slate-400">—</span>', isPub('address'))}
          ${field('Phone', textOr(o.phone ? o.phone + (o.phone_ext ? ' ext. ' + o.phone_ext : '') : ''), isPub('phone'))}
          ${field('Public email', textOr(o.public_email), isPub('public_email'))}
          ${field('Website', linkOr(o.website_url), isPub('website_url'))}
          ${field('Facebook', linkOr(o.facebook_url), isPub('facebook_url'))}
          ${field('Instagram', linkOr(o.instagram_url), isPub('instagram_url'))}
          ${field('Other social', linkOr(o.other_social_url), isPub('other_social_url'))}
          ${field('Hours', o.hours ? escapeHtml(o.hours).replace(/\n/g, '<br>') : '<span class="text-slate-400">—</span>', isPub('hours'))}
        </div>
        <div>${field('Description', o.description_md ? `<div class="md-preview font-normal">${renderMarkdownLite(o.description_md)}</div>` : '<span class="text-slate-400">—</span>', isPub('description'))}</div>
        <div>${field('What to bring', bring.length ? `<ul class="list-disc pl-5 font-normal">${bring.map(b => `<li>${escapeHtml(b)}</li>`).join('')}</ul>` : '<span class="text-slate-400">—</span>', isPub('what_to_bring'))}</div>
        <div class="grid sm:grid-cols-2 gap-4">
          ${field('Categories', chips(cats.rows), isPub('categories'))}
          ${field('Service cities', chips(cities.rows), isPub('service_cities'))}
        </div>
        <div>${field('Search keywords — only used by the "Need Help?" keyword search', chips(String(o.search_tags || '').split(',').map(t => t.trim()).filter(Boolean).map(name => ({ name, is_active: 1 }))), false)}</div>
        <div>${field('Contacts', contactsHtml, isPub('contacts'))}</div>
        <div>${field(`Photos (${images.rows.length} of 5)`, imagesHtml, isPub('images'))}</div>
        <p class="text-xs text-slate-500 dark:text-slate-400">The organization edits this profile itself from the website's portal. Raw rows: <a class="text-brand-600 hover:underline" href="/data/organizations/row?key=${encodeURIComponent(JSON.stringify({ org_id: Number(o.org_id) }))}">Data Browser → organizations</a>.</p>
      </section>`;
    }

    // ── Verification card ──
    const verification = o ? `<section class="card surface-target card-pad" x-data="{ note: '' }">
        <h2 class="text-sm font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-3">Verification</h2>
        <p class="text-sm"><span class="${STATUS_PILL[status] || 'pill'}">${escapeHtml(STATUS_LABEL[status] || status)}</span></p>
        ${o.verified_by || o.verified_at ? `<p class="mt-2 text-xs text-slate-500">${status === 'verified' ? 'Verified' : 'Decided'}${o.verified_by ? ' by ' + escapeHtml(o.verified_by) : ''}${o.verified_at ? ' · ' + escapeHtml(String(o.verified_at)) + ' UTC' : ''}</p>` : ''}
        ${o.verification_note ? `<p class="mt-2 text-sm text-slate-700 dark:text-slate-200 whitespace-pre-wrap">${escapeHtml(o.verification_note)}</p>` : ''}
        <label class="label mt-4" for="vf-note">Note <span class="text-xs font-normal text-slate-400">(kept with the decision; not shown publicly)</span></label>
        <textarea id="vf-note" rows="2" maxlength="2000" x-model="note" class="block w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100" placeholder="e.g. EIN matches ProPublica; called the director to confirm."></textarea>
        <div class="mt-3 flex flex-wrap gap-2">
          ${['verified', 'rejected', 'unverified'].filter(s => s !== status).map(s => `
            <form method="POST" action="/nonprofits/${id}/verification" class="m-0"
                  x-on:submit.prevent="window.uiConfirmSubmit($event.target, ${jsAttrStr(s === 'verified' ? 'Verify ' + title + '? If it is listed, it appears in the public Need Help directory right away.' : s === 'rejected' ? 'Mark ' + title + ' as rejected? It stays out of the public directory.' : 'Reset ' + title + ' to unverified (pending)? It leaves the public directory.')}, { title: 'Verification', confirmLabel: ${jsAttrStr(s === 'verified' ? 'Verify' : s === 'rejected' ? 'Mark rejected' : 'Reset')}, danger: ${s === 'verified' ? 'false' : 'true'} })">
              <input type="hidden" name="status" value="${s}">
              <input type="hidden" name="note" :value="note">
              <button type="submit" class="${s === 'verified' ? 'btn-primary' : s === 'rejected' ? 'btn-danger' : 'btn-secondary'} text-sm">${s === 'verified' ? 'Verify' : s === 'rejected' ? 'Mark rejected' : 'Reset to unverified'}</button>
            </form>`).join('')}
        </div>
      </section>` : '';

    // ── IRS / ProPublica card ──
    const digits = o ? einDigits(o.ein) : null;
    const lookup = o ? `<section class="card surface-target card-pad" data-url="/nonprofits/${id}/propublica"
        x-data="{ busy: false, r: null, async run() { this.busy = true; this.r = null;
            try { const x = await fetch(this.$el.dataset.url, { headers: { 'Accept': 'application/json' } }); this.r = await x.json(); }
            catch (e) { this.r = { ok: false, error: 'Network error: ' + (e.message || e) }; }
            finally { this.busy = false; } } }" ${digits ? 'x-init="run()"' : ''}>
        <div class="flex items-center justify-between gap-2">
          <h2 class="text-sm font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">IRS / ProPublica lookup</h2>
          ${digits ? `<button type="button" class="btn-secondary text-xs px-3 py-1" x-on:click="run()" :disabled="busy">Look up again</button>` : ''}
        </div>
        ${digits ? `
        <p class="mt-1 text-xs text-slate-500">EIN <span class="font-mono">${escapeHtml(o.ein)}</span> — compare with what the organization entered.</p>
        <p x-show="busy" class="mt-3 text-sm text-slate-500">Looking up…</p>
        <div x-show="r && r.ok && r.found" x-cloak class="mt-3 grid grid-cols-2 gap-3 text-sm">
          <div class="col-span-2"><div class="text-xs uppercase text-slate-500">IRS name</div><div class="font-semibold" x-text="r && r.org && r.org.name"></div></div>
          <div><div class="text-xs uppercase text-slate-500">City / state</div><div x-text="r && r.org && [r.org.city, r.org.state].filter(Boolean).join(', ')"></div></div>
          <div><div class="text-xs uppercase text-slate-500">Ruling date</div><div x-text="r && r.org && (r.org.ruling_date || '—')"></div></div>
          <div><div class="text-xs uppercase text-slate-500">NTEE code</div><div class="font-mono" x-text="r && r.org && (r.org.ntee_code || '—')"></div></div>
          <div><div class="text-xs uppercase text-slate-500">Subsection</div><div x-text="r && r.org && (r.org.subsection || '—')"></div></div>
        </div>
        <p x-show="r && r.ok && !r.found" x-cloak class="mt-3 flash-warn text-sm">Not found in ProPublica's copy of the IRS data. Newly recognized organizations can take months to appear — check IRS TEOS below.</p>
        <p x-show="r && !r.ok" x-cloak class="mt-3 flash-error text-sm" x-text="r && r.error"></p>
        <div class="mt-4 flex flex-wrap gap-3 text-sm">
          <a class="text-brand-600 hover:underline" href="${escapeHtml(PROPUBLICA_PAGE + digits)}" target="_blank" rel="noopener noreferrer">ProPublica page ↗</a>
          <a class="text-brand-600 hover:underline" href="${IRS_TEOS}" target="_blank" rel="noopener noreferrer">IRS Tax Exempt Organization Search ↗</a>
        </div>` : `<p class="mt-2 text-sm text-slate-500">No valid 9-digit EIN on the profile${o.ein ? ` (<span class="font-mono">${escapeHtml(o.ein)}</span>)` : ''}. <a class="text-brand-600 hover:underline" href="${IRS_TEOS}" target="_blank" rel="noopener noreferrer">IRS TEOS search ↗</a></p>`}
      </section>` : '';

    // ── Account card ──
    const account = `<section class="card surface-target card-pad space-y-4">
        <h2 class="text-sm font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">Login account</h2>
        <div class="grid grid-cols-2 gap-3">
          ${field('Contact person', textOr(contactName))}
          ${field('Login', `<span class="font-mono">${textOr(m.login_name)}</span>`)}
          ${field('Email', textOr(m.email))}
          ${field('Phone', textOr(m.phone_number))}
          ${field('Created', textOr(m.created_at && String(m.created_at)))}
          ${field('Last login', textOr(m.last_login_at && String(m.last_login_at)))}
          ${field('Email verified', m.email_verified_at ? escapeHtml(String(m.email_verified_at)) : '<span class="pill-pending">No</span>')}
          ${field('Login', Number(m.is_active) ? '<span class="pill-running">Active</span>' : '<span class="pill-failed">Deactivated</span>')}
          ${field('Open links', `${vRow && vRow.c != null ? Number(vRow.c) : '—'} verify · ${pRow && pRow.c != null ? Number(pRow.c) : '—'} reset`)}
          ${field('Lockout', lockedNow.length ? `<span class="pill-failed">Locked</span> <a class="text-brand-600 hover:underline text-xs" href="/locked-users">Unlock →</a>` : 'Not locked')}
        </div>
        <div class="flex flex-wrap gap-2 pt-1">
          <form method="POST" action="/nonprofits/${id}/active" class="m-0"
                x-on:submit.prevent="window.uiConfirmSubmit($event.target, ${jsAttrStr(Number(m.is_active) ? 'Deactivate the login for ' + title + '? They are signed out and cannot sign in until reactivated.' : 'Reactivate the login for ' + title + '?')}, { title: 'Login', confirmLabel: ${Number(m.is_active) ? "'Deactivate'" : "'Activate'"}, danger: ${Number(m.is_active) ? 'true' : 'false'} })">
            <input type="hidden" name="state" value="${Number(m.is_active) ? '0' : '1'}">
            <button type="submit" class="btn-secondary text-sm">${Number(m.is_active) ? 'Deactivate login' : 'Activate login'}</button>
          </form>
          <form method="POST" action="/nonprofits/${id}/verify-email" class="m-0">
            <input type="hidden" name="state" value="${m.email_verified_at ? '0' : '1'}">
            <button type="submit" class="btn-secondary text-sm">${m.email_verified_at ? 'Mark email unverified' : 'Mark email verified'}</button>
          </form>
          <button type="button" class="btn-secondary text-sm" x-on:click="openReset = true">Reset password</button>
          <button type="button" class="btn-secondary text-sm" x-on:click="openModify = true">Edit account</button>
        </div>
      </section>`;

    const body = `
      <div x-data="{ openReset: false, openModify: false }">
        <div class="mb-4"><a class="text-sm text-brand-600 hover:underline" href="/nonprofits">← Back to nonprofits</a></div>
        ${kit.pageHeader(title, `${contactName ? contactName + ' · ' : ''}${m.email || ''}`,
          `${status ? `<span class="${STATUS_PILL[status] || 'pill'}">${escapeHtml(STATUS_LABEL[status] || status)}</span>` : '<span class="pill-terminated">No profile</span>'}
           <form method="POST" action="/nonprofits/${id}/delete" class="m-0"
                 x-on:submit.prevent="window.uiConfirmSubmit($event.target, ${jsAttrStr('Delete ' + title + '? The login account, the organization profile, its contacts, categories, cities and photo files are all removed. Events / raffles that named it as a beneficiary keep the name without the link. This cannot be undone.')}, { title: 'Delete nonprofit', confirmLabel: 'Delete' })">
             <button type="submit" class="btn-danger text-sm">Delete</button>
           </form>`)}
        ${flash('error', req.query.error)}
        ${flash('success', req.query.msg)}
        ${kit.dbBanner(firstErr)}
        ${o && Number(m.is_active) && status === 'verified' && !Number(o.is_listed) ? '<div class="flash-info mb-4 text-sm">Verified, but the organization has hidden its profile — it is not in the public directory.</div>' : ''}
        <div class="grid xl:grid-cols-3 gap-6">
          <div class="xl:col-span-2 space-y-6">${profile}</div>
          <div class="space-y-6">${verification}${lookup}${account}</div>
        </div>
        ${resetPasswordModal(id, minLen)}
        ${modifyAccountModal(m)}
      </div>`;
    res.send(page({ title, body, appConfig, user, activeNav: 'nonprofits' }));
  });

  // ── ProPublica lookup (server-side; 10 s timeout) ───────────────────
  router.get('/nonprofits/:id/propublica', requireAdmin, async (req, res) => {
    const id = kit.idParam(req.params.id);
    if (!id) return res.status(400).json({ ok: false, error: 'Invalid id' });
    let o;
    try { o = await db.getAsync('SELECT ein FROM organizations WHERE user_id = ?', [id]); }
    catch (e) { return res.status(500).json({ ok: false, error: 'Database unavailable: ' + (e.message || e) }); }
    const digits = o && einDigits(o.ein);
    if (!digits) return res.json({ ok: false, error: 'The profile has no valid 9-digit EIN.' });
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 10000);
    try {
      const r = await fetch(PROPUBLICA_API + digits + '.json', { signal: ctl.signal, headers: { 'Accept': 'application/json' } });
      if (r.status === 404) return res.json({ ok: true, found: false, ein: digits });
      if (!r.ok) return res.json({ ok: false, error: `ProPublica answered HTTP ${r.status}. Try again later or use the IRS search.` });
      const j = await r.json();
      const x = (j && j.organization) || {};
      const sub = Number(x.subsection_code);
      res.json({
        ok: true, found: true, ein: digits,
        org: {
          name: x.name || '', city: x.city || '', state: x.state || '',
          ruling_date: x.ruling_date || '', ntee_code: x.ntee_code || '',
          subsection: Number.isFinite(sub) && sub > 0 ? `501(c)(${sub})` : (x.subsection_code == null ? '' : String(x.subsection_code))
        }
      });
    } catch (e) {
      res.json({ ok: false, error: e.name === 'AbortError' ? 'ProPublica did not answer within 10 seconds.' : 'Lookup failed: ' + (e.message || e) });
    } finally {
      clearTimeout(timer);
    }
  });

  // ── Verification decision ───────────────────────────────────────────
  router.post('/nonprofits/:id/verification', requireAdmin, async (req, res) => {
    const id = kit.idParam(req.params.id);
    if (!id) return res.redirect('/nonprofits?error=Invalid+id');
    const status = (req.body && req.body.status) || '';
    if (!['verified', 'rejected', 'unverified'].includes(status)) return res.redirect(`/nonprofits/${id}?error=Unknown+status`);
    const note = kit.str(req.body.note, 2000);
    const by = req.session.user.username;
    try {
      const r = status === 'unverified'
        ? await db.runAsync(`UPDATE organizations SET verification_status = 'unverified', verified_at = NULL, verified_by = NULL,
              verification_note = COALESCE(?, verification_note), updated_at = ? WHERE user_id = ?`, [note, kit.sqlTime(), id])
        : await db.runAsync(`UPDATE organizations SET verification_status = ?, verified_at = ?, verified_by = ?,
              verification_note = COALESCE(?, verification_note), updated_at = ? WHERE user_id = ?`,
            [status, kit.sqlTime(), by, note, kit.sqlTime(), id]);
      if (!r.changes) return res.redirect(`/nonprofits/${id}?error=` + encodeURIComponent('This account has no organization profile to verify.'));
      console.log(`[nonprofits] ${by} set user #${id} organization to ${status}`);
      const msg = status === 'verified' ? 'Verified — listed organizations now appear in the Need Help directory.'
        : status === 'rejected' ? 'Marked rejected.' : 'Reset to unverified.';
      res.redirect(`/nonprofits/${id}?msg=` + encodeURIComponent(msg));
    } catch (err) {
      console.error('[nonprofits] verification failed:', err);
      res.redirect(`/nonprofits/${id}?error=` + encodeURIComponent('Update failed: ' + (err.message || err)));
    }
  });

  // ── Account actions ─────────────────────────────────────────────────
  router.post('/nonprofits/:id/active', requireAdmin, async (req, res) => {
    const id = kit.idParam(req.params.id);
    if (!id) return res.redirect('/nonprofits?error=Invalid+id');
    const on = (req.body && req.body.state) === '1';
    try {
      const r = await db.runAsync('UPDATE users SET is_active = ? WHERE user_id = ?', [on ? 1 : 0, id]);
      if (!r.changes) return res.redirect('/nonprofits?error=Account+not+found');
      console.log(`[nonprofits] ${req.session.user.username} ${on ? 'activated' : 'deactivated'} user #${id}`);
      res.redirect(`/nonprofits/${id}?msg=` + encodeURIComponent(on ? 'Login activated.' : 'Login deactivated.'));
    } catch (err) {
      res.redirect(`/nonprofits/${id}?error=` + encodeURIComponent('Update failed: ' + (err.message || err)));
    }
  });

  router.post('/nonprofits/:id/verify-email', requireAdmin, async (req, res) => {
    const id = kit.idParam(req.params.id);
    if (!id) return res.redirect('/nonprofits?error=Invalid+id');
    const verified = (req.body && req.body.state) === '1';
    try {
      const r = verified
        ? await db.runAsync('UPDATE users SET email_verified_at = COALESCE(email_verified_at, ?) WHERE user_id = ?', [kit.sqlTime(), id])
        : await db.runAsync('UPDATE users SET email_verified_at = NULL WHERE user_id = ?', [id]);
      if (!r.changes) return res.redirect('/nonprofits?error=Account+not+found');
      if (verified) {
        await db.runAsync('UPDATE email_verification_tokens SET consumed_at = ? WHERE user_id = ? AND consumed_at IS NULL', [kit.sqlTime(), id])
          .catch(e => console.warn('[nonprofits] could not consume verification tokens:', e.message || e));
      }
      res.redirect(`/nonprofits/${id}?msg=` + encodeURIComponent(verified ? 'Email marked verified.' : 'Email marked unverified.'));
    } catch (err) {
      res.redirect(`/nonprofits/${id}?error=` + encodeURIComponent('Update failed: ' + (err.message || err)));
    }
  });

  router.post('/nonprofits/:id/update', requireAdmin, async (req, res) => {
    const id = kit.idParam(req.params.id);
    if (!id) return res.redirect('/nonprofits?error=Invalid+id');
    const { fields: f, error } = readAccount(req.body || {});
    if (error) return res.redirect(`/nonprofits/${id}?error=` + encodeURIComponent(error));
    try {
      const conflict = await findConflict(db, f.login_name, f.email, id);
      if (conflict) return res.redirect(`/nonprofits/${id}?error=` + encodeURIComponent(conflict));
      const r = await db.runAsync('UPDATE users SET login_name = ?, email = ?, first_name = ?, last_name = ?, phone_number = ? WHERE user_id = ?',
        [f.login_name, f.email, f.first_name, f.last_name, f.phone_number, id]);
      if (!r.changes) return res.redirect('/nonprofits?error=Account+not+found');
      res.redirect(`/nonprofits/${id}?msg=Account+saved.`);
    } catch (err) {
      console.error('[nonprofits] update failed:', err);
      res.redirect(`/nonprofits/${id}?error=` + encodeURIComponent(uniqueMessage(err) || ('Update failed: ' + (err.message || err))));
    }
  });

  router.post('/nonprofits/:id/reset-password', requireAdmin, async (req, res) => {
    const id = kit.idParam(req.params.id);
    if (!id) return res.redirect('/nonprofits?error=Invalid+id');
    const b = req.body || {};
    const password = b.password || '';
    if (password !== (b.password_confirm || '')) return res.redirect(`/nonprofits/${id}?error=Passwords+do+not+match`);
    const pwErr = validatePassword(password, getPasswordRules(appConfig));
    if (pwErr) return res.redirect(`/nonprofits/${id}?error=` + encodeURIComponent(pwErr));
    try {
      const r = await db.runAsync('UPDATE users SET password_hash = ? WHERE user_id = ?', [await hashPassword(password), id]);
      if (!r.changes) return res.redirect('/nonprofits?error=Account+not+found');
      await db.runAsync('UPDATE password_reset_tokens SET consumed_at = ? WHERE user_id = ? AND consumed_at IS NULL', [kit.sqlTime(), id])
        .catch(e => console.warn('[nonprofits] could not consume reset tokens:', e.message || e));
      console.log(`[nonprofits] ${req.session.user.username} reset the password of user #${id}`);
      res.redirect(`/nonprofits/${id}?msg=Password+reset.`);
    } catch (err) {
      res.redirect(`/nonprofits/${id}?error=` + encodeURIComponent('Reset failed: ' + (err.message || err)));
    }
  });

  router.post('/nonprofits/:id/images/:imageId/delete', requireAdmin, async (req, res) => {
    const id = kit.idParam(req.params.id), imageId = kit.idParam(req.params.imageId);
    if (!id || !imageId) return res.redirect('/nonprofits?error=Invalid+id');
    try {
      const im = await db.getAsync(`SELECT i.image_id, i.path FROM org_images i JOIN organizations o ON o.org_id = i.org_id
                                     WHERE i.image_id = ? AND o.user_id = ?`, [imageId, id]);
      if (!im) return res.redirect(`/nonprofits/${id}?error=Photo+not+found`);
      await db.runAsync('DELETE FROM org_images WHERE image_id = ?', [imageId]);
      await uploads.removeFiles(appConfig, im.path);
      console.log(`[nonprofits] ${req.session.user.username} removed photo #${imageId} of user #${id}`);
      res.redirect(`/nonprofits/${id}?msg=Photo+removed.`);
    } catch (err) {
      res.redirect(`/nonprofits/${id}?error=` + encodeURIComponent('Remove failed: ' + (err.message || err)));
    }
  });

  // Delete everything that belongs to the account. Children are removed
  // explicitly (remote SQLite has no FK enforcement); beneficiary links
  // from events / raffles are nulled (the event keeps the name text).
  router.post('/nonprofits/:id/delete', requireAdmin, async (req, res) => {
    const id = kit.idParam(req.params.id);
    if (!id) return res.redirect('/nonprofits?error=Invalid+id');
    try {
      const u = await db.getAsync('SELECT user_id, login_name FROM users WHERE user_id = ?', [id]);
      if (!u) return res.redirect('/nonprofits?error=Account+not+found');
      const o = await db.getAsync('SELECT org_id, name FROM organizations WHERE user_id = ?', [id]);
      const paths = o ? (await db.allAsync('SELECT path FROM org_images WHERE org_id = ?', [o.org_id])).map(r => r.path) : [];
      await db.transaction(async (tx) => {
        if (o) {
          await tx.runAsync('UPDATE event_beneficiaries SET org_id = NULL WHERE org_id = ?', [o.org_id]);
          await tx.runAsync('UPDATE raffles SET beneficiary_org_id = NULL WHERE beneficiary_org_id = ?', [o.org_id]);
          await tx.runAsync('UPDATE raffle_beneficiaries SET org_id = NULL WHERE org_id = ?', [o.org_id]);
          await tx.runAsync('DELETE FROM org_images WHERE org_id = ?', [o.org_id]);
          await tx.runAsync('DELETE FROM org_contacts WHERE org_id = ?', [o.org_id]);
          await tx.runAsync('DELETE FROM org_categories WHERE org_id = ?', [o.org_id]);
          await tx.runAsync('DELETE FROM org_cities WHERE org_id = ?', [o.org_id]);
          await tx.runAsync('DELETE FROM organizations WHERE org_id = ?', [o.org_id]);
        }
        await tx.runAsync('DELETE FROM email_verification_tokens WHERE user_id = ?', [id]);
        await tx.runAsync('DELETE FROM password_reset_tokens WHERE user_id = ?', [id]);
        await tx.runAsync('DELETE FROM users WHERE user_id = ?', [id]);
      });
      await uploads.removeFiles(appConfig, paths);
      const label = (o && o.name) || u.login_name;
      console.log(`[nonprofits] ${req.session.user.username} deleted user #${id} (${label}), ${paths.length} photo file(s)`);
      res.redirect('/nonprofits?msg=' + encodeURIComponent(`"${label}" deleted.`));
    } catch (err) {
      console.error('[nonprofits] delete failed:', err);
      res.redirect(`/nonprofits/${id}?error=` + encodeURIComponent('Delete failed: ' + (err.message || err)));
    }
  });

  return router;
};
