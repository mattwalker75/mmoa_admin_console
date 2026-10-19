// routes/lockedUsers.js — view and clear brute-force login lockouts.
//
//   GET  /locked-users          → table of lockout rows (user accounts + IPs)
//   POST /locked-users/:id/unlock → DELETE the row, clearing the lockout
//
// The web app's login flow (mmoa_web_app middleware/loginLockout.js) records
// a row in `login_lockouts` per scope (a member account or a source IP). After
// security.loginLockout.maxFailures failed attempts (default 10) the scope is
// locked for lockoutSeconds (default 300) via `locked_until_ms` (epoch ms). A row is "currently locked" when
// locked_until_ms > now; once that timestamp passes the lock has lapsed on its
// own but the row may linger until the next failed attempt overwrites it.
//
// "Unlock" simply deletes the row — the next login attempt starts fresh from a
// zero fail-count. Queries stay portable between SQLite and MySQL (no
// DB-specific time functions); all "is it still locked / how long left"
// arithmetic is done in JS against the millisecond column.

const express = require('express');
const { page, flash } = require('../views/layout');
const { escapeHtml } = require('../views/escapeHtml');
const { requireAdmin } = require('../middleware/auth');

function dbBanner(err) {
  if (!err) return '';
  return `<div class="flash-error mb-6">
    <strong class="font-semibold">Database unavailable.</strong>
    ${escapeHtml(err.message || 'unknown error')}. Lockouts could not be loaded.
  </div>`;
}

async function safeAll(db, sql, params) {
  try { return { rows: await db.allAsync(sql, params), err: null }; }
  catch (err) { return { rows: [], err }; }
}

// 'ip' / 'user' (and any future scope) → a friendly label for the UI.
function scopeLabel(scope) {
  const s = String(scope || '').toLowerCase();
  if (s === 'ip') return 'IP address';
  if (s === 'user' || s === 'account') return 'Member account';
  return scope || '—';
}

module.exports = function (db, appConfig) {
  const router = express.Router();

  // ── List page ─────────────────────────────────────────────────────
  router.get('/locked-users', requireAdmin, async (req, res) => {
    const user = req.session.user;
    const { rows, err } = await safeAll(db, `
      SELECT id, scope, scope_key, fail_count, locked_until_ms,
             last_failed_at, updated_at, created_at
        FROM login_lockouts
       ORDER BY locked_until_ms DESC, last_failed_at DESC
    `);

    const lockouts = rows.map(r => ({
      id: r.id,
      scope: r.scope || '',
      scopeLabel: scopeLabel(r.scope),
      scopeKey: r.scope_key || '',
      failCount: r.fail_count | 0,
      // Coerce to a number (or null) so the client can compare against Date.now().
      lockedUntilMs: r.locked_until_ms == null ? null : Number(r.locked_until_ms),
      lastFailed: r.last_failed_at || '',
      search: [r.scope, r.scope_key].filter(Boolean).join(' ').toLowerCase()
    }));

    const lockoutsJson = escapeHtml(JSON.stringify(lockouts));
    const emptyMsg = err ? 'Unavailable.' : 'No lockouts on record.';
    const body = `
      <div data-lockouts="${lockoutsJson}"
           x-data="{
             lockouts: [],
             query: '',
             onlyLocked: true,
             nowMs: Date.now(),
             sortKey: 'lockedUntilMs',
             sortDir: 'desc',
             init() {
               this.lockouts = JSON.parse(this.\$el.dataset.lockouts);
               // Refresh the clock every 15s so countdowns and the
               // locked/lapsed status stay live without a page reload.
               setInterval(() => { this.nowMs = Date.now(); }, 15000);
             },
             isLocked(l) { return l.lockedUntilMs != null && l.lockedUntilMs > this.nowMs; },
             remaining(l) {
               if (!this.isLocked(l)) return '';
               let s = Math.max(0, Math.round((l.lockedUntilMs - this.nowMs) / 1000));
               const m = Math.floor(s / 60); s = s % 60;
               return m > 0 ? (m + 'm ' + s + 's') : (s + 's');
             },
             fmtUntil(l) {
               if (l.lockedUntilMs == null) return '—';
               try { return new Date(l.lockedUntilMs).toLocaleString(); }
               catch (e) { return String(l.lockedUntilMs); }
             },
             get lockedCount() { return this.lockouts.filter(l => this.isLocked(l)).length; },
             get visible() {
               const q = this.query.trim().toLowerCase();
               let arr = this.lockouts.slice();
               if (this.onlyLocked) arr = arr.filter(l => this.isLocked(l));
               if (q) arr = arr.filter(l => l.search.includes(q));
               const dir = this.sortDir === 'asc' ? 1 : -1;
               const k = this.sortKey;
               arr.sort((a, b) => {
                 let av = a[k], bv = b[k];
                 if (typeof av === 'string') av = av.toLowerCase();
                 if (typeof bv === 'string') bv = bv.toLowerCase();
                 if (av == null) av = -Infinity;
                 if (bv == null) bv = -Infinity;
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
            <h1 class="text-2xl font-bold text-slate-900 dark:text-slate-100">Locked Users</h1>
            <p class="mt-1 text-sm text-slate-500 dark:text-slate-400">Member accounts and IP addresses temporarily blocked from the web app's login after too many failed attempts (default 10 failures → 5-minute lockout; see Web App Settings → Security). Unlock clears the block immediately.</p>
          </div>
          <div class="text-right shrink-0">
            <div class="text-2xl font-semibold text-slate-900 dark:text-slate-100" x-text="lockedCount"></div>
            <div class="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400">currently locked</div>
          </div>
        </header>

        ${flash('success', req.query.msg)}
        ${flash('error', req.query.error)}
        ${dbBanner(err)}

        <div class="mb-4 flex flex-wrap items-center gap-3">
          <input class="input max-w-md" type="text"
                 placeholder="Search by account, email, or IP…"
                 autocomplete="off"
                 x-model="query">
          <label class="inline-flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300 select-none">
            <input type="checkbox" x-model="onlyLocked" class="rounded border-slate-300">
            <span>Only show currently locked</span>
          </label>
          <span class="text-xs text-slate-500 dark:text-slate-400" x-text="visible.length + ' shown'"></span>
        </div>

        <div class="table-wrap surface-target">
          <table class="table-base">
            <thead>
              <tr>
                <th class="cursor-pointer select-none" x-on:click="toggleSort('scope')">
                  Type <span class="text-xs text-slate-400 ml-1" x-text="sortIcon('scope')"></span>
                </th>
                <th class="cursor-pointer select-none" x-on:click="toggleSort('scopeKey')">
                  Account / IP <span class="text-xs text-slate-400 ml-1" x-text="sortIcon('scopeKey')"></span>
                </th>
                <th class="cursor-pointer select-none" x-on:click="toggleSort('failCount')">
                  Failed attempts <span class="text-xs text-slate-400 ml-1" x-text="sortIcon('failCount')"></span>
                </th>
                <th>Status</th>
                <th class="cursor-pointer select-none" x-on:click="toggleSort('lockedUntilMs')">
                  Locked until <span class="text-xs text-slate-400 ml-1" x-text="sortIcon('lockedUntilMs')"></span>
                </th>
                <th>Last failed</th>
                <th class="text-right">Action</th>
              </tr>
            </thead>
            <tbody>
              <template x-for="l in visible" :key="l.id">
                <tr>
                  <td>
                    <span class="text-xs font-medium px-2 py-0.5 rounded-full bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200"
                          x-text="l.scopeLabel"></span>
                  </td>
                  <td class="font-mono text-xs text-slate-900 dark:text-slate-100 break-all" x-text="l.scopeKey || '—'"></td>
                  <td x-text="l.failCount"></td>
                  <td>
                    <template x-if="isLocked(l)">
                      <span class="inline-flex items-center gap-1.5 text-xs font-medium px-2 py-0.5 rounded-full bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300">
                        Locked · <span x-text="remaining(l)"></span> left
                      </span>
                    </template>
                    <template x-if="!isLocked(l)">
                      <span class="text-xs text-slate-400">Lapsed</span>
                    </template>
                  </td>
                  <td class="text-slate-500 text-xs whitespace-nowrap" x-text="fmtUntil(l)"></td>
                  <td class="text-slate-500 text-xs whitespace-nowrap" x-text="l.lastFailed || '—'"></td>
                  <td class="text-right">
                    <form method="POST" :action="'/locked-users/' + l.id + '/unlock'" class="m-0 inline"
                          x-on:submit.prevent="window.uiConfirmSubmit(\$event.target, 'Unlock ' + l.scopeLabel + ' \\'' + l.scopeKey + '\\'? They will be able to attempt login immediately.', { title: 'Unlock', confirmLabel: 'Unlock' })">
                      <button type="submit" class="btn-secondary text-sm">Unlock</button>
                    </form>
                  </td>
                </tr>
              </template>
              <tr x-show="!visible.length">
                <td colspan="7" class="text-center py-8 text-slate-400">
                  <span x-show="query || onlyLocked">No matching lockouts.</span>
                  <span x-show="!query && !onlyLocked">${emptyMsg}</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    `;
    res.send(page({ title: 'Locked Users', body, appConfig, user, activeNav: 'locked-users' }));
  });

  // ── Unlock (delete the lockout row) ───────────────────────────────
  router.post('/locked-users/:id/unlock', requireAdmin, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      return res.redirect('/locked-users?error=Invalid+lockout+id');
    }
    try {
      const r = await db.runAsync('DELETE FROM login_lockouts WHERE id = ?', [id]);
      if (!r.changes) return res.redirect('/locked-users?error=Lockout+not+found+(already+cleared)');
      res.redirect('/locked-users?msg=Unlocked.');
    } catch (err) {
      console.error('[locked-users] unlock failed:', err);
      res.redirect('/locked-users?error=' + encodeURIComponent('Unlock failed: ' + (err.message || 'unknown error')));
    }
  });

  return router;
};
