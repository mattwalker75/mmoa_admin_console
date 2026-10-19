// routes/members.js — the web app's member accounts (the `users` table).
//
//   GET  /members                     → list + client-side search / sort / status filter
//   POST /members/create              → insert a member
//   GET  /members/:id                 → detail (profile, outstanding links, lockouts)
//   POST /members/:id/update          → edit name / login / email / phone / active / verified
//   POST /members/:id/verify          → mark verified (state=1) or unverified (state=0)
//   POST /members/:id/reset-password  → set a new password (bcrypt cost 10, like the web app)
//   POST /members/:id/delete          → delete the account and its tokens
//
// Ported from car_show_admin_console/routes/admin.js (the Customers pages),
// adapted to the mmoa_web_app schema: every account is a member — there are
// no roles (and no business name / credit / deployments) — and email
// verification gates web-app login. THIS console is the admin surface; its
// own operators live in local_admins.json, not in the users table.
//
// Every DB query is wrapped in safeGet / safeAll (or a try/catch) so the
// pages render a "Database unavailable" banner instead of crashing when the
// web app's database is unreachable. Timestamps written here use sqlTime()
// — a JS-computed UTC 'YYYY-MM-DD HH:MM:SS' string, the same format the web
// app writes — so nothing depends on SQLite-only datetime() or MySQL NOW().

const express = require('express');
const { page, flash } = require('../views/layout');
const { escapeHtml, jsAttrStr } = require('../views/escapeHtml');
const { requireAdmin, hashPassword, getPasswordRules, validatePassword } = require('../middleware/auth');

function dbBanner(err) {
  if (!err) return '';
  return `<div class="flash-error mb-6">
    <strong class="font-semibold">Database unavailable.</strong>
    ${escapeHtml(err.message || 'unknown error')}. Some data on this page could not be loaded.
  </div>`;
}

function pageHeader(title, subtitle) {
  return `<header class="flex items-start justify-between mb-8">
    <div>
      <h1 class="text-2xl font-bold text-slate-900 dark:text-slate-100">${escapeHtml(title)}</h1>
      ${subtitle ? `<p class="mt-1 text-sm text-slate-500 dark:text-slate-400">${escapeHtml(subtitle)}</p>` : ''}
    </div>
  </header>`;
}

async function safeGet(db, sql, params, fallback) {
  try { return { value: await db.getAsync(sql, params), err: null }; }
  catch (err) { return { value: fallback, err }; }
}
async function safeAll(db, sql, params) {
  try { return { rows: await db.allAsync(sql, params), err: null }; }
  catch (err) { return { rows: [], err }; }
}

// Portable UTC 'YYYY-MM-DD HH:MM:SS' timestamp — same scheme as the web
// app's sqlTime helper, so values written here compare correctly against
// values written there on both SQLite (TEXT) and MySQL (DATETIME).
function sqlTime(msFromNow = 0) {
  return new Date(Date.now() + msFromNow).toISOString().replace('T', ' ').replace(/\..+/, '');
}

// Map a UNIQUE-constraint failure to a readable message. SQLite reports
// "UNIQUE constraint failed: users.email" (or the NOCASE index name for
// login_name); MySQL reports "Duplicate entry … for key 'users.email'".
function uniqueMessage(err) {
  const m = String((err && err.message) || '');
  if (/UNIQUE|Duplicate entry/i.test(m)) {
    if (/email/i.test(m)) return 'Email is already in use';
    if (/login/i.test(m)) return 'Login name is already taken';
    return 'Login name or email is already in use';
  }
  return null;
}

// Login names are case-insensitive in the web app (NOCASE index on SQLite,
// _ci collation on MySQL); emails are stored lowercased. Check both up front
// so the operator gets a clear message rather than an index-name error.
// `exceptId` skips the member being edited.
async function findConflict(db, login_name, email, exceptId) {
  const row = await db.getAsync(
    `SELECT user_id, login_name, email FROM users
      WHERE (LOWER(login_name) = LOWER(?) OR LOWER(email) = LOWER(?))
        AND user_id <> ?
      LIMIT 1`,
    [login_name, email, exceptId || 0]);
  if (!row) return null;
  if (String(row.login_name || '').toLowerCase() === login_name.toLowerCase()) return 'Login name is already taken';
  return 'Email is already in use';
}

// Create-member modal. Toggled by the outer x-data="{ openCreate: ... }" on
// the members page. All interactive form state (auto-gen login, password
// visibility, verification toggle, etc.) lives in the modal card's own
// x-data scope; $watch('openCreate', ...) resets it on every open.
function createMemberModal(minPasswordLength) {
  return `
    <div x-show="openCreate" x-transition x-cloak
         x-on:keydown.escape.window="openCreate = false"
         class="fixed inset-0 z-40 flex items-center justify-center p-4 bg-black/60 overflow-y-auto"
         x-on:click.self="openCreate = false">
      <div class="card surface-target card-pad w-full max-w-2xl my-8"
           x-data="{
             firstName: '',
             lastName: '',
             autoLogin: true,
             loginName: '',
             loginRandom: Math.floor(Math.random() * 100000),
             email: '',
             createPassword: true,
             password: '',
             passwordConfirm: '',
             showPassword: false,
             emailVerified: true,
             reset() {
               this.firstName = '';
               this.lastName = '';
               this.autoLogin = true;
               this.loginName = '';
               this.loginRandom = Math.floor(Math.random() * 100000);
               this.email = '';
               this.createPassword = true;
               this.password = '';
               this.passwordConfirm = '';
               this.showPassword = false;
               this.emailVerified = true;
             }
           }"
           x-init="$watch('openCreate', v => { if (v) reset(); })"
           x-effect="
             const f = (firstName || '').toLowerCase().replace(/[^a-z0-9]/g, '');
             const l = (lastName  || '').toLowerCase().replace(/[^a-z0-9]/g, '');
             if (autoLogin) {
               const parts = [];
               if (f) parts.push(f);
               if (l) parts.push(l);
               parts.push(loginRandom);
               loginName = parts.join('.');
             }
           ">
        <h2 class="text-lg font-semibold text-slate-900 dark:text-slate-100">Create member</h2>
        <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">New row in the web app's <code class="font-mono">users</code> table. Login name (case-insensitive) and email must be unique.</p>

        <form method="POST" action="/members/create" class="mt-5 space-y-4"
              x-on:submit="if (createPassword && password !== passwordConfirm) { $event.preventDefault(); window.uiConfirm('The two passwords do not match.', { title: 'Check the password', confirmLabel: 'OK', danger: false }); }">
          <input type="hidden" name="create_password" :value="createPassword ? '1' : '0'">
          <input type="hidden" name="email_verified"  :value="emailVerified  ? '1' : '0'">

          <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label class="label" for="cm-first">First name *</label>
              <input id="cm-first" class="input" type="text" name="first_name" required maxlength="100" x-model="firstName">
            </div>
            <div>
              <label class="label" for="cm-last">Last name *</label>
              <input id="cm-last" class="input" type="text" name="last_name" required maxlength="100" x-model="lastName">
            </div>

            <div class="sm:col-span-2">
              <div class="flex items-center justify-between">
                <label class="label" for="cm-login">Login name *</label>
                <label class="inline-flex items-center gap-2 text-xs text-slate-600 dark:text-slate-300">
                  <input type="checkbox" x-model="autoLogin" class="h-4 w-4">
                  Auto-generate
                </label>
              </div>
              <input id="cm-login" class="input" type="text" name="login_name" required maxlength="100"
                     x-model="loginName" :readonly="autoLogin"
                     :class="autoLogin ? 'opacity-70 cursor-not-allowed' : ''">
              <p class="mt-1 text-xs text-slate-500" x-show="autoLogin">
                Pattern: <code class="font-mono">first.last.&lt;random&gt;</code> — edit first/last to update.
              </p>
            </div>

            <div class="sm:col-span-2">
              <label class="label" for="cm-email">Email *</label>
              <input id="cm-email" class="input" type="email" name="email" required maxlength="255" autocomplete="off" x-model="email">
            </div>

            <div>
              <label class="label" for="cm-phone">Phone number</label>
              <input id="cm-phone" class="input" type="tel" name="phone_number" maxlength="40">
            </div>

            <div class="flex flex-col gap-2 pt-6">
              <label class="inline-flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200">
                <input type="checkbox" name="is_active" value="1" checked class="h-4 w-4">
                Active
              </label>
              <label class="inline-flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200">
                <input type="checkbox" x-model="emailVerified" class="h-4 w-4">
                Email verified <span class="text-xs text-slate-500">(unverified members can't sign in)</span>
              </label>
            </div>
          </div>

          <div class="border-t border-slate-200 dark:border-slate-700 pt-4">
            <label class="inline-flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200">
              <input type="checkbox" x-model="createPassword" class="h-4 w-4">
              Set a password <span class="text-xs text-slate-500">(uncheck to create a no-login account; the member can use "Forgot password" later)</span>
            </label>

            <template x-if="createPassword">
              <div class="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label class="label" for="cm-pw">Password *</label>
                  <div class="flex items-stretch gap-2">
                    <input id="cm-pw" class="input flex-1" :type="showPassword ? 'text' : 'password'"
                           name="password" :required="createPassword" minlength="${minPasswordLength}"
                           autocomplete="new-password" x-model="password">
                    <button type="button" class="btn-secondary text-xs px-3"
                            x-on:click="showPassword = !showPassword"
                            x-text="showPassword ? 'Hide' : 'Show'"></button>
                  </div>
                </div>
                <div>
                  <label class="label" for="cm-pw2">Confirm password *</label>
                  <input id="cm-pw2" class="input" :type="showPassword ? 'text' : 'password'"
                         name="password_confirm" :required="createPassword" minlength="${minPasswordLength}"
                         autocomplete="new-password" x-model="passwordConfirm">
                  <p class="mt-1 text-xs text-red-600 dark:text-red-300"
                     x-show="password && passwordConfirm && password !== passwordConfirm">
                    Passwords do not match
                  </p>
                </div>
              </div>
            </template>
          </div>

          <div class="flex justify-end gap-2 pt-2">
            <button type="button" class="btn-secondary" x-on:click="openCreate = false">Cancel</button>
            <button type="submit" class="btn-primary">Create member</button>
          </div>
        </form>
      </div>
    </div>
  `;
}

// Reset-password modal for the member detail page. Toggled by the outer
// x-data flag `openReset`. Two inputs + Show/Hide, equality validated
// client-side before submit (and again server-side).
function resetPasswordModal(memberId, minPasswordLength) {
  return `
    <div x-show="openReset" x-transition x-cloak
         x-on:keydown.escape.window="openReset = false"
         class="fixed inset-0 z-40 flex items-center justify-center p-4 bg-black/60 overflow-y-auto"
         x-on:click.self="openReset = false">
      <div class="card surface-target card-pad w-full max-w-md my-8"
           x-data="{
             password: '',
             passwordConfirm: '',
             showPassword: false,
             reset() {
               this.password = '';
               this.passwordConfirm = '';
               this.showPassword = false;
             }
           }"
           x-init="$watch('openReset', v => { if (v) reset(); })">
        <h2 class="text-lg font-semibold text-slate-900 dark:text-slate-100">Reset password</h2>
        <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">Sets a new password for this member (bcrypt, same hashing as the web app). Takes effect immediately; any outstanding password-reset links are invalidated.</p>

        <form method="POST" action="/members/${memberId}/reset-password" class="mt-5 space-y-4"
              x-on:submit="if (password !== passwordConfirm) { $event.preventDefault(); window.uiConfirm('The two passwords do not match.', { title: 'Check the password', confirmLabel: 'OK', danger: false }); }">
          <div>
            <label class="label" for="rp-pw">New password *</label>
            <div class="flex items-stretch gap-2">
              <input id="rp-pw" class="input flex-1" :type="showPassword ? 'text' : 'password'"
                     name="password" required minlength="${minPasswordLength}"
                     autocomplete="new-password" x-model="password">
              <button type="button" class="btn-secondary text-xs px-3"
                      x-on:click="showPassword = !showPassword"
                      x-text="showPassword ? 'Hide' : 'Show'"></button>
            </div>
          </div>
          <div>
            <label class="label" for="rp-pw2">Confirm password *</label>
            <input id="rp-pw2" class="input" :type="showPassword ? 'text' : 'password'"
                   name="password_confirm" required minlength="${minPasswordLength}"
                   autocomplete="new-password" x-model="passwordConfirm">
            <p class="mt-1 text-xs text-red-600 dark:text-red-300"
               x-show="password && passwordConfirm && password !== passwordConfirm">
              Passwords do not match
            </p>
          </div>
          <div class="flex justify-end gap-2 pt-2">
            <button type="button" class="btn-secondary" x-on:click="openReset = false">Cancel</button>
            <button type="submit" class="btn-primary">Reset password</button>
          </div>
        </form>
      </div>
    </div>
  `;
}

// Modify-member modal. Same field set as Create, seeded from the
// record via data-* attributes on the modal card (sidesteps HTML attribute
// quoting on names like "O'Brien"). The password is changed separately via
// Reset password.
function modifyMemberModal(m) {
  const dataAttrs = [
    `data-first-name="${escapeHtml(m.first_name || '')}"`,
    `data-last-name="${escapeHtml(m.last_name || '')}"`,
    `data-login-name="${escapeHtml(m.login_name || '')}"`,
    `data-email="${escapeHtml(m.email || '')}"`,
    `data-phone-number="${escapeHtml(m.phone_number || '')}"`,
    `data-is-active="${Number(m.is_active) ? '1' : '0'}"`,
    `data-email-verified="${m.email_verified_at ? '1' : '0'}"`
  ].join(' ');

  return `
    <div x-show="openModify" x-transition x-cloak
         x-on:keydown.escape.window="openModify = false"
         class="fixed inset-0 z-40 flex items-center justify-center p-4 bg-black/60 overflow-y-auto"
         x-on:click.self="openModify = false">
      <div class="card surface-target card-pad w-full max-w-2xl my-8"
           ${dataAttrs}
           x-data="{
             firstName: '', lastName: '', loginName: '', email: '', phoneNumber: '',
             isActive: false, emailVerified: false,
             seed() {
               const d = $el.dataset;
               this.firstName     = d.firstName;
               this.lastName      = d.lastName;
               this.loginName     = d.loginName;
               this.email         = d.email;
               this.phoneNumber   = d.phoneNumber;
               this.isActive      = d.isActive === '1';
               this.emailVerified = d.emailVerified === '1';
             }
           }"
           x-init="seed(); $watch('openModify', v => { if (v) seed(); })">
        <h2 class="text-lg font-semibold text-slate-900 dark:text-slate-100">Modify member</h2>
        <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">Editing user <code class="font-mono">#${Number(m.user_id)}</code>. Login name and email must remain unique.</p>

        <form method="POST" action="/members/${Number(m.user_id)}/update" class="mt-5 space-y-4">
          <input type="hidden" name="email_verified" :value="emailVerified ? '1' : '0'">
          <input type="hidden" name="is_active"      :value="isActive      ? '1' : '0'">

          <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label class="label" for="mm-first">First name *</label>
              <input id="mm-first" class="input" type="text" name="first_name" required maxlength="100" x-model="firstName">
            </div>
            <div>
              <label class="label" for="mm-last">Last name *</label>
              <input id="mm-last" class="input" type="text" name="last_name" required maxlength="100" x-model="lastName">
            </div>
            <div>
              <label class="label" for="mm-login">Login name *</label>
              <input id="mm-login" class="input" type="text" name="login_name" required maxlength="100" x-model="loginName">
            </div>
            <div>
              <label class="label" for="mm-email">Email *</label>
              <input id="mm-email" class="input" type="email" name="email" required maxlength="255" autocomplete="off" x-model="email">
            </div>
            <div>
              <label class="label" for="mm-phone">Phone number</label>
              <input id="mm-phone" class="input" type="tel" name="phone_number" maxlength="40" x-model="phoneNumber">
            </div>
            <div class="sm:col-span-2 flex flex-wrap items-center gap-x-6 gap-y-2">
              <label class="inline-flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200">
                <input type="checkbox" x-model="isActive" class="h-4 w-4">
                Active
              </label>
              <label class="inline-flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200">
                <input type="checkbox" x-model="emailVerified" class="h-4 w-4">
                Email verified
              </label>
            </div>
          </div>

          <div class="flex justify-end gap-2 pt-2">
            <button type="button" class="btn-secondary" x-on:click="openModify = false">Cancel</button>
            <button type="submit" class="btn-primary">Save changes</button>
          </div>
        </form>
      </div>
    </div>
  `;
}

// Read + validate the common profile fields from a create / update body.
// Returns { fields } or { error }.
function readProfile(b) {
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

module.exports = function (db, appConfig) {
  const router = express.Router();

  // ── Member list ───────────────────────────────────────────────────────
  // The row data is serialized into JSON on the wrapper element so Alpine
  // can drive search filtering, the status filter and column sorting
  // client-side without re-hitting the server on each keystroke. At a men's
  // group's scale (hundreds of rows) the inline approach is fine.
  router.get('/members', requireAdmin, async (req, res) => {
    const user = req.session.user;
    const autoOpenCreate = req.query.create === '1';
    const { rows, err } = await safeAll(db, `
      SELECT user_id, login_name, email, first_name, last_name, phone_number,
             is_active, email_verified_at, created_at, last_login_at
        FROM users
       ORDER BY LOWER(first_name), LOWER(last_name), user_id
    `);
    const members = rows.map(u => {
      const name = [u.first_name, u.last_name].filter(Boolean).join(' ');
      return {
        id: u.user_id,
        name,
        email: u.email || '',
        login: u.login_name || '',
        phone: u.phone_number || '',
        active: !!Number(u.is_active),
        verified: !!u.email_verified_at,
        created: u.created_at ? String(u.created_at) : '',
        last_login: u.last_login_at ? String(u.last_login_at) : '',
        search: [name, u.email, u.login_name, u.phone_number].filter(Boolean).join(' ').toLowerCase()
      };
    });
    const membersJson = escapeHtml(JSON.stringify(members));
    const minLen = getPasswordRules(appConfig).minLength;
    const emptyMsg = err ? 'Unavailable.' : 'No members yet.';
    const body = `
      <div data-members="${membersJson}"
           x-data="{
             openCreate: ${autoOpenCreate ? 'true' : 'false'},
             members: [],
             query: '',
             status: '',
             sortKey: 'name',
             sortDir: 'asc',
             init() {
               this.members = JSON.parse(this.$el.dataset.members);
             },
             get visible() {
               const q = this.query.trim().toLowerCase();
               let arr = this.members.slice();
               if (q) arr = arr.filter(m => m.search.includes(q));
               if (this.status === 'unverified') arr = arr.filter(m => !m.verified);
               if (this.status === 'inactive') arr = arr.filter(m => !m.active);
               const dir = this.sortDir === 'asc' ? 1 : -1;
               const k = this.sortKey;
               arr.sort((a, b) => {
                 const av = (a[k] || '').toString().toLowerCase();
                 const bv = (b[k] || '').toString().toLowerCase();
                 if (av < bv) return -1 * dir;
                 if (av > bv) return 1 * dir;
                 return 0;
               });
               return arr;
             },
             toggleSort(key) {
               if (this.sortKey === key) {
                 this.sortDir = this.sortDir === 'asc' ? 'desc' : 'asc';
               } else {
                 this.sortKey = key;
                 this.sortDir = 'asc';
               }
             },
             sortIcon(key) {
               if (this.sortKey !== key) return '';
               return this.sortDir === 'asc' ? '▲' : '▼';
             }
           }">
        <header class="flex items-start justify-between mb-6 gap-4">
          <div>
            <h1 class="text-2xl font-bold text-slate-900 dark:text-slate-100">Members</h1>
            <p class="mt-1 text-sm text-slate-500 dark:text-slate-400">Accounts in the web app's database. Click a row to view, edit, verify, reset the password, or delete.</p>
          </div>
          <button type="button" class="btn-primary" x-on:click="openCreate = true">
            <span aria-hidden="true">＋</span>
            <span>Create member</span>
          </button>
        </header>

        ${flash('error', req.query.error)}
        ${flash('success', req.query.msg)}
        ${dbBanner(err)}

        <div class="mb-4 flex flex-wrap items-center gap-3">
          <input class="input max-w-md" type="text"
                 placeholder="Search by name, email, login, or phone…"
                 autocomplete="off"
                 x-model="query">
          <select class="input max-w-[12rem]" x-model="status" aria-label="Status">
            <option value="">Any status</option>
            <option value="unverified">Unverified only</option>
            <option value="inactive">Inactive only</option>
          </select>
          <span class="text-xs text-slate-500 dark:text-slate-400" x-text="visible.length + ' of ' + members.length"></span>
        </div>

        <div class="table-wrap surface-target">
          <table class="table-base">
            <thead>
              <tr>
                <th class="cursor-pointer select-none" x-on:click="toggleSort('name')">
                  Name <span class="text-xs text-slate-400 ml-1" x-text="sortIcon('name')"></span>
                </th>
                <th class="cursor-pointer select-none" x-on:click="toggleSort('email')">
                  Email <span class="text-xs text-slate-400 ml-1" x-text="sortIcon('email')"></span>
                </th>
                <th class="cursor-pointer select-none" x-on:click="toggleSort('login')">
                  Login <span class="text-xs text-slate-400 ml-1" x-text="sortIcon('login')"></span>
                </th>
                <th>Status</th>
                <th class="cursor-pointer select-none" x-on:click="toggleSort('created')">
                  Created <span class="text-xs text-slate-400 ml-1" x-text="sortIcon('created')"></span>
                </th>
                <th class="cursor-pointer select-none" x-on:click="toggleSort('last_login')">
                  Last login <span class="text-xs text-slate-400 ml-1" x-text="sortIcon('last_login')"></span>
                </th>
              </tr>
            </thead>
            <tbody>
              <template x-for="m in visible" :key="m.id">
                <tr class="cursor-pointer" x-on:click="window.location = '/members/' + m.id">
                  <td class="font-medium text-slate-900 dark:text-slate-100" x-text="m.name || '—'"></td>
                  <td x-text="m.email"></td>
                  <td class="font-mono text-xs text-slate-500" x-text="m.login || '—'"></td>
                  <td class="space-x-1 whitespace-nowrap">
                    <span x-show="m.verified" class="pill-running">Verified</span>
                    <span x-show="!m.verified" class="pill-pending">Unverified</span>
                    <span x-show="!m.active" class="pill-failed">Inactive</span>
                  </td>
                  <td class="text-slate-500 text-xs whitespace-nowrap" x-text="m.created || '—'"></td>
                  <td class="text-slate-500 text-xs whitespace-nowrap" x-text="m.last_login || '—'"></td>
                </tr>
              </template>
              <tr x-show="!visible.length">
                <td colspan="6" class="text-center py-8 text-slate-400">
                  <span x-show="query || status">No matching members.</span>
                  <span x-show="!query && !status">${emptyMsg}</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        ${createMemberModal(minLen)}
      </div>
    `;
    res.send(page({ title: 'Members', body, appConfig, user, activeNav: 'members' }));
  });

  // POST /members/create — insert a new row into the web app's `users` table.
  // Behaviour notes:
  //   * email_verified=1   → email_verified_at = sqlTime() (UTC, the web
  //                          app's format). Unverified members can't sign in.
  //   * create_password=0  → password_hash is the literal 'no_login' — not a
  //                          valid bcrypt hash, so the login flow can never
  //                          authenticate it (bcrypt.compare returns false).
  //                          The member can still set one via Forgot password.
  //   * created_at         → DB default (CURRENT_TIMESTAMP).
  router.post('/members/create', requireAdmin, async (req, res) => {
    const b = req.body || {};
    const { fields: f, error } = readProfile(b);
    if (error) return res.redirect('/members?error=' + encodeURIComponent(error));
    const is_active = b.is_active ? 1 : 0;
    const email_verified_at = b.email_verified === '1' ? sqlTime() : null;

    let password_hash;
    if (b.create_password === '1') {
      const password = b.password || '';
      if (password !== (b.password_confirm || '')) return res.redirect('/members?error=Passwords+do+not+match');
      const pwErr = validatePassword(password, getPasswordRules(appConfig));
      if (pwErr) return res.redirect('/members?error=' + encodeURIComponent(pwErr));
      try {
        password_hash = await hashPassword(password);
      } catch (err) {
        console.error('[members] password hash failed:', err);
        return res.redirect('/members?error=Password+hashing+failed');
      }
    } else {
      password_hash = 'no_login';
    }

    try {
      const conflict = await findConflict(db, f.login_name, f.email, 0);
      if (conflict) return res.redirect('/members?error=' + encodeURIComponent(conflict));
      const r = await db.runAsync(`
        INSERT INTO users (
          login_name, email, first_name, last_name, phone_number,
          password_hash, is_active, email_verified_at, last_login_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
      `, [f.login_name, f.email, f.first_name, f.last_name, f.phone_number,
          password_hash, is_active, email_verified_at]);
      console.log(`[members] ${req.session.user.username} created member ${f.login_name}${r && r.lastID ? ' #' + r.lastID : ''}`);
      res.redirect('/members?msg=' + encodeURIComponent(`Member "${f.login_name}" created.`));
    } catch (err) {
      console.error('[members] create failed:', err);
      res.redirect('/members?error=' + encodeURIComponent(uniqueMessage(err) || ('Create failed: ' + (err.message || 'unknown error'))));
    }
  });

  // ── Member detail ─────────────────────────────────────────────────────
  router.get('/members/:id', requireAdmin, async (req, res) => {
    const user = req.session.user;
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0 || String(id) !== req.params.id) {
      return res.redirect('/members?error=Invalid+member+id');
    }
    const { value: m, err: mErr } = await safeGet(db,
      `SELECT user_id, login_name, email, first_name, last_name, phone_number,
              is_active, email_verified_at, created_at, last_login_at
         FROM users WHERE user_id = ?`, [id], null);

    if (mErr) {
      return res.send(page({
        title: 'Member',
        body: `${pageHeader('Member', null)}${dbBanner(mErr)}<p><a class="text-brand-600 hover:underline" href="/members">← Back to members</a></p>`,
        appConfig, user, activeNav: 'members'
      }));
    }
    if (!m) {
      return res.status(404).send(page({
        title: 'Member not found',
        body: `${pageHeader('Member not found', null)}
          <p class="text-slate-500 dark:text-slate-400">No member with id <code class="font-mono">${id}</code>.</p>
          <p class="mt-4"><a class="text-brand-600 hover:underline" href="/members">← Back to members</a></p>`,
        appConfig, user, activeNav: 'members'
      }));
    }
    const fullName = [m.first_name, m.last_name].filter(Boolean).join(' ');

    // Outstanding (unconsumed, unexpired) single-use links. sqlTime() is
    // compared against the same-format expires_at the web app writes.
    const now = sqlTime();
    const { value: vRow, err: vErr } = await safeGet(db,
      'SELECT COUNT(*) AS c FROM email_verification_tokens WHERE user_id = ? AND consumed_at IS NULL AND expires_at > ?', [id, now], { c: null });
    const { value: pRow, err: pErr } = await safeGet(db,
      'SELECT COUNT(*) AS c FROM password_reset_tokens WHERE user_id = ? AND consumed_at IS NULL AND expires_at > ?', [id, now], { c: null });
    // Lockout rows that name this account (by login or email, lowercased —
    // the web app keys account lockouts on the lowercased identifier).
    const { rows: lockRows, err: lErr } = await safeAll(db,
      `SELECT id, scope, scope_key, fail_count, locked_until_ms FROM login_lockouts
        WHERE scope <> 'ip' AND (LOWER(scope_key) = LOWER(?) OR LOWER(scope_key) = LOWER(?))`,
      [m.login_name || '', m.email || '']);
    const firstErr = vErr || pErr || lErr || null;
    const nowMs = Date.now();
    const lockedNow = lockRows.filter(l => l.locked_until_ms != null && Number(l.locked_until_ms) > nowMs);

    function field(label, value) {
      return `<div>
        <div class="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400">${escapeHtml(label)}</div>
        <div class="mt-0.5 text-sm font-medium text-slate-900 dark:text-slate-100">${value}</div>
      </div>`;
    }

    const verifiedBadge = m.email_verified_at
      ? `<span class="pill-running">Verified</span>`
      : `<span class="pill-pending">Unverified</span>`;
    const activeBadge = Number(m.is_active)
      ? `<span class="pill-running">Active</span>`
      : `<span class="pill-failed">Inactive</span>`;
    const who = fullName || m.login_name || ('#' + id);
    const verifyForm = m.email_verified_at
      ? `<form method="POST" action="/members/${id}/verify" class="m-0"
              x-on:submit.prevent="window.uiConfirmSubmit($event.target, ${jsAttrStr('Mark ' + who + ' as UNVERIFIED? They will not be able to sign in until they verify their email again.')}, { title: 'Mark unverified', confirmLabel: 'Mark unverified' })">
           <input type="hidden" name="state" value="0">
           <button type="submit" class="btn-secondary text-sm">Mark unverified</button>
         </form>`
      : `<form method="POST" action="/members/${id}/verify" class="m-0">
           <input type="hidden" name="state" value="1">
           <button type="submit" class="btn-secondary text-sm">Mark verified</button>
         </form>`;

    const minLen = getPasswordRules(appConfig).minLength;
    const body = `
      <div x-data="{ openReset: false, openModify: false }">
        <div class="mb-4">
          <a class="text-sm text-brand-600 hover:underline" href="/members">← Back to members</a>
        </div>

        <header class="flex items-start justify-between gap-4 mb-8">
          <div>
            <h1 class="text-2xl font-bold text-slate-900 dark:text-slate-100">${escapeHtml(fullName || '(no name)')}</h1>
            <div class="mt-1 flex items-center gap-2 text-sm text-slate-500 dark:text-slate-400">
              <span>${escapeHtml(m.email || '')}</span>
              <span>·</span>
              ${activeBadge}
              ${verifiedBadge}
            </div>
          </div>
          <div class="flex items-center gap-2 flex-wrap justify-end">
            ${verifyForm}
            <button type="button" class="btn-secondary text-sm" x-on:click="openReset = true">Reset password</button>
            <button type="button" class="btn-secondary text-sm" x-on:click="openModify = true">Modify member</button>
            <form method="POST" action="/members/${id}/delete" class="m-0"
                  x-on:submit.prevent="window.uiConfirmSubmit($event.target, ${jsAttrStr('Delete member ' + who + '? Their account and any outstanding verification / reset links are removed. This cannot be undone.')}, { title: 'Delete member', confirmLabel: 'Delete' })">
              <button type="submit" class="btn-danger text-sm">Delete member</button>
            </form>
          </div>
        </header>

        ${flash('error', req.query.error)}
        ${flash('success', req.query.msg)}
        ${dbBanner(firstErr)}

        <div class="grid lg:grid-cols-3 gap-6">
          <section class="lg:col-span-2 card surface-target card-pad">
            <h2 class="text-sm font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-4">Profile</h2>
            <div class="grid sm:grid-cols-2 gap-4">
              ${field('Login', escapeHtml(m.login_name || '—'))}
              ${field('User ID', `<span class="font-mono">${id}</span>`)}
              ${field('Name', escapeHtml(fullName || '—'))}
              ${field('Email', escapeHtml(m.email || '—'))}
              ${field('Phone', escapeHtml(m.phone_number || '—'))}
              ${field('Created', escapeHtml(m.created_at ? String(m.created_at) : '—'))}
              ${field('Last login', escapeHtml(m.last_login_at ? String(m.last_login_at) : '—'))}
              ${field('Verified', m.email_verified_at ? escapeHtml(String(m.email_verified_at)) : 'No')}
              ${field('Status', Number(m.is_active) ? 'Active' : 'Inactive')}
            </div>
            <p class="mt-6 text-xs text-slate-500 dark:text-slate-400">The raw row is also editable under <a class="text-brand-600 hover:underline" href="/data/users/row?key=${encodeURIComponent(JSON.stringify({ user_id: id }))}">Data Browser → users</a> (the password hash stays read-only there).</p>
          </section>

          <div class="space-y-6">
            <section class="card surface-target card-pad">
              <h2 class="text-sm font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-3">Outstanding links</h2>
              <div class="flex items-center justify-between text-sm">
                <span class="text-slate-700 dark:text-slate-200">Email verification</span>
                <span class="font-semibold">${vRow && vRow.c != null ? Number(vRow.c) : '—'}</span>
              </div>
              <div class="mt-2 flex items-center justify-between text-sm">
                <span class="text-slate-700 dark:text-slate-200">Password reset</span>
                <span class="font-semibold">${pRow && pRow.c != null ? Number(pRow.c) : '—'}</span>
              </div>
              <p class="mt-3 text-xs text-slate-500 dark:text-slate-400">Unused, unexpired single-use links. Marking the member verified or resetting the password invalidates the matching links.</p>
            </section>

            <section class="card surface-target card-pad">
              <h2 class="text-sm font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-3">Login lockout</h2>
              ${lockedNow.length
                ? `<p class="text-sm"><span class="pill-failed">Locked</span> after ${lockedNow.map(l => Number(l.fail_count) || 0).join(', ')} failed attempt(s).</p>
                   <p class="mt-2 text-xs"><a class="text-brand-600 hover:underline" href="/locked-users">Unlock under Locked Users →</a></p>`
                : `<p class="text-sm text-slate-500 dark:text-slate-400">Not locked.</p>`}
            </section>
          </div>
        </div>

        ${resetPasswordModal(id, minLen)}
        ${modifyMemberModal(m)}
      </div>
    `;
    res.send(page({ title: fullName || 'Member', body, appConfig, user, activeNav: 'members' }));
  });

  // POST /members/:id/reset-password — set a new password. Re-validates
  // equality and the configured password policy server-side; bcrypt cost 10
  // (middleware/auth.hashPassword — identical to the web app's hashing).
  // Outstanding reset links are consumed so an old emailed link can't
  // override the password the operator just set.
  router.post('/members/:id/reset-password', requireAdmin, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) return res.redirect('/members?error=Invalid+member+id');
    const b = req.body || {};
    const password = b.password || '';
    if (password !== (b.password_confirm || '')) return res.redirect(`/members/${id}?error=Passwords+do+not+match`);
    const pwErr = validatePassword(password, getPasswordRules(appConfig));
    if (pwErr) return res.redirect(`/members/${id}?error=` + encodeURIComponent(pwErr));

    try {
      const password_hash = await hashPassword(password);
      const r = await db.runAsync('UPDATE users SET password_hash = ? WHERE user_id = ?', [password_hash, id]);
      if (!r.changes) return res.redirect('/members?error=Member+not+found');
      await db.runAsync('UPDATE password_reset_tokens SET consumed_at = ? WHERE user_id = ? AND consumed_at IS NULL', [sqlTime(), id])
        .catch(e => console.warn('[members] could not consume reset tokens:', e.message || e));
      console.log(`[members] ${req.session.user.username} reset the password of member #${id}`);
      res.redirect(`/members/${id}?msg=Password+reset.`);
    } catch (err) {
      console.error('[members] reset password failed:', err);
      res.redirect(`/members/${id}?error=` + encodeURIComponent('Reset failed: ' + (err.message || 'unknown error')));
    }
  });

  // POST /members/:id/verify — state=1 marks verified (stamps "now" unless a
  // timestamp already exists, and consumes outstanding verification links);
  // state=0 clears email_verified_at so the member must verify again.
  router.post('/members/:id/verify', requireAdmin, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) return res.redirect('/members?error=Invalid+member+id');
    const verified = (req.body && req.body.state) === '1';
    try {
      const r = verified
        ? await db.runAsync('UPDATE users SET email_verified_at = COALESCE(email_verified_at, ?) WHERE user_id = ?', [sqlTime(), id])
        : await db.runAsync('UPDATE users SET email_verified_at = NULL WHERE user_id = ?', [id]);
      if (!r.changes) return res.redirect('/members?error=Member+not+found');
      if (verified) {
        await db.runAsync('UPDATE email_verification_tokens SET consumed_at = ? WHERE user_id = ? AND consumed_at IS NULL', [sqlTime(), id])
          .catch(e => console.warn('[members] could not consume verification tokens:', e.message || e));
      }
      res.redirect(`/members/${id}?msg=` + encodeURIComponent(verified ? 'Marked verified.' : 'Marked unverified.'));
    } catch (err) {
      console.error('[members] verify toggle failed:', err);
      res.redirect(`/members/${id}?error=` + encodeURIComponent('Update failed: ' + (err.message || 'unknown error')));
    }
  });

  // POST /members/:id/update — edit an existing member. Email verification:
  // '1' preserves the existing email_verified_at timestamp if there is one,
  // or stamps "now" if there isn't; '0' clears the column to NULL.
  router.post('/members/:id/update', requireAdmin, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) return res.redirect('/members?error=Invalid+member+id');
    const b = req.body || {};
    const { fields: f, error } = readProfile(b);
    if (error) return res.redirect(`/members/${id}?error=` + encodeURIComponent(error));
    const is_active = b.is_active === '1' ? 1 : 0;
    const verified = b.email_verified === '1';

    const sets = [
      'login_name = ?', 'email = ?', 'first_name = ?', 'last_name = ?',
      'phone_number = ?', 'is_active = ?',
      verified ? 'email_verified_at = COALESCE(email_verified_at, ?)' : 'email_verified_at = NULL'
    ];
    const params = [f.login_name, f.email, f.first_name, f.last_name, f.phone_number, is_active];
    if (verified) params.push(sqlTime());
    params.push(id);

    try {
      const conflict = await findConflict(db, f.login_name, f.email, id);
      if (conflict) return res.redirect(`/members/${id}?error=` + encodeURIComponent(conflict));
      const r = await db.runAsync(`UPDATE users SET ${sets.join(', ')} WHERE user_id = ?`, params);
      if (!r.changes) return res.redirect('/members?error=Member+not+found');
      res.redirect(`/members/${id}?msg=Member+saved.`);
    } catch (err) {
      console.error('[members] update failed:', err);
      res.redirect(`/members/${id}?error=` + encodeURIComponent(uniqueMessage(err) || ('Update failed: ' + (err.message || 'unknown error'))));
    }
  });

  // POST /members/:id/delete — hard-delete a member.
  //
  // The token tables declare ON DELETE CASCADE, but the children are deleted
  // explicitly in the same transaction anyway: SQLite only enforces foreign
  // keys when the connection turned them on, and the remote-SQLite backend
  // (one sqlite3 process per statement) never does. Lockout rows are keyed
  // by name, not user_id, so they are left for Locked Users to manage.
  router.post('/members/:id/delete', requireAdmin, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) return res.redirect('/members?error=Invalid+member+id');
    try {
      const existing = await db.getAsync('SELECT user_id, login_name FROM users WHERE user_id = ?', [id]);
      if (!existing) return res.redirect('/members?error=Member+not+found');
      await db.transaction(async (tx) => {
        await tx.runAsync('DELETE FROM email_verification_tokens WHERE user_id = ?', [id]);
        await tx.runAsync('DELETE FROM password_reset_tokens WHERE user_id = ?', [id]);
        await tx.runAsync('DELETE FROM users WHERE user_id = ?', [id]);
      });
      console.log(`[members] ${req.session.user.username} deleted member #${id} (${existing.login_name})`);
      res.redirect('/members?msg=' + encodeURIComponent(`Member "${existing.login_name}" deleted.`));
    } catch (err) {
      console.error('[members] delete failed:', err);
      res.redirect(`/members/${id}?error=` + encodeURIComponent('Delete failed: ' + (err.message || 'unknown error')));
    }
  });

  return router;
};
