// routes/reports.js — operational reports surfaced as cards on /reports.
// Each report defines its columns once; the same column list drives both
// the View modal (rendered server-side as a JSON payload, displayed
// client-side via Alpine) and the Download CSV path.
//
//   GET /reports                → grid of report cards (View + CSV).
//   GET /reports/:name.json     → { columns, rows } for the View modal.
//   GET /reports/:name.csv      → CSV download of the same rows.
//
// All member-name composition is done in JS (not SQL) so the queries
// stay portable between SQLite and MySQL — there's no CONCAT vs `||`
// divergence to maintain. Comparisons against "now" bind a JS-computed
// value (epoch ms for lockouts) rather than calling an engine-specific
// time function.

const express = require('express');
const { page, flash } = require('../views/layout');
const { escapeHtml } = require('../views/escapeHtml');
const { requireAdmin } = require('../middleware/auth');
const localAdmins = require('../helpers/localAdmins');

// ── CSV helpers ─────────────────────────────────────────────────────
function csvEscape(v) {
  if (v === null || v === undefined) return '';
  let s = String(v);
  // Neutralize spreadsheet formula injection: a cell starting with = + - @
  // (or tab/CR) is evaluated as a formula by Excel/Sheets. Report data
  // includes member-controlled fields (names, emails, event text), so prefix a single
  // quote to force text before the file reaches the operator's spreadsheet.
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function toCsv(rows, columns) {
  const header = columns.map(c => csvEscape(c.label)).join(',');
  const body = rows.map(r => columns.map(c => csvEscape(r[c.key])).join(',')).join('\r\n');
  return header + '\r\n' + body + (body ? '\r\n' : '');
}
function isoDateStamp() {
  const d = new Date();
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

// ── Row-shaping helpers ─────────────────────────────────────────────
// Compose a display name from first_name / last_name without depending on
// SQL CONCAT (which differs between SQLite and MySQL). Falls back to the
// email local-part if both names are missing so the report never shows
// blank rows.
function composeFullName(r) {
  const fn = (r.first_name || '').trim();
  const ln = (r.last_name || '').trim();
  const combined = [fn, ln].filter(Boolean).join(' ');
  if (combined) return combined;
  if (r.email) return r.email.split('@')[0];
  return '';
}
function yesNo(v) {
  if (v === 1 || v === true || v === '1') return 'yes';
  if (v === 0 || v === false || v === '0' || v === null || v === undefined) return 'no';
  return String(v);
}
// ── Report registry ─────────────────────────────────────────────────
// Each `fetch` returns an array of plain objects keyed by the report's
// `columns[].key` values. SQL stays portable; any per-row composition
// (full_name, yes/no flags, locked/lapsed) happens in JS below.

const REPORTS = {
  'members-all': {
    label: 'All members',
    description: 'Every account in the web app (members and web-app admins) with their profile. Sorted by most-recently created.',
    needsDb: true,
    columns: [
      { key: 'user_id',           label: 'User ID' },
      { key: 'login_name',        label: 'Login' },
      { key: 'full_name',         label: 'Name' },
      { key: 'email',             label: 'Email' },
      { key: 'phone_number',      label: 'Phone' },
      { key: 'role',              label: 'Role' },
      { key: 'is_active',         label: 'Active' },
      { key: 'email_verified_at', label: 'Verified at' },
      { key: 'created_at',        label: 'Created' },
      { key: 'last_login_at',     label: 'Last login' }
    ],
    async fetch({ db }) {
      const rows = await db.allAsync(`
        SELECT user_id, login_name, first_name, last_name, email,
               phone_number, role, is_active,
               email_verified_at, created_at, last_login_at
          FROM users
         ORDER BY created_at DESC, user_id DESC`);
      return rows.map(r => ({
        ...r,
        full_name: composeFullName(r),
        is_active: yesNo(r.is_active)
      }));
    }
  },

  'members-unverified': {
    label: 'Unverified members',
    description: 'Accounts that have not confirmed their email address. These accounts cannot sign in to the web app until verified (or marked verified from Members).',
    needsDb: true,
    columns: [
      { key: 'user_id',      label: 'User ID' },
      { key: 'login_name',   label: 'Login' },
      { key: 'full_name',    label: 'Name' },
      { key: 'email',        label: 'Email' },
      { key: 'phone_number', label: 'Phone' },
      { key: 'created_at',   label: 'Created' }
    ],
    async fetch({ db }) {
      const rows = await db.allAsync(`
        SELECT user_id, login_name, first_name, last_name, email,
               phone_number, created_at
          FROM users
         WHERE email_verified_at IS NULL
         ORDER BY created_at DESC, user_id DESC`);
      return rows.map(r => ({ ...r, full_name: composeFullName(r) }));
    }
  },

  'events-all': {
    label: 'Events',
    description: 'Every event on the website, published or not, soonest first.',
    needsDb: true,
    columns: [
      { key: 'event_id',     label: 'Event ID' },
      { key: 'title',        label: 'Title' },
      { key: 'starts_at',    label: 'Starts' },
      { key: 'ends_at',      label: 'Ends' },
      { key: 'location',     label: 'Location' },
      { key: 'is_published', label: 'Published' },
      { key: 'description',  label: 'Description' },
      { key: 'created_at',   label: 'Created' },
      { key: 'updated_at',   label: 'Updated' }
    ],
    async fetch({ db }) {
      const rows = await db.allAsync(`
        SELECT event_id, title, description, location, starts_at, ends_at,
               is_published, created_at, updated_at
          FROM events
         ORDER BY starts_at ASC, event_id ASC`);
      return rows.map(r => ({ ...r, is_published: yesNo(r.is_published) }));
    }
  },

  'login-lockouts': {
    label: 'Login lockouts',
    description: 'Every lockout row (member accounts and IP addresses) with failure counts and whether the lock is still in force.',
    needsDb: true,
    columns: [
      { key: 'id',             label: 'ID' },
      { key: 'scope',          label: 'Type' },
      { key: 'scope_key',      label: 'Account / IP' },
      { key: 'fail_count',     label: 'Failed attempts' },
      { key: 'status',         label: 'Status' },
      { key: 'locked_until',   label: 'Locked until (UTC)' },
      { key: 'last_failed_at', label: 'Last failed' },
      { key: 'created_at',     label: 'First seen' }
    ],
    async fetch({ db }) {
      const rows = await db.allAsync(`
        SELECT id, scope, scope_key, fail_count, locked_until_ms,
               last_failed_at, created_at
          FROM login_lockouts
         ORDER BY locked_until_ms DESC, last_failed_at DESC`);
      const now = Date.now();
      return rows.map(r => {
        const until = r.locked_until_ms == null ? null : Number(r.locked_until_ms);
        return {
          ...r,
          status: until != null && until > now ? 'locked' : 'lapsed',
          locked_until: until == null ? '' : new Date(until).toISOString().replace('T', ' ').replace(/\..+/, '')
        };
      });
    }
  },

  'console-admins': {
    label: 'Console admins',
    description: "Local-file admins (this console's own operators). Password hashes are never exported.",
    needsDb: false,
    columns: [
      { key: 'username', label: 'Username' },
      { key: 'email',    label: 'Email' },
      { key: 'name',     label: 'Name' }
    ],
    async fetch() {
      return localAdmins.loadAll().map(a => ({
        username: a.username,
        email: a.email || '',
        name: a.name || ''
      }));
    }
  }
};

module.exports = function (db, appConfig) {
  const router = express.Router();

  async function runReport(slug) {
    const report = REPORTS[slug];
    if (!report) return { error: 'Unknown report: ' + slug };
    if (report.needsDb && !db.available) {
      return { error: 'Database is offline — cannot run "' + report.label + '"' };
    }
    try {
      const rows = await report.fetch({ db });
      return { report, rows };
    } catch (err) {
      console.error('[reports] failed:', slug, err);
      return { error: 'Report failed: ' + (err.message || 'unknown error') };
    }
  }

  // ── List page ─────────────────────────────────────────────────────
  router.get('/reports', requireAdmin, (req, res) => {
    const user = req.session.user;
    const cards = Object.entries(REPORTS).map(([slug, r]) => `
      <div class="card surface-target card-pad flex flex-col gap-3">
        <div>
          <h2 class="text-base font-semibold text-slate-900 dark:text-slate-100">${escapeHtml(r.label)}</h2>
          <p class="mt-1 text-sm text-slate-500 dark:text-slate-400">${escapeHtml(r.description)}</p>
        </div>
        <div class="mt-auto flex items-center justify-between gap-3">
          <span class="text-xs text-slate-400 font-mono truncate">${escapeHtml(slug)}</span>
          <div class="flex items-center gap-2 shrink-0">
            <button type="button" class="btn-secondary"
                    data-report-slug="${escapeHtml(slug)}"
                    data-report-label="${escapeHtml(r.label)}"
                    x-on:click="openReport($el.dataset.reportSlug, $el.dataset.reportLabel)">
              <span>View</span>
            </button>
            <a class="btn-primary" href="/reports/${escapeHtml(slug)}.csv" download>
              <span aria-hidden="true">⤓</span>
              <span>Download CSV</span>
            </a>
          </div>
        </div>
      </div>
    `).join('');

    const body = `
      <header class="mb-8">
        <h1 class="text-2xl font-bold text-slate-900 dark:text-slate-100">Reports</h1>
        <p class="mt-1 text-sm text-slate-500 dark:text-slate-400">Operational reports drawn from the web app's database and this console's local admin file. <strong>View</strong> opens the data in-app; <strong>Download CSV</strong> saves it.</p>
      </header>

      ${flash('error', req.query.error)}
      ${db.available ? '' : `<div class="flash-error mb-6"><strong>Database offline.</strong> Database-backed reports will fail until the web app's database is configured under Settings → Web App.</div>`}

      <div x-data="{
             open: false,
             slug: '',
             title: '',
             loading: false,
             error: '',
             columns: [],
             rows: [],
             async openReport(slug, title) {
               this.slug = slug;
               this.title = title;
               this.open = true;
               this.loading = true;
               this.error = '';
               this.columns = [];
               this.rows = [];
               try {
                 const r = await fetch('/reports/' + encodeURIComponent(slug) + '.json', {
                   headers: { 'Accept': 'application/json' }
                 });
                 const j = await r.json().catch(() => ({}));
                 if (!r.ok || j.error) {
                   this.error = j.error || ('HTTP ' + r.status);
                 } else {
                   this.columns = j.columns || [];
                   this.rows = j.rows || [];
                 }
               } catch (e) {
                 this.error = e.message || String(e);
               } finally {
                 this.loading = false;
               }
             },
             close() { this.open = false; }
           }">
        <div class="grid sm:grid-cols-2 xl:grid-cols-3 gap-4">
          ${cards}
        </div>

        <!-- View modal — opens when the operator clicks any card's "View"
             button. Fetches /reports/:slug.json and renders the rows in a
             scrollable table. Download CSV is offered alongside Close so
             the operator can save what they're looking at without going
             back to the card. -->
        <div x-show="open" x-transition
             x-on:keydown.escape.window="close()"
             class="fixed inset-0 z-40 flex items-start justify-center p-4 pt-12 bg-black/60 overflow-y-auto"
             x-on:click.self="close()">
          <div class="card surface-target card-pad w-full max-w-6xl mb-8"
               x-trap.inert.noscroll="open">
            <header class="flex items-start justify-between gap-4 mb-4">
              <div class="min-w-0">
                <h2 class="text-lg font-semibold text-slate-900 dark:text-slate-100" x-text="title"></h2>
                <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">
                  <span x-show="loading">Loading…</span>
                  <span x-show="!loading && !error" x-text="rows.length + ' row' + (rows.length === 1 ? '' : 's')"></span>
                  <span x-show="error" class="text-red-600 dark:text-red-400" x-text="error"></span>
                </p>
              </div>
              <div class="flex items-center gap-2 shrink-0">
                <a class="btn-secondary" :href="'/reports/' + slug + '.csv'" download
                   x-show="!loading && !error && rows.length > 0">
                  <span aria-hidden="true">⤓</span>
                  <span>Download CSV</span>
                </a>
                <button type="button" class="btn-primary" x-on:click="close()">Close</button>
              </div>
            </header>

            <div x-show="!loading && !error" class="overflow-auto border border-slate-200 dark:border-slate-700 rounded-lg"
                 style="max-height: 70vh;">
              <table class="min-w-full text-xs">
                <thead class="bg-slate-100 dark:bg-slate-800 sticky top-0">
                  <tr>
                    <template x-for="c in columns" :key="c.key">
                      <th class="text-left font-semibold text-slate-700 dark:text-slate-200 px-3 py-2 whitespace-nowrap"
                          x-text="c.label"></th>
                    </template>
                  </tr>
                </thead>
                <tbody>
                  <template x-for="(row, i) in rows" :key="i">
                    <tr class="border-t border-slate-200 dark:border-slate-700"
                        :class="i % 2 ? 'bg-slate-50 dark:bg-slate-900/40' : ''">
                      <template x-for="c in columns" :key="c.key">
                        <td class="px-3 py-1.5 align-top text-slate-800 dark:text-slate-100 whitespace-pre-wrap break-words"
                            x-text="row[c.key] == null ? '' : String(row[c.key])"></td>
                      </template>
                    </tr>
                  </template>
                  <tr x-show="rows.length === 0">
                    <td :colspan="columns.length || 1" class="px-3 py-8 text-center text-slate-400">No rows.</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    `;
    res.send(page({ title: 'Reports', body, appConfig, user, activeNav: 'reports' }));
  });

  // ── JSON endpoint (drives the View modal) ────────────────────────
  router.get('/reports/:name.json', requireAdmin, async (req, res) => {
    const result = await runReport(req.params.name);
    if (result.error) return res.status(400).json({ error: result.error });
    res.json({
      slug: req.params.name,
      label: result.report.label,
      columns: result.report.columns,
      rows: result.rows
    });
  });

  // ── CSV download ─────────────────────────────────────────────────
  router.get('/reports/:name.csv', requireAdmin, async (req, res) => {
    const result = await runReport(req.params.name);
    if (result.error) return res.redirect('/reports?error=' + encodeURIComponent(result.error));
    const csv = toCsv(result.rows, result.report.columns);
    const filename = `${req.params.name}-${isoDateStamp()}.csv`;
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);
  });

  return router;
};
