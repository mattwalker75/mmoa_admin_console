// routes/audit.js — the Audit log page: who did what in this console.
//
//   GET /audit   → newest first, filters (admin, action, free text, dates in
//                  the console's time zone — helpers/localTime.js), 50 a page
//
// Rows come from the web app's `admin_audit` table (helpers/audit.js writes
// them, the WEB APP creates the table when it boots — this console never
// creates or alters it). Until the web app has restarted after the update,
// the table is missing and kit.dbBanner shows the "Start (or restart) the
// Web App" banner instead of a crash.
//
// Routers that app.js does not hand a `db` (profile, templates, web app
// settings / website) record through `record()` below: the db is captured
// when app.js mounts this router, and audit calls only ever happen at
// request time — after every router is mounted — so the mount order in
// app.js doesn't matter.

const express = require('express');
const { page, flash } = require('../views/layout');
const { escapeHtml } = require('../views/escapeHtml');
const { requireAdmin } = require('../middleware/auth');
const kit = require('../helpers/pageKit');
const lt = require('../helpers/localTime');
const makeAudit = require('../helpers/audit');

const PER_PAGE = 50;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ACTION_RE = /^[a-z0-9_]+(?:\.[a-z0-9_*]+)*$/;

// Shared recorder for routers without a db of their own (see top of file).
let shared = null;
function record(req, action, target) {
  if (!shared) {
    console.warn(`[audit] not mounted yet — could not record ${action}`);
    return Promise.resolve();
  }
  return shared(req, action, target);
}

// '%term%' for LIKE … ESCAPE '!' (same escaping as the Data Browser; a
// backslash escape char is not portable to MySQL).
function likePattern(q) {
  return '%' + q.toLowerCase().replace(/[!%_]/g, '!$&') + '%';
}

function makeRouter(db, appConfig) {
  const router = express.Router();
  shared = makeAudit(db);

  router.get('/audit', requireAdmin, async (req, res) => {
    const user = req.session.user;
    const Q = req.query || {};
    const admin = kit.str(Q.admin, 100) || '';
    const actionRaw = kit.str(Q.action, 60) || '';
    const action = ACTION_RE.test(actionRaw) ? actionRaw : '';
    const q = kit.str(Q.q, 200) || '';
    const from = DATE_RE.test(String(Q.from || '')) ? String(Q.from) : '';
    const to = DATE_RE.test(String(Q.to || '')) ? String(Q.to) : '';
    let pageNo = parseInt(Q.page, 10);
    if (!Number.isInteger(pageNo) || pageNo < 1) pageNo = 1;

    // WHERE — every value is a parameter; identifiers are constants.
    const where = [], params = [];
    if (admin) { where.push('admin = ?'); params.push(admin); }
    if (action) {
      if (action.endsWith('.*')) { where.push("action LIKE ? ESCAPE '!'"); params.push(action.slice(0, -1).replace(/[!%_]/g, '!$&') + '%'); }
      else { where.push('action = ?'); params.push(action); }
    }
    if (q) {
      const p = likePattern(q);
      where.push("(LOWER(COALESCE(target_label, '')) LIKE ? ESCAPE '!' OR LOWER(COALESCE(summary, '')) LIKE ? ESCAPE '!')");
      params.push(p, p);
    }
    // Dates are wall-clock days in the console's zone; `at` is stored UTC.
    const fromUtc = from ? lt.localInputToUtc(from + 'T00:00:00', appConfig) : null;
    const toUtc = to ? lt.localInputToUtc(to + 'T23:59:59', appConfig) : null;
    if (fromUtc) { where.push('at >= ?'); params.push(fromUtc); }
    if (toUtc) { where.push('at <= ?'); params.push(toUtc); }
    const whereSql = where.length ? ' WHERE ' + where.join(' AND ') : '';

    let total = 0, rows = [], err = null;
    try {
      const c = await db.getAsync(`SELECT COUNT(*) AS c FROM admin_audit${whereSql}`, params);
      total = c ? Number(c.c) : 0;
      const pages = Math.max(1, Math.ceil(total / PER_PAGE));
      if (pageNo > pages) pageNo = pages;
      rows = await db.allAsync(
        `SELECT audit_id, at, admin, action, target_kind, target_id, target_label, summary, ip
           FROM admin_audit${whereSql}
          ORDER BY at DESC, audit_id DESC LIMIT ${PER_PAGE} OFFSET ${(pageNo - 1) * PER_PAGE}`, params);
    } catch (e) { err = e; }
    const pages = Math.max(1, Math.ceil(total / PER_PAGE));

    // Drop-downs: the admins and actions that actually occur.
    const admins = (await kit.safeAll(db, 'SELECT DISTINCT admin FROM admin_audit ORDER BY admin', [])).rows.map(r => String(r.admin));
    const actions = (await kit.safeAll(db, 'SELECT DISTINCT action FROM admin_audit ORDER BY action', [])).rows.map(r => String(r.action));
    if (admin && !admins.includes(admin)) admins.push(admin);
    const areas = [...new Set(actions.map(a => a.split('.')[0]))];
    const actionOptions = ['<option value="">All actions</option>'].concat(areas.map(area => {
      const own = actions.filter(a => a.split('.')[0] === area);
      const all = `${area}.*`;
      // A dot-less action (logout) is its own area: no "— all" prefix option.
      const withAll = own.length > 1 || own[0] !== area;
      return `<optgroup label="${escapeHtml(area)}">
        ${withAll ? `<option value="${escapeHtml(all)}" ${action === all ? 'selected' : ''}>${escapeHtml(area)} — all</option>` : ''}
        ${own.map(a => `<option value="${escapeHtml(a)}" ${action === a ? 'selected' : ''}>${escapeHtml(a)}</option>`).join('')}
      </optgroup>`;
    })).join('');
    const adminOptions = ['<option value="">All admins</option>']
      .concat(admins.map(a => `<option value="${escapeHtml(a)}" ${a === admin ? 'selected' : ''}>${escapeHtml(a)}</option>`)).join('');

    const link = (overrides) => {
      const p = new URLSearchParams();
      const all = Object.assign({ admin, action, q, from, to, page: pageNo }, overrides);
      for (const [k, v] of Object.entries(all)) if (v !== '' && v != null && !(k === 'page' && Number(v) === 1)) p.set(k, String(v));
      const s = p.toString();
      return '/audit' + (s ? '?' + s : '');
    };
    const filtered = !!(admin || action || q || from || to);

    const tr = (r) => {
      const target = r.target_label
        ? `<div class="text-slate-900 dark:text-slate-100">${escapeHtml(r.target_label)}</div>
           ${r.target_kind || r.target_id ? `<div class="font-mono text-xs text-slate-400">${escapeHtml([r.target_kind, r.target_id].filter(v => v != null && v !== '').join(' #'))}</div>` : ''}`
        : (r.target_kind || r.target_id ? `<span class="font-mono text-xs text-slate-500">${escapeHtml([r.target_kind, r.target_id].filter(v => v != null && v !== '').join(' #'))}</span>` : '<span class="text-slate-400">—</span>');
      return `<tr>
        <td class="whitespace-nowrap text-xs text-slate-500" title="${escapeHtml(String(r.at || ''))} UTC">${escapeHtml(lt.formatLocal(r.at, appConfig, { second: '2-digit' }) || String(r.at || ''))}</td>
        <td class="font-mono text-xs"><a class="hover:underline" href="${escapeHtml(link({ admin: r.admin, page: 1 }))}">${escapeHtml(r.admin)}</a></td>
        <td class="font-mono text-xs"><a class="hover:underline" href="${escapeHtml(link({ action: r.action, page: 1 }))}">${escapeHtml(r.action)}</a></td>
        <td class="text-sm">${target}</td>
        <td class="text-sm text-slate-700 dark:text-slate-300">${escapeHtml(r.summary || '')}</td>
        <td class="font-mono text-xs text-slate-500 whitespace-nowrap">${escapeHtml(r.ip || '')}</td>
      </tr>`;
    };

    const pager = pages > 1 ? `<div class="mt-4 flex items-center justify-between text-sm">
        <span class="text-slate-500 dark:text-slate-400">Page ${pageNo} of ${pages}</span>
        <div class="flex items-center gap-2">
          ${pageNo > 1 ? `<a class="btn-secondary text-xs px-3 py-1.5" href="${escapeHtml(link({ page: pageNo - 1 }))}">← Newer</a>` : ''}
          ${pageNo < pages ? `<a class="btn-secondary text-xs px-3 py-1.5" href="${escapeHtml(link({ page: pageNo + 1 }))}">Older →</a>` : ''}
        </div>
      </div>` : '';

    const body = `
      ${kit.pageHeader('Audit log', `Who did what in this console — sign-ins and every change, newest first. Times are shown in ${lt.zoneOf(appConfig)}.`)}
      ${flash('error', req.query.error)}
      ${kit.dbBanner(err)}
      <form method="GET" action="/audit" class="card surface-target card-pad mb-6 grid gap-3 md:grid-cols-6 items-end" x-data>
        <div><label class="label" for="au-admin">Admin</label>
          <select id="au-admin" name="admin" class="input py-1.5">${adminOptions}</select></div>
        <div class="md:col-span-2"><label class="label" for="au-action">Action</label>
          <select id="au-action" name="action" class="input py-1.5">${actionOptions}</select></div>
        <div><label class="label" for="au-from">From</label>
          <input id="au-from" class="input py-1.5" type="date" name="from" value="${escapeHtml(from)}"></div>
        <div><label class="label" for="au-to">To</label>
          <input id="au-to" class="input py-1.5" type="date" name="to" value="${escapeHtml(to)}"></div>
        <div class="md:col-span-4"><label class="label" for="au-q">Search target or summary</label>
          <input id="au-q" class="input py-1.5" type="search" name="q" maxlength="200" value="${escapeHtml(q)}" placeholder="e.g. a title, an org name, Published"></div>
        <div class="md:col-span-2 flex items-center gap-2">
          <button type="submit" class="btn-primary">Filter</button>
          ${filtered ? `<a class="btn-secondary" href="/audit">Clear</a>` : ''}
        </div>
      </form>
      <p class="mb-2 text-xs text-slate-500 dark:text-slate-400">${err ? '' : `${total} entr${total === 1 ? 'y' : 'ies'}${filtered ? ' matching' : ''}.`}</p>
      <div class="table-wrap surface-target">
        <table class="table-base">
          <thead><tr><th>When</th><th>Admin</th><th>Action</th><th>Target</th><th>Summary</th><th>IP</th></tr></thead>
          <tbody>${rows.length ? rows.map(tr).join('') : `<tr><td colspan="6" class="text-center py-8 text-slate-400">${err ? 'Unavailable.' : filtered ? 'Nothing matches these filters.' : 'Nothing recorded yet.'}</td></tr>`}</tbody>
        </table>
      </div>
      ${pager}`;
    res.send(page({ title: 'Audit log', body, appConfig, user, activeNav: 'audit' }));
  });

  return router;
}

module.exports = makeRouter;
module.exports.record = record;
