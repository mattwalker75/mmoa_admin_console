// routes/nonprofits.js — nonprofit accounts and their "Need Help?" directory
// profiles (the web app's `users` + `organizations` tables and the org_*
// children). Replaces the v1 Members page: the only people with web-app
// logins are other nonprofits, each with exactly one organization profile.
//
//   GET  /nonprofits                        → list + search + status / listing filters
//   GET  /nonprofits/new, POST /nonprofits  → create a login + organization from the console
//                                             (temporary password shown once on the next page)
//   GET  /nonprofits/:id                    → whole profile (incl. hidden fields + photos),
//                                             account, verification, IRS / ProPublica panel
//   GET  /nonprofits/:id/propublica         → JSON: server-side ProPublica lookup of the EIN
//   GET/POST /nonprofits/:id/profile        → edit the organization profile — every field the
//                                             org can edit in its portal, validated the same way
//   POST /nonprofits/:id/hidden             → state=1 hide from / state=0 show in the directory
//                                             (organizations.admin_hidden — MMoA's override)
//   POST /nonprofits/:id/preview            → JSON { url }: a ~30-minute preview link to the
//                                             profile page whatever its status (Preview pop-up)
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
// Only `verified` + listed + not admin-hidden organizations appear in the
// public directory; the web app never shows the EIN or fields the org marked
// hidden. The console sees everything. The web app caches the directory for
// 20 s (helpers/orgCache.js), so a change made here shows within that.
//
// Edit profile validates EXACTLY like the portal's PUT /api/portal/org
// (mmoa_web_app/routes/portal.js): same normalizers (helpers/formats.js is a
// verbatim copy of the web app's), same length limits, ZIP / contact rules
// and error messages. Create uses the sign-up rules (routes/api.js).
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
const preview = require('../helpers/sitePreview');
const fmt = require('../helpers/formats');
const { markdownField, TEXTAREA_CLS } = require('./events');

const STATUS_PILL = { verified: 'pill-running', unverified: 'pill-pending', rejected: 'pill-failed' };
const STATUS_LABEL = { verified: 'Verified', unverified: 'Pending verification', rejected: 'Rejected' };
const DEFAULT_PUBLIC = ['address', 'phone', 'public_email', 'website_url', 'facebook_url', 'instagram_url',
  'other_social_url', 'description', 'hours', 'what_to_bring', 'contacts', 'images', 'service_cities', 'categories'];
const PUBLIC_FIELD_LABELS = {
  address: 'Address', phone: 'Phone', public_email: 'Public email', website_url: 'Website', facebook_url: 'Facebook',
  instagram_url: 'Instagram', other_social_url: 'Other link', description: 'Description', hours: 'Hours',
  what_to_bring: 'What to bring', contacts: 'Contacts', images: 'Photos', service_cities: 'Cities served', categories: 'Services'
};
// The portal's rules (mmoa_web_app/routes/portal.js).
const ZIP_RE = /^\d{5}(-\d{4})?$/;
const MAX_CONTACTS = 10;
// The sign-up rules (mmoa_web_app/routes/api.js).
const NAME_RE = /^[\p{L}\p{M} .,'-]{1,100}$/u;
const EMAIL_STRICT_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const LOGIN_NAME_RE = /^[A-Za-z0-9._-]{3,30}$/;
const PHONE_RE = /^[0-9+().\- ]{7,32}$/;
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

// ── Edit profile ────────────────────────────────────────────────────────
// The form's values: from the stored rows (profileValues) or echoed back
// from a rejected post (valuesFromBody). Arrays: categories = slugs,
// city_ids = numbers, public_fields = keys; contacts_json = the contacts
// editor's JSON.
const toArr = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
const TEXT_KEYS = ['name', 'ein', 'address_line1', 'address_line2', 'city', 'state', 'zip', 'phone', 'phone_ext', 'public_email',
  'website_url', 'facebook_url', 'instagram_url', 'other_social_url', 'description_md', 'hours', 'what_to_bring', 'search_tags'];

function contactsJson(rows) {
  return JSON.stringify((rows || []).map(c => ({
    name: c.name || '', role: c.role || '', email: c.email || '', phone: c.phone || '', phone_ext: c.phone_ext || '',
    is_public: Number(c.is_public) === 1 || c.is_public === true
  })));
}

function profileValues(o, contacts, catSlugs, cityIds) {
  const v = {};
  for (const k of TEXT_KEYS) v[k] = o[k] == null ? '' : String(o[k]);
  v.categories = catSlugs.map(String);
  v.city_ids = cityIds.map(Number);
  v.public_fields = parsePublicFields(o.public_fields);
  v.is_listed = Number(o.is_listed) === 1;
  v.contacts_json = contactsJson(contacts);
  return v;
}

function valuesFromBody(b) {
  const v = {};
  // A non-string (a repeated field) is kept as it came so readProfile rejects
  // it with the portal's "… must be text" instead of a comma-joined value.
  // The form posts the name as org_name (middleware/inputLimits.js caps a
  // field called `name` at 100 — an organization name may be 200).
  for (const k of TEXT_KEYS) { const raw = b[k === 'name' ? 'org_name' : k]; v[k] = raw == null ? '' : typeof raw === 'string' ? raw.replace(/\r\n?/g, '\n') : raw; }
  v.categories = toArr(b.categories).map(String);
  v.city_ids = toArr(b.city_ids).map(Number).filter(Number.isInteger);
  v.public_fields = toArr(b.pf).map(String).filter(k => DEFAULT_PUBLIC.includes(k));
  v.is_listed = kit.yes(b.is_listed);
  // contacts_json: what to echo back into the editor (normalized), and
  // whether it could be read at all (an unreadable list must not save as
  // "no contacts").
  v.contacts_json = '[]'; v.contacts_unreadable = false;
  try {
    if (b.contacts_json != null && typeof b.contacts_json !== 'string') throw new Error('not text');
    const a = JSON.parse(b.contacts_json || '[]');
    if (!Array.isArray(a)) throw new Error('not a list');
    v.contacts_json = contactsJson(a.slice(0, 50));
  } catch (e) { v.contacts_unreadable = true; }
  return v;
}

// The portal's validation, line for line (routes/portal.js PUT /org): the
// same `str` helper, limits, normalizers and messages. Returns { set,
// contacts, categorySlugs, cityIds } or throws BadInput. `cur` is the stored
// row (EIN compare).
class BadInput extends Error { constructor(msg) { super(msg); this.status = 400; } }
function pstr(body, key, max, { required = false, label = key } = {}) {
  const v = body[key];
  if (v != null && typeof v !== 'string') throw new BadInput(`${label} must be text`);
  const s = (v || '').trim();
  if (required && !s) throw new BadInput(`${label} is required`);
  if (s.length > max) throw new BadInput(`${label} must be ${max} characters or less`);
  return s;
}
function readProfile(v, cur) {
  const set = {};
  const name = pstr(v, 'name', 200, { required: true, label: 'Organization name' });
  if (name.length < 2) throw new BadInput('Organization name is too short');
  set.name = name;
  // Blank keeps the stored EIN (as in the portal, where the field is optional
  // in the body); an admin may change it at any status.
  const einRaw = String(v.ein || '').trim();
  if (einRaw) {
    const ein = fmt.normalizeEin(einRaw);
    if (!ein) throw new BadInput('EIN must be 9 digits (for example 12-3456789)');
    if (ein !== (cur.ein || '')) set.ein = ein;
  }
  for (const [k, max, label] of [['address_line1', 200, 'Address'], ['address_line2', 200, 'Address line 2'],
    ['city', 100, 'City'], ['hours', 1000, 'Hours'], ['what_to_bring', 2000, 'What to bring'],
    ['description_md', 5000, 'Description']]) {
    set[k] = pstr(v, k, max, { label }) || null;
  }
  const st = fmt.normalizeState(pstr(v, 'state', 40, { label: 'State' }));
  if (!st) throw new BadInput('Please pick a valid US state (for example TX)');
  set.state = st;
  const zip = pstr(v, 'zip', 10, { label: 'ZIP' });
  if (zip && !ZIP_RE.test(zip)) throw new BadInput('ZIP must be 5 digits (or ZIP+4)');
  set.zip = zip || null;
  const phone = fmt.formatPhone(pstr(v, 'phone', 32, { label: 'Phone' }));
  if (phone === null) throw new BadInput('Phone must be a 10-digit US number, like (972) 555-0100');
  set.phone = phone || null;
  const ext = fmt.normalizeExt(pstr(v, 'phone_ext', 10, { label: 'Extension' }));
  if (ext === null) throw new BadInput('Extension must be 1–6 digits');
  set.phone_ext = ext || null;
  if (!set.phone) set.phone_ext = null; // an extension means nothing without the number
  const em = fmt.normalizeEmail(pstr(v, 'public_email', 255, { label: 'Public email' }));
  if (em === null) throw new BadInput('Public email must look like name@example.org');
  set.public_email = em || null;
  for (const [k, norm, msg] of [
    ['website_url', fmt.normalizeUrl, 'Website must be a web address like https://example.org'],
    ['facebook_url', fmt.normalizeFacebook, 'Facebook must be a Facebook page, like facebook.com/yourpage'],
    ['instagram_url', fmt.normalizeInstagram, 'Instagram must be an Instagram account, like instagram.com/yourname or @yourname'],
    ['other_social_url', fmt.normalizeUrl, 'Other link must be a web address like https://example.org']]) {
    if (v[k] != null && typeof v[k] !== 'string') throw new BadInput('Links must be text');
    const u = norm(v[k]);
    if (u === null) throw new BadInput(msg);
    set[k] = u || null;
  }
  if (v.search_tags != null && typeof v.search_tags !== 'string') throw new BadInput('Search keywords must be text');
  const tags = fmt.normalizeSearchTags(String(v.search_tags || '').slice(0, 4000));
  if (tags === null) throw new BadInput(`Search keywords: up to ${fmt.MAX_TAGS}, each up to ${fmt.MAX_TAG_LEN} characters`);
  set.search_tags = tags || null;
  if (!Array.isArray(v.public_fields)) throw new BadInput('public_fields must be a list');
  set.public_fields = JSON.stringify(DEFAULT_PUBLIC.filter(k => v.public_fields.includes(k)));
  set.is_listed = v.is_listed ? 1 : 0;

  if (v.contacts_unreadable) throw new BadInput('Contacts could not be read — reload the page and try again.');
  let rows;
  try { rows = JSON.parse(v.contacts_json || '[]'); } catch (e) { throw new BadInput('Contacts could not be read — reload the page and try again.'); }
  if (!Array.isArray(rows)) throw new BadInput('contacts must be a list');
  if (rows.length > MAX_CONTACTS) throw new BadInput(`Up to ${MAX_CONTACTS} contacts`);
  const contacts = [];
  for (const c of rows) {
    if (!c || typeof c !== 'object') throw new BadInput('Bad contact entry');
    const cname = pstr(c, 'name', 200, { label: 'Contact name' });
    const role = pstr(c, 'role', 200, { label: 'Contact role' });
    const emailRaw = pstr(c, 'email', 255, { label: 'Contact email' });
    const phoneRaw = pstr(c, 'phone', 32, { label: 'Contact phone' });
    const cext = fmt.normalizeExt(pstr(c, 'phone_ext', 10, { label: 'Contact extension' }));
    const email = fmt.normalizeEmail(emailRaw);
    const cphone = fmt.formatPhone(phoneRaw);
    if (!cname && !role && !emailRaw && !phoneRaw) continue; // blank row
    if (!cname) throw new BadInput('Each contact needs a name');
    if (email === null) throw new BadInput(`Contact email for ${cname} must look like name@example.org`);
    if (cphone === null) throw new BadInput(`Contact phone for ${cname} must be a 10-digit US number`);
    if (cext === null) throw new BadInput(`Contact extension for ${cname} must be 1–6 digits`);
    contacts.push({ name: cname, role: role || null, email: email || null, phone: cphone || null, phone_ext: (cphone && cext) || null, is_public: c.is_public ? 1 : 0 });
  }
  if (!Array.isArray(v.categories) || v.categories.length > 50) throw new BadInput('categories must be a list');
  if (!Array.isArray(v.city_ids) || v.city_ids.length > 100) throw new BadInput('city_ids must be a list');
  return { set, contacts, categorySlugs: v.categories.map(String), cityIds: v.city_ids.map(Number) };
}

// Alpine contacts editor (posts contacts_json) — same shape as
// helpers/beneficiaries.js. The portal's rules per row: a name is required
// once anything is filled in; email / phone / extension are normalized on
// save; Public = shown on the website (when "Contacts" is public too).
function contactsEditor(json) {
  return `<div data-contacts="${escapeHtml(json || '[]')}"
       x-data="{ rows: [],
         init() { this.rows = JSON.parse(this.$el.dataset.contacts || '[]').map(c => ({ name: c.name || '', role: c.role || '', email: c.email || '', phone: c.phone || '', phone_ext: c.phone_ext || '', is_public: !!c.is_public })); },
         add() { if (this.rows.length < ${MAX_CONTACTS}) this.rows.push({ name: '', role: '', email: '', phone: '', phone_ext: '', is_public: false }); },
         remove(i) { this.rows.splice(i, 1); },
         move(i, d) { const j = i + d; if (j < 0 || j >= this.rows.length) return; const t = this.rows[i]; this.rows[i] = this.rows[j]; this.rows[j] = t; },
         get json() { return JSON.stringify(this.rows); } }">
    <input type="hidden" name="contacts_json" :value="json">
    <div class="flex items-center justify-between">
      <span class="label mb-0">Contacts <span class="text-xs font-normal text-slate-400">(up to ${MAX_CONTACTS})</span></span>
      <button type="button" class="btn-secondary text-xs px-3 py-1" x-on:click="add()" :disabled="rows.length >= ${MAX_CONTACTS}">＋ Add contact</button>
    </div>
    <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">People to reach at the organization. Each needs a name; "Public" shows that person on the website (when Contacts is public below).</p>
    <div class="mt-3 space-y-2">
      <template x-for="(c, i) in rows" :key="i">
        <div class="grid grid-cols-2 md:grid-cols-12 gap-2 items-center rounded-lg border border-slate-200 dark:border-slate-700 p-2">
          <input class="input md:col-span-3" type="text" maxlength="200" x-model="c.name" placeholder="Name *" aria-label="Contact name">
          <input class="input md:col-span-2" type="text" maxlength="200" x-model="c.role" placeholder="Role" aria-label="Role">
          <input class="input md:col-span-3" type="text" inputmode="email" maxlength="255" x-model="c.email" placeholder="Email" aria-label="Email">
          <input class="input md:col-span-2" type="tel" maxlength="32" x-model="c.phone" placeholder="Phone" aria-label="Phone">
          <input class="input md:col-span-1" type="text" inputmode="numeric" maxlength="10" x-model="c.phone_ext" placeholder="Ext." aria-label="Extension">
          <div class="md:col-span-1 col-span-2 flex items-center justify-end gap-1">
            <label class="inline-flex items-center gap-1 text-xs text-slate-600 dark:text-slate-300 mr-1"><input type="checkbox" class="h-4 w-4" x-model="c.is_public"> Public</label>
            <button type="button" class="btn-ghost text-xs px-2 py-1" x-on:click="move(i, -1)" aria-label="Move up">▲</button>
            <button type="button" class="btn-ghost text-xs px-2 py-1" x-on:click="move(i, 1)" aria-label="Move down">▼</button>
            <button type="button" class="btn-ghost text-xs px-2 py-1 text-red-600" x-on:click="remove(i)" aria-label="Remove">✕</button>
          </div>
        </div>
      </template>
      <p x-show="!rows.length" class="text-sm text-slate-400 italic">No contacts.</p>
    </div>
  </div>`;
}

// The Edit profile form. pickers: { categories: [{category_id, slug, name}],
// cities: [{city_id, name}] } (active ones only — what the portal offers).
function profileForm(action, backHref, v, pickers, status) {
  const val = (k) => escapeHtml(typeof v[k] === 'string' ? v[k] : '');
  // name = the posted field; extra.key = the values key when it differs
  const text = (id, name, label, max, extra) => `<div ${extra && extra.wrap ? extra.wrap : ''}>
      <label class="label" for="${id}">${escapeHtml(label)}${extra && extra.req ? ' *' : ''}${extra && extra.hintInline ? ` <span class="text-xs font-normal text-slate-400">${extra.hintInline}</span>` : ''}</label>
      <input id="${id}" class="input${extra && extra.cls ? ' ' + extra.cls : ''}" type="${(extra && extra.type) || 'text'}" name="${name}" maxlength="${max}" value="${val((extra && extra.key) || name)}"${extra && extra.req ? ' required' : ''}${extra && extra.ph ? ` placeholder="${escapeHtml(extra.ph)}"` : ''}${extra && extra.list ? ` list="${extra.list}"` : ''}${extra && extra.mode ? ` inputmode="${extra.mode}"` : ''}${extra && extra.mask ? ` x-on:input="$el.value = window.${extra.mask}($el.value)"` : ''} autocomplete="off">
      ${extra && extra.hint ? `<p class="mt-1 text-xs text-slate-500 dark:text-slate-400">${extra.hint}</p>` : ''}
    </div>`;
  const catSet = new Set(v.categories.map(String)), citySet = new Set(v.city_ids.map(Number)), pf = new Set(v.public_fields);
  const tiles = pickers.categories.length ? pickers.categories.map(c => `
        <label class="flex items-center gap-2 rounded-lg border border-slate-200 dark:border-slate-700 px-3 py-2 text-sm cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/60">
          <input type="checkbox" class="h-4 w-4" name="categories" value="${escapeHtml(c.slug)}" ${catSet.has(String(c.slug)) ? 'checked' : ''}> ${escapeHtml(c.name)}</label>`).join('')
    : '<p class="text-sm text-slate-400 italic">No active categories — add some under Categories &amp; Cities.</p>';
  const cityBoxes = pickers.cities.length ? pickers.cities.map(c => `
        <label class="inline-flex items-center gap-2 text-sm mr-4 mb-2"><input type="checkbox" class="h-4 w-4" name="city_ids" value="${Number(c.city_id)}" ${citySet.has(Number(c.city_id)) ? 'checked' : ''}> ${escapeHtml(c.name)}</label>`).join('')
    : '<p class="text-sm text-slate-400 italic">No active cities — add some under Categories &amp; Cities.</p>';
  const states = fmt.US_STATES.map(([code, name]) => `<option value="${code}">${escapeHtml(name)}</option>`).join('');
  return `<form method="POST" action="${action}" class="space-y-6" x-data x-on:input="window.mmoaFormDirty = true">
    <section class="card surface-target card-pad space-y-4">
      <h2 class="text-sm font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">Organization</h2>
      <div class="grid sm:grid-cols-2 gap-4">
        ${text('pf-name', 'org_name', 'Organization name', 200, { req: true, key: 'name' })}
        ${text('pf-ein', 'ein', 'EIN', 10, { cls: 'font-mono', ph: '12-3456789', mode: 'numeric', mask: 'typeEin',
          hint: `9 digits — the dash is added for you. ${status === 'unverified' ? 'The organization can still change it in its portal until it is reviewed.' : 'The organization can no longer change it (reviewed) — only the console can.'} Leave blank to keep the stored EIN.` })}
      </div>
    </section>
    <section class="card surface-target card-pad space-y-4">
      <h2 class="text-sm font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">Address</h2>
      <div class="grid sm:grid-cols-2 gap-4">
        ${text('pf-addr1', 'address_line1', 'Address line 1', 200)}
        ${text('pf-addr2', 'address_line2', 'Address line 2', 200)}
        ${text('pf-city', 'city', 'City', 100)}
        <div class="grid grid-cols-2 gap-4">
          ${text('pf-state', 'state', 'State', 40, { list: 'pf-states', hint: 'USPS code, e.g. TX' })}
          ${text('pf-zip', 'zip', 'ZIP', 10, { mode: 'numeric', ph: '75409', hint: '5 digits, or ZIP+4' })}
        </div>
        <datalist id="pf-states">${states}</datalist>
      </div>
    </section>
    <section class="card surface-target card-pad space-y-4">
      <h2 class="text-sm font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">Contact</h2>
      <div class="grid sm:grid-cols-2 gap-4">
        <div class="grid grid-cols-3 gap-4">
          ${text('pf-phone', 'phone', 'Phone', 32, { type: 'tel', wrap: 'class="col-span-2"', ph: '(972) 555-0100', hint: '10-digit US number' })}
          ${text('pf-ext', 'phone_ext', 'Ext.', 10, { mode: 'numeric', hint: '1–6 digits' })}
        </div>
        ${text('pf-email', 'public_email', 'Public email', 255, { mode: 'email', ph: 'help@example.org' })}
      </div>
    </section>
    <section class="card surface-target card-pad space-y-4">
      <h2 class="text-sm font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">Links</h2>
      <div class="grid sm:grid-cols-2 gap-4">
        ${text('pf-web', 'website_url', 'Website', 500, { mode: 'url', ph: 'https://example.org', hint: 'https:// is added when missing' })}
        ${text('pf-fb', 'facebook_url', 'Facebook', 500, { mode: 'url', ph: 'facebook.com/yourpage', hint: 'A Facebook page link, or just the page name' })}
        ${text('pf-ig', 'instagram_url', 'Instagram', 500, { mode: 'url', ph: '@yourname', hint: 'An Instagram link or @handle' })}
        ${text('pf-other', 'other_social_url', 'Other link', 500, { mode: 'url', ph: 'https://…' })}
      </div>
    </section>
    <section class="card surface-target card-pad space-y-4">
      <h2 class="text-sm font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">About</h2>
      ${markdownField('description_md', 'Description (up to 5,000 characters)', typeof v.description_md === 'string' ? v.description_md : '', 8)}
      <div class="grid sm:grid-cols-2 gap-4">
        <div>
          <label class="label" for="pf-hours">Hours <span class="text-xs font-normal text-slate-400">(up to 1,000 characters)</span></label>
          <textarea id="pf-hours" name="hours" rows="4" maxlength="1000" class="${TEXTAREA_CLS}" placeholder="Mon–Fri 9am–4pm">${val('hours')}</textarea>
        </div>
        <div>
          <label class="label" for="pf-bring">What to bring <span class="text-xs font-normal text-slate-400">(one item per line, up to 2,000 characters)</span></label>
          <textarea id="pf-bring" name="what_to_bring" rows="4" maxlength="2000" class="${TEXTAREA_CLS}" placeholder="Photo ID&#10;Proof of address">${val('what_to_bring')}</textarea>
        </div>
      </div>
      <div>
        <label class="label" for="pf-tags">Search keywords <span class="text-xs font-normal text-slate-400">(private — only the "Need Help?" keyword search uses them; comma-separated, up to ${fmt.MAX_TAGS} of ${fmt.MAX_TAG_LEN} characters)</span></label>
        <textarea id="pf-tags" name="search_tags" rows="2" maxlength="4000" class="${TEXTAREA_CLS}" placeholder="food bank, groceries, snap">${val('search_tags')}</textarea>
      </div>
    </section>
    <section class="card surface-target card-pad space-y-4">
      <h2 class="text-sm font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">Services</h2>
      <p class="text-xs text-slate-500 dark:text-slate-400">The categories visitors browse by. Only active categories are offered (Categories &amp; Cities).</p>
      <div class="grid sm:grid-cols-2 md:grid-cols-3 gap-2">${tiles}</div>
    </section>
    <section class="card surface-target card-pad space-y-3">
      <h2 class="text-sm font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">Cities served</h2>
      <div>${cityBoxes}</div>
    </section>
    <section class="card surface-target card-pad">
      ${contactsEditor(v.contacts_json)}
    </section>
    <section class="card surface-target card-pad space-y-4">
      <h2 class="text-sm font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">Visibility</h2>
      <label class="flex items-center gap-3 text-sm font-medium text-slate-700 dark:text-slate-200">
        <span class="toggle"><input type="checkbox" name="is_listed" value="1" ${v.is_listed ? 'checked' : ''}><span class="slider"></span></span>
        Listed in "Need Help?" <span class="text-xs font-normal text-slate-400">(the organization's own switch — off hides the whole profile)</span>
      </label>
      <p class="text-xs text-slate-500 dark:text-slate-400">Ticked = shown on the public profile. The name is always public; the EIN and search keywords never are.</p>
      <div class="grid grid-cols-2 md:grid-cols-4 gap-2">
        ${DEFAULT_PUBLIC.map(k => `<label class="inline-flex items-center gap-2 text-sm"><input type="checkbox" class="h-4 w-4" name="pf" value="${k}" ${pf.has(k) ? 'checked' : ''}> ${escapeHtml(PUBLIC_FIELD_LABELS[k] || k)}</label>`).join('')}
      </div>
    </section>
    <div class="flex items-center justify-end gap-2">
      <a class="btn-secondary" href="${backHref}">Cancel</a>
      <button type="submit" class="btn-primary">Save profile</button>
    </div>
  </form>`;
}

// ── Create ──────────────────────────────────────────────────────────────
function readNew(b) {
  const f = {
    login_name: String(b.login_name || '').trim(),
    email: String(b.email || '').trim().toLowerCase(),
    first_name: String(b.first_name || '').trim(),
    last_name: String(b.last_name || '').trim(),
    phone_number: String(b.phone_number || '').trim() || null,
    org_name: String(b.org_name || '').trim(),
    ein: String(b.ein || '').trim(),
    password: String(b.password || ''),
    password_confirm: String(b.password_confirm || ''),
    email_verified: kit.yes(b.email_verified),
    org_verified: kit.yes(b.org_verified)
  };
  if (!f.org_name || !f.login_name || !f.first_name || !f.last_name || !f.email || !f.password) return { fields: f, error: 'All required fields must be filled' };
  if (f.org_name.length < 2 || f.org_name.length > 200 || /[<>]/.test(f.org_name)) return { fields: f, error: "Please enter the organization's name (2–200 characters)" };
  if (f.ein) {
    const ein = fmt.normalizeEin(f.ein);
    if (!ein) return { fields: f, error: 'EIN must be 9 digits (for example 12-3456789)' };
    f.ein = ein;
  }
  if (!LOGIN_NAME_RE.test(f.login_name)) return { fields: f, error: 'Login name must be 3–30 characters using letters, numbers, and . _ - only' };
  if (!NAME_RE.test(f.first_name) || !NAME_RE.test(f.last_name)) return { fields: f, error: "Names may only contain letters, spaces, and . , ' -" };
  if (f.phone_number && !PHONE_RE.test(f.phone_number)) return { fields: f, error: 'Please enter a valid phone number' };
  if (!EMAIL_STRICT_RE.test(f.email)) return { fields: f, error: 'Please enter a valid email address' };
  if (f.password.length > 128) return { fields: f, error: 'Password must be 128 characters or less' };
  if (f.password !== f.password_confirm) return { fields: f, error: 'The two passwords do not match' };
  return { fields: f };
}

function newForm(v, minLen) {
  const val = (k) => escapeHtml(v[k] || '');
  return `<form method="POST" action="/nonprofits" class="space-y-6" autocomplete="off" x-data
        x-on:submit="const a = $el.querySelector('[name=password]').value, b = $el.querySelector('[name=password_confirm]').value; if (a !== b) { $event.preventDefault(); window.uiConfirm('The two passwords do not match.', { title: 'Check the password', confirmLabel: 'OK', danger: false }); }">
    <section class="card surface-target card-pad space-y-4">
      <h2 class="text-sm font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">Organization</h2>
      <div class="grid sm:grid-cols-2 gap-4">
        <div><label class="label" for="nn-org">Organization name *</label><input id="nn-org" class="input" type="text" name="org_name" required maxlength="200" value="${val('org_name')}"></div>
        <div><label class="label" for="nn-ein">EIN <span class="text-xs font-normal text-slate-400">(optional here; sign-up requires it)</span></label><input id="nn-ein" class="input font-mono" type="text" inputmode="numeric" name="ein" maxlength="10" placeholder="12-3456789" value="${val('ein')}" x-on:input="$el.value = window.typeEin($el.value)">
          <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">9 digits — the dash is added for you.</p></div>
      </div>
    </section>
    <section class="card surface-target card-pad space-y-4">
      <h2 class="text-sm font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">Login account</h2>
      <p class="text-xs text-slate-500 dark:text-slate-400">The same rules as the website's sign-up. First / last name are the organization's primary contact person.</p>
      <div class="grid sm:grid-cols-2 gap-4">
        <div><label class="label" for="nn-login">Login name *</label><input id="nn-login" class="input" type="text" name="login_name" required minlength="3" maxlength="30" pattern="[A-Za-z0-9._\\-]{3,30}" value="${val('login_name')}">
          <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">3–30 characters: letters, numbers, . _ -</p></div>
        <div><label class="label" for="nn-email">Email *</label><input id="nn-email" class="input" type="email" name="email" required maxlength="255" value="${val('email')}"></div>
        <div><label class="label" for="nn-first">First name *</label><input id="nn-first" class="input" type="text" name="first_name" required maxlength="100" value="${val('first_name')}"></div>
        <div><label class="label" for="nn-last">Last name *</label><input id="nn-last" class="input" type="text" name="last_name" required maxlength="100" value="${val('last_name')}"></div>
        <div><label class="label" for="nn-phone">Phone number</label><input id="nn-phone" class="input" type="tel" name="phone_number" maxlength="32" value="${val('phone_number')}"></div>
        <div class="sm:col-span-2 grid sm:grid-cols-2 gap-4" x-data="{ pw: '', pw2: '', show: true,
              gen() { const u = 'ABCDEFGHJKLMNPQRSTUVWXYZ', l = 'abcdefghijkmnpqrstuvwxyz', d = '23456789', s = '!@#$%&*?', all = u + l + d + s;
                const pick = (set) => set[crypto.getRandomValues(new Uint32Array(1))[0] % set.length];
                const a = [pick(u), pick(l), pick(d), pick(s)]; while (a.length < 14) a.push(pick(all));
                for (let i = a.length - 1; i > 0; i--) { const j = crypto.getRandomValues(new Uint32Array(1))[0] % (i + 1); [a[i], a[j]] = [a[j], a[i]]; }
                this.pw = a.join(''); this.pw2 = this.pw; this.show = true; } }">
         <div>
          <label class="label" for="nn-pw">Temporary password *</label>
          <div class="flex items-stretch gap-2">
            <input id="nn-pw" class="input flex-1 font-mono" :type="show ? 'text' : 'password'" name="password" required minlength="${minLen}" maxlength="128" autocomplete="new-password" x-model="pw">
            <button type="button" class="btn-secondary text-xs px-3" x-on:click="gen()">Generate</button>
            <button type="button" class="btn-secondary text-xs px-3" x-on:click="show = !show" x-text="show ? 'Hide' : 'Show'"></button>
          </div>
          <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">At least ${minLen} characters (the console's password rules). It is shown once more on the next page — pass it to the organization; they can change it after signing in.</p>
         </div>
         <div>
          <label class="label" for="nn-pw2">Confirm password *</label>
          <input id="nn-pw2" class="input font-mono" :type="show ? 'text' : 'password'" name="password_confirm" required minlength="${minLen}" maxlength="128" autocomplete="new-password" x-model="pw2">
          <p class="mt-1 text-xs text-red-600 dark:text-red-300" x-show="pw && pw2 && pw !== pw2">Passwords do not match</p>
          <p class="mt-1 text-xs text-slate-500 dark:text-slate-400" x-show="!(pw && pw2 && pw !== pw2)">Type it again (Generate fills both).</p>
         </div>
        </div>
      </div>
    </section>
    <section class="card surface-target card-pad space-y-3">
      <h2 class="text-sm font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">Verification</h2>
      <label class="flex items-start gap-2 text-sm"><input type="checkbox" class="h-4 w-4 mt-0.5" name="email_verified" value="1" ${v.email_verified ? 'checked' : ''}>
        <span>Mark the email address as verified <span class="block text-xs text-slate-500 dark:text-slate-400">Otherwise the login is refused until the organization verifies it (use "Resend email" on the site, or Mark email verified here later).</span></span></label>
      <label class="flex items-start gap-2 text-sm"><input type="checkbox" class="h-4 w-4 mt-0.5" name="org_verified" value="1" ${v.org_verified ? 'checked' : ''}>
        <span>Mark the organization as verified (skips the Verify step) <span class="block text-xs text-slate-500 dark:text-slate-400">It appears in the public "Need Help?" directory right away, listed, with every field public. Otherwise it starts Pending verification.</span></span></label>
    </section>
    <div class="flex items-center justify-end gap-2">
      <a class="btn-secondary" href="/nonprofits">Cancel</a>
      <button type="submit" class="btn-primary">Create nonprofit</button>
    </div>
  </form>`;
}

module.exports = function (db, appConfig) {
  const router = express.Router();
  const audit = require('../helpers/audit')(db);
  // Org name (or the login name) for an audit row's label; null if unknown.
  const orgLabel = (id) => db.getAsync(`SELECT u.login_name, o.name FROM users u LEFT JOIN organizations o ON o.user_id = u.user_id WHERE u.user_id = ?`, [id])
    .then(r => (r && (r.name || r.login_name)) || null).catch(() => null);

  // v1 URLs (bookmarks, old docs) → the page that replaced Members.
  router.get(['/members', '/members/*rest'], requireAdmin, (req, res) => res.redirect(301, '/nonprofits'));

  // ── List ────────────────────────────────────────────────────────────
  router.get('/nonprofits', requireAdmin, async (req, res) => {
    const user = req.session.user;
    const { rows, err } = await kit.safeAll(db, `
      SELECT u.user_id, u.login_name, u.email, u.first_name, u.last_name, u.is_active, u.email_verified_at,
             u.created_at, u.last_login_at, o.org_id, o.name AS org_name, o.ein, o.city, o.verification_status, o.is_listed, o.admin_hidden
        FROM users u LEFT JOIN organizations o ON o.user_id = u.user_id
       ORDER BY u.created_at DESC, u.user_id DESC`, []);
    const list = rows.map(r => {
      const contact = [r.first_name, r.last_name].filter(Boolean).join(' ');
      const status = r.org_id ? (r.verification_status || 'unverified') : 'no-org';
      return {
        id: r.user_id, name: r.org_name || '', ein: r.ein || '', contact, login: r.login_name || '', email: r.email || '',
        status, listed: r.org_id ? !!Number(r.is_listed) : false, adminHidden: r.org_id ? !!Number(r.admin_hidden) : false, active: !!Number(r.is_active),
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
               if (this.listing === 'admin-hidden') a = a.filter(r => r.adminHidden);
               if (this.account === 'inactive') a = a.filter(r => !r.active);
               if (this.account === 'email-unverified') a = a.filter(r => !r.emailVerified);
               const d = this.sortDir === 'asc' ? 1 : -1, k = this.sortKey;
               a.sort((x, y) => { const p = String(x[k] || '').toLowerCase(), q2 = String(y[k] || '').toLowerCase(); return p < q2 ? -d : p > q2 ? d : 0; });
               return a;
             },
             sortBy(k) { if (this.sortKey === k) this.sortDir = this.sortDir === 'asc' ? 'desc' : 'asc'; else { this.sortKey = k; this.sortDir = 'asc'; } },
             icon(k) { return this.sortKey !== k ? '' : (this.sortDir === 'asc' ? '▲' : '▼'); } }">
        ${kit.pageHeader('Nonprofits', 'Organizations with a login on the website. Verify them here before they appear in the public "Need Help?" directory.',
          '<a class="btn-primary" href="/nonprofits/new">New nonprofit</a>')}
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
            <option value="admin-hidden">Hidden by MMoA</option>
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
              <th class="cursor-pointer select-none" x-on:click="sortBy('login')">Login <span class="text-xs text-slate-400" x-text="icon('login')"></span></th>
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
                  <td class="font-mono text-xs" x-text="r.login || '—'"></td>
                  <td class="text-xs" x-text="r.email"></td>
                  <td class="space-x-1 whitespace-nowrap">
                    <span x-show="r.status === 'verified'" class="pill-running">Verified</span>
                    <span x-show="r.status === 'unverified'" class="pill-pending">Pending</span>
                    <span x-show="r.status === 'rejected'" class="pill-failed">Rejected</span>
                    <span x-show="r.status === 'no-org'" class="pill-terminated">No profile</span>
                    <span x-show="r.status !== 'no-org' && !r.listed" class="pill-terminated">Hidden</span>
                    <span x-show="r.adminHidden" class="pill-failed">Hidden by MMoA</span>
                    <span x-show="!r.active" class="pill-failed">Inactive</span>
                    <span x-show="!r.emailVerified" class="pill-pending">Email unverified</span>
                  </td>
                  <td class="text-slate-500 text-xs whitespace-nowrap" x-text="r.created || '—'"></td>
                </tr>
              </template>
              <tr x-show="!visible.length"><td colspan="7" class="text-center py-8 text-slate-400">${err ? 'Unavailable.' : 'No matching nonprofits.'}</td></tr>
            </tbody>
          </table>
        </div>
      </div>`;
    res.send(page({ title: 'Nonprofits', body, appConfig, user, activeNav: 'nonprofits' }));
  });

  // ── Create (before /nonprofits/:id — "new" is not an id) ────────────
  function renderNew(req, res, v, error) {
    const minLen = getPasswordRules(appConfig).minLength;
    const body = `
      <div class="mb-4"><a class="text-sm text-brand-600 hover:underline" href="/nonprofits">← Back to nonprofits</a></div>
      ${kit.pageHeader('New nonprofit', 'Create a login and its organization profile from the console — for an organization that is not signing itself up on the website.')}
      ${flash('error', error)}
      ${newForm(v || {}, minLen)}`;
    res.status(error ? 400 : 200).send(page({ title: 'New nonprofit', body, appConfig, user: req.session.user, activeNav: 'nonprofits' }));
  }
  router.get('/nonprofits/new', requireAdmin, (req, res) => renderNew(req, res, null, null));

  // Same rules and the same rows as the website's sign-up (routes/api.js),
  // minus the verification email: the admin passes the temporary password
  // on and ticks what to pre-verify. Uniqueness is checked BEFORE the
  // transaction (remote SQLite: no reads inside one); the organization's
  // user_id comes from a sub-select because a remote transaction can't
  // return the new user's id.
  router.post('/nonprofits', requireAdmin, async (req, res) => {
    const { fields: f, error } = readNew(req.body || {});
    if (error) return renderNew(req, res, f, error);
    const pwErr = validatePassword(f.password, getPasswordRules(appConfig));
    if (pwErr) return renderNew(req, res, f, pwErr);
    const by = req.session.user.username;
    try {
      const existing = await db.getAsync('SELECT user_id, email, login_name FROM users WHERE LOWER(email) = LOWER(?) OR LOWER(login_name) = LOWER(?)', [f.email, f.login_name]);
      if (existing) {
        return renderNew(req, res, f, String(existing.email || '').toLowerCase() === f.email
          ? 'An account with that email already exists' : 'That login name is already taken');
      }
      const hash = await hashPassword(f.password);
      const now = kit.sqlTime();
      await db.transaction(async (tx) => {
        await tx.runAsync(
          `INSERT INTO users (login_name, email, first_name, last_name, phone_number, password_hash, is_active, email_verified_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
          [f.login_name, f.email, f.first_name, f.last_name, f.phone_number, hash, f.email_verified ? now : null, now]);
        await tx.runAsync(
          `INSERT INTO organizations (user_id, name, ein, state, is_listed, verification_status, verified_at, verified_by, created_at, updated_at)
           VALUES ((SELECT user_id FROM users WHERE email = ?), ?, ?, 'TX', 1, ?, ?, ?, ?, ?)`,
          [f.email, f.org_name, f.ein || null, f.org_verified ? 'verified' : 'unverified', f.org_verified ? now : null, f.org_verified ? by : null, now, now]);
      });
      const u = await db.getAsync('SELECT user_id FROM users WHERE email = ?', [f.email]);
      const newId = u && u.user_id;
      console.log(`[nonprofits] ${by} created user #${newId} (${f.org_name}); email verified: ${f.email_verified ? 'yes' : 'no'}, organization verified: ${f.org_verified ? 'yes' : 'no'}`);
      await audit(req, 'nonprofit.create', { kind: 'nonprofit', id: newId, label: f.org_name,
        summary: `email verified: ${f.email_verified ? 'yes' : 'no'}, organization verified: ${f.org_verified ? 'yes' : 'no'}` });
      if (!newId) return res.redirect('/nonprofits?msg=' + encodeURIComponent(`"${f.org_name}" created.`));
      req.session.npTempPassword = { id: newId, password: f.password };
      res.redirect(`/nonprofits/${newId}`);
    } catch (err) {
      console.error('[nonprofits] create failed:', err);
      renderNew(req, res, f, uniqueMessage(err) || ('Create failed: ' + (err.message || err)));
    }
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
    const adminHidden = !!(o && Number(o.admin_hidden));
    const pub = new Set(o ? parsePublicFields(o.public_fields) : []);
    // The Preview pop-up frames the Web App's page (events do the same).
    const base = o ? await kit.webAppPublicUrl(appConfig) : '';
    if (base) preview.allowFramingOf(res, base);
    // Create's one-time flash: the temporary password, shown on this render
    // only (cookie-session — deleting it here rewrites the cookie).
    let tempPassword = null;
    if (req.session.npTempPassword) {
      const t = req.session.npTempPassword;
      if (String(t.id) === String(id)) tempPassword = t.password;
      delete req.session.npTempPassword;
    }
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
          <div class="flex items-center gap-3 flex-wrap">
            <span class="text-xs text-slate-500">${Number(o.is_listed) ? '<span class="pill-running">Listed</span> the org wants to appear in the directory' : '<span class="pill-terminated">Hidden</span> the org has hidden its whole profile'}${adminHidden ? ' · <span class="pill-failed">Hidden by MMoA</span>' : ''}</span>
            <a class="btn-secondary text-xs px-3 py-1" href="/nonprofits/${id}/profile">Edit profile</a>
          </div>
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
        <p class="text-xs text-slate-500 dark:text-slate-400">The organization edits this profile itself from the website's portal; <a class="text-brand-600 hover:underline" href="/nonprofits/${id}/profile">Edit profile</a> changes it from here with the same rules. Raw rows: <a class="text-brand-600 hover:underline" href="/data/organizations/row?key=${encodeURIComponent(JSON.stringify({ org_id: Number(o.org_id) }))}">Data Browser → organizations</a>.</p>
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
        x-data="{ busy: false, r: null, url: '',
            init() { this.url = this.$root.dataset.url; ${digits ? 'this.run();' : ''} },
            async run() { this.busy = true; this.r = null;
            try { const x = await fetch(this.url, { headers: { 'Accept': 'application/json' } }); this.r = await x.json(); }
            catch (e) { this.r = { ok: false, error: 'Network error: ' + (e.message || e) }; }
            finally { this.busy = false; } } }">
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
          ${o ? `<form method="POST" action="/nonprofits/${id}/hidden" class="m-0"
                x-on:submit.prevent="window.uiConfirmSubmit($event.target, ${jsAttrStr(adminHidden
                  ? 'Show ' + title + ' in the Need Help directory again? It appears there only if it is verified and the organization has not hidden its own profile.'
                  : 'Hide ' + title + ' from the Need Help directory? It is not shown there whatever the organization\'s own listing switch says, until MMoA shows it again. The organization sees in its portal that MMoA hid it.')}, { title: 'Directory', confirmLabel: ${adminHidden ? "'Show'" : "'Hide'"}, danger: ${adminHidden ? 'false' : 'true'} })">
            <input type="hidden" name="state" value="${adminHidden ? '0' : '1'}">
            <button type="submit" class="${adminHidden ? 'btn-secondary' : 'btn-danger'} text-sm">${adminHidden ? 'Show in directory' : 'Hide from directory'}</button>
          </form>` : ''}
        </div>
      </section>`;

    const body = `
      <div x-data="{ openReset: false, openModify: false }">
        <div class="mb-4"><a class="text-sm text-brand-600 hover:underline" href="/nonprofits">← Back to nonprofits</a></div>
        ${kit.pageHeader(title, `Login: ${m.login_name || '—'}${contactName ? ' · ' + contactName : ''}${m.email ? ' · ' + m.email : ''}`,
          `${status ? `<span class="${STATUS_PILL[status] || 'pill'}">${escapeHtml(STATUS_LABEL[status] || status)}</span>` : '<span class="pill-terminated">No profile</span>'}
           ${o && !Number(o.is_listed) ? '<span class="pill-terminated">Hidden</span>' : ''}
           ${adminHidden ? '<span class="pill-failed">Hidden by MMoA</span>' : ''}
           ${o ? preview.previewButton({ endpoint: `/nonprofits/${id}/preview`, noun: 'profile', base }) : ''}
           <form method="POST" action="/nonprofits/${id}/delete" class="m-0"
                 x-on:submit.prevent="window.uiConfirmSubmit($event.target, ${jsAttrStr('Delete ' + title + '? The login account, the organization profile, its contacts, categories, cities and photo files are all removed. Events / raffles that named it as a beneficiary keep the name without the link. This cannot be undone.')}, { title: 'Delete nonprofit', confirmLabel: 'Delete' })">
             <button type="submit" class="btn-danger text-sm">Delete</button>
           </form>`)}
        ${tempPassword ? `<div class="flash-ok mb-4 text-sm"><strong class="font-semibold">Nonprofit created.</strong> Temporary password — shown this once, pass it to the organization: <code class="font-mono select-all rounded bg-white/70 dark:bg-black/30 px-1.5 py-0.5">${escapeHtml(tempPassword)}</code>. They sign in with their login name or email and can change it in their portal.</div>` : ''}
        ${flash('error', req.query.error)}
        ${flash('success', req.query.msg)}
        ${kit.dbBanner(firstErr)}
        ${o && Number(m.is_active) && status === 'verified' && !Number(o.is_listed) ? '<div class="flash-info mb-4 text-sm">Verified, but the organization has hidden its profile — it is not in the public directory.</div>' : ''}
        ${o && status === 'verified' && adminHidden ? '<div class="flash-warn mb-4 text-sm">Verified, but MMoA has hidden this profile — it is not in the public directory whatever the organization\'s own listing switch says. "Show in directory" (under Login account) lifts that.</div>' : ''}
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
      // The note's length only — the note itself may be about a real org.
      await audit(req, status === 'verified' ? 'nonprofit.verify' : status === 'rejected' ? 'nonprofit.reject' : 'nonprofit.reset',
        { kind: 'nonprofit', id, label: await orgLabel(id),
          summary: `${status === 'verified' ? 'Verified' : status === 'rejected' ? 'Rejected' : 'Reset to unverified'}${note ? ` with a ${note.length}-character note` : ' (no note)'}` });
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
      await audit(req, on ? 'nonprofit.activate' : 'nonprofit.deactivate', { kind: 'nonprofit', id, label: await orgLabel(id), summary: on ? 'Login activated' : 'Login deactivated' });
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
      await audit(req, 'nonprofit.email_verified', { kind: 'nonprofit', id, label: await orgLabel(id), summary: verified ? 'Email marked verified' : 'Email marked unverified' });
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
      const before = await db.getAsync('SELECT login_name, email, first_name, last_name, phone_number FROM users WHERE user_id = ?', [id]).catch(() => null);
      const r = await db.runAsync('UPDATE users SET login_name = ?, email = ?, first_name = ?, last_name = ?, phone_number = ? WHERE user_id = ?',
        [f.login_name, f.email, f.first_name, f.last_name, f.phone_number, id]);
      if (!r.changes) return res.redirect('/nonprofits?error=Account+not+found');
      // Which fields changed — not what they changed to.
      const changed = before ? ['login_name', 'email', 'first_name', 'last_name', 'phone_number'].filter(k => (before[k] || '') !== (f[k] || '')) : [];
      await audit(req, 'nonprofit.edit', { kind: 'nonprofit', id, label: await orgLabel(id),
        summary: changed.length ? `Account fields changed: ${changed.join(', ')}` : 'Account saved (no field changed)' });
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
      await audit(req, 'nonprofit.password_reset', { kind: 'nonprofit', id, label: await orgLabel(id), summary: 'Password set by an admin' });
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
      await audit(req, 'nonprofit.photo_remove', { kind: 'nonprofit', id, label: await orgLabel(id), summary: `Profile photo #${imageId} removed` });
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
      await audit(req, 'nonprofit.delete', { kind: 'nonprofit', id, label,
        summary: `Account deleted${o ? ' with its organization profile' : ''} (${paths.length} photo file(s))` });
      res.redirect('/nonprofits?msg=' + encodeURIComponent(`"${label}" deleted.`));
    } catch (err) {
      console.error('[nonprofits] delete failed:', err);
      res.redirect(`/nonprofits/${id}?error=` + encodeURIComponent('Delete failed: ' + (err.message || err)));
    }
  });

  // ── Hide / show in the directory (MMoA's override) ─────────────────
  router.post('/nonprofits/:id/hidden', requireAdmin, async (req, res) => {
    const id = kit.idParam(req.params.id);
    if (!id) return res.redirect('/nonprofits?error=Invalid+id');
    const hide = (req.body && req.body.state) === '1';
    try {
      const r = await db.runAsync('UPDATE organizations SET admin_hidden = ?, updated_at = ? WHERE user_id = ?', [hide ? 1 : 0, kit.sqlTime(), id]);
      if (!r.changes) return res.redirect(`/nonprofits/${id}?error=` + encodeURIComponent('This account has no organization profile to hide.'));
      console.log(`[nonprofits] ${req.session.user.username} ${hide ? 'hid' : 'showed'} user #${id} organization ${hide ? 'from' : 'in'} the directory`);
      await audit(req, hide ? 'nonprofit.hide' : 'nonprofit.unhide', { kind: 'nonprofit', id, label: await orgLabel(id),
        summary: hide ? 'Hidden from the Need Help directory by MMoA' : 'Shown in the Need Help directory again (MMoA override lifted)' });
      res.redirect(`/nonprofits/${id}?msg=` + encodeURIComponent(hide
        ? 'Hidden from the Need Help directory. The website picks it up within 20 seconds.'
        : 'MMoA override lifted — it is in the Need Help directory again if verified and listed by the organization (within 20 seconds).'));
    } catch (err) {
      res.redirect(`/nonprofits/${id}?error=` + encodeURIComponent('Update failed: ' + (err.message || err)));
    }
  });

  // ── Edit profile ────────────────────────────────────────────────────
  async function loadProfilePickers() {
    const cats = await kit.safeAll(db, 'SELECT category_id, slug, name FROM categories WHERE is_active = 1 ORDER BY sort, name', []);
    const cities = await kit.safeAll(db, 'SELECT city_id, name FROM cities WHERE is_active = 1 ORDER BY sort, name', []);
    return { categories: cats.rows, cities: cities.rows, err: cats.err || cities.err };
  }
  async function loadOrgChildren(orgId) {
    const contacts = await db.allAsync('SELECT * FROM org_contacts WHERE org_id = ? ORDER BY sort, contact_id', [orgId]);
    const cats = await db.allAsync('SELECT c.category_id, c.slug FROM org_categories oc JOIN categories c ON c.category_id = oc.category_id WHERE oc.org_id = ? ORDER BY c.category_id', [orgId]);
    const cities = await db.allAsync('SELECT city_id FROM org_cities WHERE org_id = ? ORDER BY city_id', [orgId]);
    return { contacts, catSlugs: cats.map(c => c.slug), catIds: cats.map(c => Number(c.category_id)), cityIds: cities.map(c => Number(c.city_id)) };
  }
  async function renderProfile(req, res, id, values, error) {
    const user = req.session.user;
    const { value: o, err } = await kit.safeGet(db, 'SELECT o.*, u.login_name FROM organizations o JOIN users u ON u.user_id = o.user_id WHERE o.user_id = ?', [id], null);
    if (err || !o) {
      return res.status(err ? 200 : 404).send(page({ title: 'Edit profile', appConfig, user, activeNav: 'nonprofits',
        body: `${kit.pageHeader(err ? 'Edit profile' : 'No organization profile')}${kit.dbBanner(err)}
               ${err ? '' : `<p class="text-slate-500">This account has no organization profile to edit.</p>`}
               <p class="mt-4"><a class="text-brand-600 hover:underline" href="/nonprofits/${id}">← Back</a></p>` }));
    }
    const pickers = await loadProfilePickers();
    let v = values;
    if (!v) {
      try { const ch = await loadOrgChildren(o.org_id); v = profileValues(o, ch.contacts, ch.catSlugs, ch.cityIds); }
      catch (e) { return res.send(page({ title: 'Edit profile', appConfig, user, activeNav: 'nonprofits', body: `${kit.pageHeader('Edit profile')}${kit.dbBanner(e)}` })); }
    }
    const status = o.verification_status || 'unverified';
    const body = `
      <div class="mb-4"><a class="text-sm text-brand-600 hover:underline" href="/nonprofits/${id}">← Back to ${escapeHtml(o.name || o.login_name)}</a></div>
      ${kit.pageHeader('Edit profile — ' + (o.name || o.login_name), 'Every field the organization can edit in its portal, with the same rules. The website shows the change within 20 seconds.',
        `<span class="${STATUS_PILL[status] || 'pill'}">${escapeHtml(STATUS_LABEL[status] || status)}</span>`)}
      ${flash('error', error)}
      ${kit.dbBanner(pickers.err)}
      ${profileForm(`/nonprofits/${id}/profile`, `/nonprofits/${id}`, v, pickers, status)}`;
    res.status(error ? 400 : 200).send(page({ title: 'Edit profile', body, appConfig, user, activeNav: 'nonprofits' }));
  }
  router.get('/nonprofits/:id/profile', requireAdmin, async (req, res) => {
    const id = kit.idParam(req.params.id);
    if (!id) return res.redirect('/nonprofits?error=Invalid+id');
    await renderProfile(req, res, id, null, null);
  });

  // Validated exactly like the portal (readProfile), then organizations is
  // updated and contacts / categories / cities replaced in one transaction.
  // Lookups (category ids by slug, city ids, the before-state for the audit
  // row) happen before it.
  router.post('/nonprofits/:id/profile', requireAdmin, async (req, res) => {
    const id = kit.idParam(req.params.id);
    if (!id) return res.redirect('/nonprofits?error=Invalid+id');
    const v = valuesFromBody(req.body || {});
    let o;
    try { o = await db.getAsync('SELECT * FROM organizations WHERE user_id = ?', [id]); }
    catch (e) { return renderProfile(req, res, id, v, 'Database unavailable: ' + (e.message || e)); }
    if (!o) return res.redirect(`/nonprofits/${id}?error=` + encodeURIComponent('This account has no organization profile to edit.'));
    let r;
    try { r = readProfile(v, o); }
    catch (e) {
      if (e instanceof BadInput) return renderProfile(req, res, id, v, e.message);
      throw e;
    }
    try {
      const before = await loadOrgChildren(o.org_id);
      const catRows = await db.allAsync('SELECT category_id, slug FROM categories WHERE is_active = 1', []);
      const wantedSlugs = new Set(r.categorySlugs);
      const categoryIds = catRows.filter(c => wantedSlugs.has(String(c.slug))).map(c => Number(c.category_id));
      const cityRows = await db.allAsync('SELECT city_id FROM cities WHERE is_active = 1', []);
      const wantedCities = new Set(r.cityIds);
      const cityIds = cityRows.filter(c => wantedCities.has(Number(c.city_id))).map(c => Number(c.city_id));
      const set = { ...r.set, updated_at: kit.sqlTime() };
      await db.transaction(async (tx) => {
        const cols = Object.keys(set); // fixed allowlist from readProfile — never client keys
        await tx.runAsync(`UPDATE organizations SET ${cols.map(c => `${c} = ?`).join(', ')} WHERE org_id = ?`, [...cols.map(c => set[c]), o.org_id]);
        await tx.runAsync('DELETE FROM org_contacts WHERE org_id = ?', [o.org_id]);
        let i = 0;
        for (const c of r.contacts) {
          await tx.runAsync('INSERT INTO org_contacts (org_id, name, role, email, phone, phone_ext, is_public, sort) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            [o.org_id, c.name, c.role, c.email, c.phone, c.phone_ext, c.is_public, i++]);
        }
        await tx.runAsync('DELETE FROM org_categories WHERE org_id = ?', [o.org_id]);
        for (const cid of categoryIds) await tx.runAsync('INSERT INTO org_categories (org_id, category_id) VALUES (?, ?)', [o.org_id, cid]);
        await tx.runAsync('DELETE FROM org_cities WHERE org_id = ?', [o.org_id]);
        for (const cid of cityIds) await tx.runAsync('INSERT INTO org_cities (org_id, city_id) VALUES (?, ?)', [o.org_id, cid]);
      });
      // Which fields changed — names only, never values.
      const norm = (x) => (x == null ? '' : String(x));
      const changed = [];
      for (const k of Object.keys(r.set)) {
        if (k === 'public_fields') { if (JSON.stringify(parsePublicFields(o.public_fields)) !== r.set.public_fields) changed.push(k); }
        else if (k === 'is_listed') { if (Number(o.is_listed) !== r.set.is_listed) changed.push(k); }
        else if (norm(o[k]) !== norm(r.set[k])) changed.push(k);
      }
      const sortedNums = (a) => a.map(Number).sort((x, y) => x - y).join(',');
      if (contactsJson(before.contacts) !== contactsJson(r.contacts)) changed.push('contacts');
      if (sortedNums(before.catIds) !== sortedNums(categoryIds)) changed.push('categories');
      if (sortedNums(before.cityIds) !== sortedNums(cityIds)) changed.push('cities');
      console.log(`[nonprofits] ${req.session.user.username} edited the profile of user #${id}: ${changed.join(', ') || 'no field changed'}`);
      await audit(req, 'nonprofit.profile_edit', { kind: 'nonprofit', id, label: r.set.name,
        summary: changed.length ? `Profile fields changed: ${changed.join(', ')}` : 'Profile saved (no field changed)' });
      res.redirect(`/nonprofits/${id}?msg=` + encodeURIComponent('Profile saved. The website picks the change up within 20 seconds.'));
    } catch (err) {
      console.error('[nonprofits] profile save failed:', err);
      renderProfile(req, res, id, v, 'Save failed: ' + (err.message || err));
    }
  });

  // ── Preview link (the Preview pop-up; by org id, no slug) ──────────
  router.post('/nonprofits/:id/preview', requireAdmin, async (req, res) => {
    const id = kit.idParam(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid id' });
    let o;
    try { o = await db.getAsync('SELECT org_id, name FROM organizations WHERE user_id = ?', [id]); }
    catch (e) { return res.status(500).json({ error: 'Database unavailable: ' + (e.message || e) }); }
    if (!o) return res.status(404).json({ error: 'This account has no organization profile to preview.' });
    const r = await preview.makePreviewLink(db, appConfig, { table: 'organizations', idCol: 'org_id', id: o.org_id, path: '/need-help/preview', byId: true });
    if (r.status === 200) {
      await audit(req, 'nonprofit.preview', { kind: 'nonprofit', id, label: o.name, summary: `Preview link made (valid ${preview.PREVIEW_MINUTES} min)` });
    }
    res.status(r.status).json(r.body);
  });

  return router;
};
