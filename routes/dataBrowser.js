// routes/dataBrowser.js — generic table browser / editor for the web app's
// database (NEW in this console; the car-show reference has no equivalent).
//
//   GET  /data                       → every table in the live DB + row counts
//   GET  /data/:table                → paginated rows (?page, ?per, ?q, ?sort, ?dir)
//   GET  /data/:table/row?key=<json> → view / edit one row (by primary key)
//   POST /data/:table/row/update     → UPDATE one row (by primary key)
//   POST /data/:table/row/delete     → DELETE one row (by primary key)
//   GET  /data/:table/new            → insert form
//   POST /data/:table/insert         → INSERT one row
//
// SAFETY RULES (the whole design hangs on these):
//
//   1. Identifiers (table / column names) come ONLY from the live schema —
//      helpers/dbSchema.js reads sqlite_master + PRAGMA table_info on SQLite
//      (local or remote) and information_schema on MySQL. A table name in
//      the URL is looked up in that list and the CATALOG's copy is used; a
//      sort column must be one of the table's columns; form fields name
//      columns by their POSITION in the live schema (v__3 = 4th column), so
//      no user-supplied string is ever spliced into SQL. Anything that
//      doesn't resolve is refused with a 400 / 404 — never guessed at.
//   2. Values are ALWAYS bound as `?` parameters (search terms, primary-key
//      values, edited cells, LIMIT / OFFSET).
//   3. Password / token hash columns (*password_hash*, *_hash) are shown
//      masked and are read-only here — set passwords from Nonprofits → Reset
//      password, which bcrypts them the same way the web app does. On insert
//      a NOT NULL hash column with no default gets the sentinel 'no_login'
//      (not a valid bcrypt hash, so that account can never authenticate
//      until a real password is set).
//   4. Rows are addressed by primary key only. Tables without a primary key
//      are browsable but read-only. Primary-key columns are not editable
//      (delete + insert instead) so an edit can never silently re-point
//      child rows.
//   5. Deletes go through the shared uiConfirm dialog.
//
// Works on all three engines the console supports: local SQLite, remote
// SQLite (db/remoteSqlite.js — sqlite3 CLI over SSH / SSM; each statement
// is ~1 s over SSM, so pages here do 2–3 round trips), and MySQL. Queries
// are portable: backtick-quoted identifiers (accepted by both engines),
// LIKE … ESCAPE '!' (a backslash escape char is not portable to MySQL's
// default sql_mode), and LIMIT ? OFFSET ?.

const express = require('express');
const { page, flash } = require('../views/layout');
const { escapeHtml, jsAttrStr } = require('../views/escapeHtml');
const { requireAdmin } = require('../middleware/auth');
const dbSchema = require('../helpers/dbSchema');

const PER_PAGE_OPTIONS = [25, 50, 100, 250];
const DEFAULT_PER_PAGE = 50;
const LIST_CELL_MAX = 120;      // characters shown per cell in the row list
const HASH_SENTINEL = 'no_login';
const MASK = '•••••••• (hash — read-only)';

const TEXTAREA_CLS = 'block w-full font-mono text-xs rounded-lg border border-slate-200 bg-white px-3 py-2 text-slate-900 shadow-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100';

function pageHeader(title, subtitle, actions) {
  return `<header class="flex items-start justify-between gap-4 mb-6">
    <div class="min-w-0">
      <h1 class="text-2xl font-bold text-slate-900 dark:text-slate-100 break-words">${title}</h1>
      ${subtitle ? `<p class="mt-1 text-sm text-slate-500 dark:text-slate-400">${subtitle}</p>` : ''}
    </div>
    ${actions ? `<div class="flex items-center gap-2 shrink-0">${actions}</div>` : ''}
  </header>`;
}

function dbBanner(err) {
  if (!err) return '';
  return `<div class="flash-error mb-6">
    <strong class="font-semibold">Database unavailable.</strong>
    ${escapeHtml(err.message || 'unknown error')}. The Data Browser needs the web app's database — check Settings → Web App.
  </div>`;
}

// A refusal page (unknown table / column, malformed key, …).
function refuse(res, appConfig, user, status, title, message) {
  return res.status(status).send(page({
    title,
    body: `${pageHeader(escapeHtml(title))}
      <div class="flash-error mb-6">${escapeHtml(message)}</div>
      <p><a class="text-brand-600 hover:underline" href="/data">← All tables</a></p>`,
    appConfig, user, activeNav: 'data'
  }));
}

// Display form of a cell value (string), or null for SQL NULL.
function cellText(v) {
  if (v === null || v === undefined) return null;
  if (Buffer.isBuffer(v)) return `<binary ${v.length} bytes>`;
  if (v instanceof Date) return v.toISOString().replace('T', ' ').replace(/\..+/, '');
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function isNumericType(col) {
  return /int|real|floa|doub|dec|num|bool|bit/i.test(String(col.type || ''));
}

// Coerce a posted string for binding. Numeric-typed columns get a Number
// when the text is a plain number (so remote SQLite / MySQL see a numeric
// literal); everything else is bound as the string the operator typed.
function coerce(col, raw) {
  const s = String(raw);
  if (isNumericType(col) && /^-?\d+(\.\d+)?$/.test(s.trim())) return Number(s.trim());
  return s;
}

// Resolve :table against the live schema and describe it. Returns
// { table, columns, pk } or sends a refusal and returns null.
async function loadTable(db, req, res, appConfig) {
  const user = req.session.user;
  let table;
  try {
    table = await dbSchema.resolveTable(db, req.params.table);
  } catch (err) {
    res.status(503).send(page({
      title: 'Data Browser',
      body: `${pageHeader('Data Browser')}${dbBanner(err)}`,
      appConfig, user, activeNav: 'data'
    }));
    return null;
  }
  if (!table) {
    refuse(res, appConfig, user, 404, 'Unknown table', `There is no table named "${String(req.params.table).slice(0, 100)}" in the web app's database.`);
    return null;
  }
  const columns = await dbSchema.describeTable(db, table);
  return { table, columns, pk: dbSchema.primaryKey(columns) };
}

// Parse the row key (JSON object of primary-key column → value). It must
// name exactly the table's primary-key columns, each with a scalar value.
// Returns { where, params } (WHERE clause built from catalog names) or
// { error }.
function parseKey(raw, pk) {
  if (!pk.length) return { error: 'This table has no primary key, so rows cannot be addressed individually.' };
  let obj;
  try { obj = JSON.parse(String(raw || '')); } catch (e) { return { error: 'Malformed row key.' }; }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { error: 'Malformed row key.' };
  const keys = Object.keys(obj);
  const pkNames = pk.map(c => c.name);
  if (keys.length !== pkNames.length || !keys.every(k => pkNames.includes(k))) {
    return { error: `The row key must name exactly the primary key (${pkNames.join(', ')}).` };
  }
  const params = [];
  for (const c of pk) {
    const v = obj[c.name];
    if (v === null || (typeof v !== 'string' && typeof v !== 'number')) return { error: `Bad value for key column "${c.name}".` };
    params.push(v);
  }
  return {
    where: pk.map(c => `${dbSchema.quoteIdent(c.name)} = ?`).join(' AND '),
    params,
    obj
  };
}

function keyOf(row, pk) {
  const o = {};
  for (const c of pk) o[c.name] = row[c.name];
  return JSON.stringify(o);
}

function rowHref(table, row, pk) {
  return `/data/${encodeURIComponent(table)}/row?key=${encodeURIComponent(keyOf(row, pk))}`;
}

// Walk the posted body and map every v__<n> / null__<n> / m__<n> field to a
// column by POSITION. Any index that doesn't exist — or names a column the
// operation may not write — is refused, so a tampered form can't reach a
// column the UI didn't offer.
function collectFields(body, columns, allowed) {
  const out = new Map(); // index → { value, isNull, mode }
  for (const name of Object.keys(body || {})) {
    const m = /^(v|null|m)__(\d+)$/.exec(name);
    if (!m) continue;
    const idx = Number(m[2]);
    const col = columns[idx];
    if (!col) return { error: `Unknown column #${idx}.` };
    if (!allowed(col)) return { error: `Column "${col.name}" is read-only here.` };
    const e = out.get(idx) || {};
    if (m[1] === 'v') e.value = String(body[name]);
    else if (m[1] === 'null') e.isNull = body[name] === '1' || body[name] === 'on';
    else e.mode = String(body[name]);
    out.set(idx, e);
  }
  return { fields: out };
}

module.exports = function (db, appConfig) {
  const router = express.Router();

  // ── Table list ──────────────────────────────────────────────────────
  router.get('/data', requireAdmin, async (req, res) => {
    const user = req.session.user;
    let tables = [], err = null;
    try {
      const names = await dbSchema.listTables(db);
      for (const t of names) {
        const cols = await dbSchema.describeTable(db, t);
        let count = null;
        try {
          const r = await db.getAsync(`SELECT COUNT(*) AS c FROM ${dbSchema.quoteIdent(t)}`, []);
          count = r ? Number(r.c) : null;
        } catch (e) { /* leave as unknown */ }
        tables.push({ name: t, columns: cols.length, pk: dbSchema.primaryKey(cols).map(c => c.name), count });
      }
    } catch (e) { err = e; }

    const rows = tables.map(t => `
      <tr class="cursor-pointer" x-data x-on:click="window.location = ${jsAttrStr('/data/' + encodeURIComponent(t.name))}">
        <td class="font-mono font-semibold text-slate-900 dark:text-slate-100">${escapeHtml(t.name)}</td>
        <td class="text-right tabular-nums">${t.count == null ? '—' : t.count}</td>
        <td class="text-right tabular-nums">${t.columns}</td>
        <td class="font-mono text-xs text-slate-500">${t.pk.length ? escapeHtml(t.pk.join(', ')) : '<span class="text-amber-600">none (read-only)</span>'}</td>
      </tr>`).join('');

    const body = `
      ${pageHeader('Data Browser', `Every table in the web app's database (${escapeHtml(db.engine || 'none')}${db.remote ? ', on the web app host' : ''}). Click a table to browse, search, edit, insert, or delete rows.`)}
      ${flash('error', req.query.error)}
      ${flash('success', req.query.msg)}
      ${dbBanner(err)}
      <div class="flash-warn mb-6 text-sm"><strong>Direct database access.</strong> Edits here bypass the web app's own validation. Prefer the dedicated pages — <a class="underline" href="/nonprofits">Nonprofits</a>, <a class="underline" href="/events">Events</a>, <a class="underline" href="/raffles">Raffles</a>, <a class="underline" href="/board">Board</a> — which also keep image files and child rows in step (password hashes are read-only here). Changes are live immediately — no restart.</div>
      <div class="table-wrap surface-target max-w-4xl">
        <table class="table-base">
          <thead><tr><th>Table</th><th class="text-right">Rows</th><th class="text-right">Columns</th><th>Primary key</th></tr></thead>
          <tbody>${rows || `<tr><td colspan="4" class="text-center py-8 text-slate-400">${err ? 'Unavailable.' : 'No tables.'}</td></tr>`}</tbody>
        </table>
      </div>
    `;
    res.send(page({ title: 'Data Browser', body, appConfig, user, activeNav: 'data' }));
  });

  // ── Rows of one table ───────────────────────────────────────────────
  router.get('/data/:table', requireAdmin, async (req, res) => {
    const user = req.session.user;
    const t = await loadTable(db, req, res, appConfig);
    if (!t) return;
    const { table, columns, pk } = t;
    const qt = dbSchema.quoteIdent(table);

    // Sort column: must be one of this table's columns (refuse otherwise).
    let sortCol = null;
    if (req.query.sort !== undefined && req.query.sort !== '') {
      sortCol = columns.find(c => c.name === String(req.query.sort));
      if (!sortCol) {
        return refuse(res, appConfig, user, 400, 'Unknown column', `Table "${table}" has no column named "${String(req.query.sort).slice(0, 100)}".`);
      }
    }
    const orderCols = sortCol ? [sortCol] : (pk.length ? pk : [columns[0]]);
    const dir = String(req.query.dir || '').toLowerCase() === 'desc' ? 'DESC' : 'ASC';
    const orderBy = orderCols.filter(Boolean).map(c => `${dbSchema.quoteIdent(c.name)} ${dir}`).join(', ');

    let per = parseInt(req.query.per, 10);
    if (!PER_PAGE_OPTIONS.includes(per)) per = DEFAULT_PER_PAGE;
    let pageNo = parseInt(req.query.page, 10);
    if (!Number.isInteger(pageNo) || pageNo < 1) pageNo = 1;

    // Search: LIKE across the textual (non-hash) columns, plus exact match
    // on integer columns when the term is a whole number (finds ids).
    const q = String(req.query.q || '').trim().slice(0, 200);
    const where = [], params = [];
    if (q) {
      const pattern = '%' + q.toLowerCase().replace(/[!%_]/g, '!$&') + '%';
      for (const c of columns) {
        if (dbSchema.isHashColumn(c.name)) continue;
        if (dbSchema.isTextColumn(c)) { where.push(`LOWER(${dbSchema.quoteIdent(c.name)}) LIKE ? ESCAPE '!'`); params.push(pattern); }
        else if (/^-?\d+$/.test(q) && /int/i.test(c.type)) { where.push(`${dbSchema.quoteIdent(c.name)} = ?`); params.push(Number(q)); }
      }
      if (!where.length) where.push('1 = 0');
    }
    const whereSql = where.length ? ` WHERE (${where.join(' OR ')})` : '';

    let total = 0, rows = [], err = null;
    try {
      const c = await db.getAsync(`SELECT COUNT(*) AS c FROM ${qt}${whereSql}`, params);
      total = c ? Number(c.c) || 0 : 0;
      const pages = Math.max(1, Math.ceil(total / per));
      if (pageNo > pages) pageNo = pages;
      rows = await db.allAsync(
        `SELECT * FROM ${qt}${whereSql}${orderBy ? ' ORDER BY ' + orderBy : ''} LIMIT ? OFFSET ?`,
        [...params, per, (pageNo - 1) * per]);
    } catch (e) { err = e; }
    const pages = Math.max(1, Math.ceil(total / per));

    // Links keep every other query parameter.
    const link = (over) => {
      const p = Object.assign({ q, per, sort: sortCol ? sortCol.name : '', dir: dir.toLowerCase(), page: pageNo }, over);
      const qs = Object.entries(p).filter(([, v]) => v !== '' && v != null).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
      return `/data/${encodeURIComponent(table)}?${qs}`;
    };

    const head = columns.map(c => {
      const active = sortCol && sortCol.name === c.name;
      const nextDir = active && dir === 'ASC' ? 'desc' : 'asc';
      return `<th class="whitespace-nowrap"><a class="hover:underline" href="${escapeHtml(link({ sort: c.name, dir: nextDir, page: 1 }))}">${escapeHtml(c.name)}${c.pk ? ' <span title="primary key">🔑</span>' : ''}${active ? (dir === 'ASC' ? ' ▲' : ' ▼') : ''}</a></th>`;
    }).join('');

    const bodyRows = rows.map(r => {
      const cells = columns.map(c => {
        if (dbSchema.isHashColumn(c.name)) {
          return `<td class="text-xs text-slate-400 whitespace-nowrap">${r[c.name] == null ? '<em>NULL</em>' : '••••••••'}</td>`;
        }
        const s = cellText(r[c.name]);
        if (s === null) return '<td class="text-xs text-slate-400"><em>NULL</em></td>';
        const shown = s.length > LIST_CELL_MAX ? s.slice(0, LIST_CELL_MAX) + '…' : s;
        return `<td class="text-xs align-top max-w-xs break-words" title="${escapeHtml(s.slice(0, 1000))}">${escapeHtml(shown)}</td>`;
      }).join('');
      const action = pk.length
        ? `<td class="text-right whitespace-nowrap"><a class="btn-secondary text-xs px-2 py-1" href="${escapeHtml(rowHref(table, r, pk))}">Open</a></td>`
        : '<td></td>';
      return `<tr>${cells}${action}</tr>`;
    }).join('');

    const perOpts = PER_PAGE_OPTIONS.map(n => `<option value="${n}" ${n === per ? 'selected' : ''}>${n} / page</option>`).join('');
    const pager = `<div class="flex items-center justify-between gap-3 flex-wrap mt-4 text-sm">
      <span class="text-slate-500 dark:text-slate-400">${total} row${total === 1 ? '' : 's'}${q ? ' matching' : ''} · page ${pageNo} of ${pages}</span>
      <div class="flex items-center gap-2">
        ${pageNo > 1 ? `<a class="btn-secondary text-xs px-3 py-1.5" href="${escapeHtml(link({ page: 1 }))}">« First</a><a class="btn-secondary text-xs px-3 py-1.5" href="${escapeHtml(link({ page: pageNo - 1 }))}">‹ Prev</a>` : ''}
        ${pageNo < pages ? `<a class="btn-secondary text-xs px-3 py-1.5" href="${escapeHtml(link({ page: pageNo + 1 }))}">Next ›</a><a class="btn-secondary text-xs px-3 py-1.5" href="${escapeHtml(link({ page: pages }))}">Last »</a>` : ''}
      </div>
    </div>`;

    const actions = `<a class="btn-secondary" href="/data">← All tables</a>
      <a class="btn-primary" href="/data/${encodeURIComponent(table)}/new"><span aria-hidden="true">＋</span><span>Insert row</span></a>`;

    const body = `
      ${pageHeader(`<span class="font-mono">${escapeHtml(table)}</span>`, `${columns.length} columns · primary key: ${pk.length ? escapeHtml(pk.map(c => c.name).join(', ')) : 'none (rows are read-only)'}. Click a column heading to sort.`, actions)}
      ${flash('error', req.query.error)}
      ${flash('success', req.query.msg)}
      ${dbBanner(err)}
      <form method="GET" action="/data/${encodeURIComponent(table)}" class="mb-4 flex flex-wrap items-center gap-3">
        <input class="input max-w-md" type="text" name="q" value="${escapeHtml(q)}" placeholder="Search text columns (or an id)…" autocomplete="off">
        <select class="input max-w-[9rem]" name="per">${perOpts}</select>
        ${sortCol ? `<input type="hidden" name="sort" value="${escapeHtml(sortCol.name)}"><input type="hidden" name="dir" value="${dir.toLowerCase()}">` : ''}
        <button type="submit" class="btn-secondary">Search</button>
        ${q ? `<a class="text-sm text-brand-600 hover:underline" href="${escapeHtml(link({ q: '', page: 1 }))}">Clear</a>` : ''}
      </form>
      <div class="table-wrap surface-target overflow-x-auto">
        <table class="table-base">
          <thead><tr>${head}<th></th></tr></thead>
          <tbody>${bodyRows || `<tr><td colspan="${columns.length + 1}" class="text-center py-8 text-slate-400">${err ? 'Unavailable.' : (q ? 'No matching rows.' : 'No rows.')}</td></tr>`}</tbody>
        </table>
      </div>
      ${pager}
    `;
    res.send(page({ title: `Data — ${table}`, body, appConfig, user, activeNav: 'data' }));
  });

  // ── One row: view / edit ────────────────────────────────────────────
  router.get('/data/:table/row', requireAdmin, async (req, res) => {
    const user = req.session.user;
    const t = await loadTable(db, req, res, appConfig);
    if (!t) return;
    const { table, columns, pk } = t;
    const key = parseKey(req.query.key, pk);
    if (key.error) return refuse(res, appConfig, user, 400, 'Bad row key', key.error);

    let row, err = null;
    try {
      row = await db.getAsync(`SELECT * FROM ${dbSchema.quoteIdent(table)} WHERE ${key.where}`, key.params);
    } catch (e) { err = e; }
    if (!err && !row) return refuse(res, appConfig, user, 404, 'Row not found', `No row in "${table}" with key ${JSON.stringify(key.obj)}.`);

    const keyJson = JSON.stringify(key.obj);
    const fieldsHtml = row ? columns.map((c, i) => {
      const v = row[c.name];
      const meta = `<span class="font-mono text-xs text-slate-400">${escapeHtml(c.type || 'any')}${c.notnull ? ' · not null' : ''}${c.pk ? ' · primary key' : ''}</span>`;
      const label = `<div class="flex items-baseline justify-between gap-2"><label class="label mb-0 font-mono" for="f-${i}">${escapeHtml(c.name)}</label>${meta}</div>`;
      if (dbSchema.isHashColumn(c.name)) {
        return `<div>${label}<input class="input mt-1" type="text" value="${v == null ? 'NULL' : MASK}" disabled readonly>
          <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">${c.name === 'password_hash' && table === 'users' ? 'Set a new password from <a class="text-brand-600 hover:underline" href="/nonprofits/' + encodeURIComponent(String(row.user_id)) + '">Nonprofits → Reset password</a>.' : 'Hash columns are never editable here.'}</p></div>`;
      }
      if (c.pk) {
        return `<div>${label}<input class="input mt-1 font-mono" type="text" value="${escapeHtml(cellText(v) == null ? 'NULL' : cellText(v))}" disabled readonly>
          <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">Primary key — not editable.</p></div>`;
      }
      if (Buffer.isBuffer(v)) {
        return `<div>${label}<input class="input mt-1" type="text" value="${escapeHtml(cellText(v))}" disabled readonly></div>`;
      }
      const s = cellText(v);
      const isNull = s === null;
      const long = (s && (s.length > 80 || s.includes('\n'))) || /text|clob/i.test(c.type || '');
      const input = long
        ? `<textarea id="f-${i}" name="v__${i}" rows="${Math.min(12, Math.max(3, Math.ceil((s || '').length / 90)))}" class="${TEXTAREA_CLS} mt-1" :disabled="isNull" spellcheck="false">${escapeHtml(s || '')}</textarea>`
        : `<input id="f-${i}" class="input mt-1" type="text" name="v__${i}" value="${escapeHtml(s || '')}" :disabled="isNull" autocomplete="off">`;
      const nullBox = c.notnull ? '' : `<label class="mt-1 inline-flex items-center gap-2 text-xs text-slate-600 dark:text-slate-300">
          <input type="checkbox" name="null__${i}" value="1" x-model="isNull" class="h-3.5 w-3.5"> NULL</label>`;
      return `<div x-data="{ isNull: ${isNull ? 'true' : 'false'} }">${label}${input}${nullBox}</div>`;
    }).join('\n') : '';

    const actions = `<a class="btn-secondary" href="/data/${encodeURIComponent(table)}">← ${escapeHtml(table)}</a>`;
    const body = `
      ${pageHeader(`<span class="font-mono">${escapeHtml(table)}</span> · row ${escapeHtml(pk.map(c => String(key.obj[c.name])).join(' / '))}`, 'Edit values and save. NULL boxes store SQL NULL. Changes are live immediately.', actions)}
      ${flash('error', req.query.error)}
      ${flash('success', req.query.msg)}
      ${dbBanner(err)}
      ${row ? `
      <div class="max-w-3xl space-y-6">
        <form method="POST" action="/data/${encodeURIComponent(table)}/row/update" class="card surface-target card-pad space-y-4">
          <input type="hidden" name="key" value="${escapeHtml(keyJson)}">
          ${fieldsHtml}
          <div class="flex justify-end"><button type="submit" class="btn-primary">Save row</button></div>
        </form>
        <form method="POST" action="/data/${encodeURIComponent(table)}/row/delete" class="card surface-target card-pad flex items-center justify-between gap-4"
              x-data x-on:submit.prevent="window.uiConfirmSubmit($event.target, ${jsAttrStr(`Delete this row from "${table}" (key ${keyJson})? This cannot be undone.`)}, { title: 'Delete row', confirmLabel: 'Delete' })">
          <input type="hidden" name="key" value="${escapeHtml(keyJson)}">
          <p class="text-sm text-slate-600 dark:text-slate-300">Delete this row permanently.${table === 'users' ? ' For nonprofit accounts prefer <a class="text-brand-600 hover:underline" href="/nonprofits">Nonprofits → Delete</a>, which also removes the organization, its child rows and photo files.' : ''}</p>
          <button type="submit" class="btn-danger shrink-0">Delete row</button>
        </form>
      </div>` : ''}
    `;
    res.send(page({ title: `Data — ${table}`, body, appConfig, user, activeNav: 'data' }));
  });

  router.post('/data/:table/row/update', requireAdmin, async (req, res) => {
    const user = req.session.user;
    const t = await loadTable(db, req, res, appConfig);
    if (!t) return;
    const { table, columns, pk } = t;
    const key = parseKey(req.body && req.body.key, pk);
    if (key.error) return refuse(res, appConfig, user, 400, 'Bad row key', key.error);
    const back = `/data/${encodeURIComponent(table)}/row?key=${encodeURIComponent(JSON.stringify(key.obj))}`;

    const { fields, error } = collectFields(req.body, columns, (c) => !c.pk && !dbSchema.isHashColumn(c.name));
    if (error) return refuse(res, appConfig, user, 400, 'Unknown column', error);

    const sets = [], params = [];
    for (const [idx, f] of fields) {
      const col = columns[idx];
      if (f.isNull) {
        if (col.notnull) return res.redirect(back + '&error=' + encodeURIComponent(`"${col.name}" cannot be NULL.`));
        sets.push(`${dbSchema.quoteIdent(col.name)} = NULL`);
      } else if (f.value !== undefined) {
        sets.push(`${dbSchema.quoteIdent(col.name)} = ?`);
        params.push(coerce(col, f.value));
      }
    }
    if (!sets.length) return res.redirect(back + '&error=' + encodeURIComponent('Nothing to save.'));
    try {
      const r = await db.runAsync(`UPDATE ${dbSchema.quoteIdent(table)} SET ${sets.join(', ')} WHERE ${key.where}`, [...params, ...key.params]);
      if (r && r.changes === 0) return res.redirect(`/data/${encodeURIComponent(table)}?error=` + encodeURIComponent('Row not found (it may have been deleted).'));
      console.log(`[data] ${user.username} updated ${table} ${JSON.stringify(key.obj)} (${sets.length} column(s))`);
      res.redirect(back + '&msg=' + encodeURIComponent('Row saved.'));
    } catch (err) {
      console.error('[data] update failed:', err);
      res.redirect(back + '&error=' + encodeURIComponent('Save failed: ' + (err.message || 'unknown error')));
    }
  });

  router.post('/data/:table/row/delete', requireAdmin, async (req, res) => {
    const user = req.session.user;
    const t = await loadTable(db, req, res, appConfig);
    if (!t) return;
    const { table, pk } = t;
    const key = parseKey(req.body && req.body.key, pk);
    if (key.error) return refuse(res, appConfig, user, 400, 'Bad row key', key.error);
    try {
      const r = await db.runAsync(`DELETE FROM ${dbSchema.quoteIdent(table)} WHERE ${key.where}`, key.params);
      if (r && r.changes === 0) return res.redirect(`/data/${encodeURIComponent(table)}?error=` + encodeURIComponent('Row not found (already deleted?).'));
      console.log(`[data] ${user.username} deleted ${table} ${JSON.stringify(key.obj)}`);
      res.redirect(`/data/${encodeURIComponent(table)}?msg=` + encodeURIComponent('Row deleted.'));
    } catch (err) {
      console.error('[data] delete failed:', err);
      res.redirect(`/data/${encodeURIComponent(table)}/row?key=${encodeURIComponent(JSON.stringify(key.obj))}&error=` + encodeURIComponent('Delete failed: ' + (err.message || 'unknown error')));
    }
  });

  // ── Insert ──────────────────────────────────────────────────────────
  // Each column has a mode: "default" (omit it — the engine fills the
  // DEFAULT / auto-increment / NULL), "null", or "value". Hash columns are
  // never offered; see rule 3 at the top for how NOT NULL ones are filled.
  router.get('/data/:table/new', requireAdmin, async (req, res) => {
    const user = req.session.user;
    const t = await loadTable(db, req, res, appConfig);
    if (!t) return;
    const { table, columns } = t;

    const fieldsHtml = columns.map((c, i) => {
      const meta = `<span class="font-mono text-xs text-slate-400">${escapeHtml(c.type || 'any')}${c.notnull ? ' · not null' : ''}${c.pk ? ' · primary key' : ''}${c.dflt != null ? ' · default ' + escapeHtml(String(c.dflt)) : ''}</span>`;
      const label = `<div class="flex items-baseline justify-between gap-2"><span class="label mb-0 font-mono">${escapeHtml(c.name)}</span>${meta}</div>`;
      if (dbSchema.isHashColumn(c.name)) {
        const note = (c.notnull && c.dflt == null)
          ? `Set to <code class="font-mono">${HASH_SENTINEL}</code> (cannot sign in). ${table === 'users' ? 'Set a real password afterwards from Nonprofits → Reset password.' : ''}`
          : 'Left at its default.';
        return `<div>${label}<p class="mt-1 text-xs text-slate-500 dark:text-slate-400">Hash column — not editable here. ${note}</p></div>`;
      }
      const canDefault = c.auto || c.dflt != null || !c.notnull;
      const initial = canDefault ? 'default' : 'value';
      const defLabel = c.auto ? 'auto (generated)' : (c.dflt != null ? 'default' : 'default (NULL)');
      const long = /text|clob/i.test(c.type || '');
      const input = long
        ? `<textarea name="v__${i}" rows="3" class="${TEXTAREA_CLS}" :disabled="mode !== 'value'" spellcheck="false"></textarea>`
        : `<input class="input" type="text" name="v__${i}" :disabled="mode !== 'value'" autocomplete="off">`;
      return `<div x-data="{ mode: '${initial}' }">${label}
        <div class="mt-1 flex items-start gap-2">
          <select class="input max-w-[11rem]" name="m__${i}" x-model="mode">
            ${canDefault ? `<option value="default">${defLabel}</option>` : ''}
            ${c.notnull ? '' : '<option value="null">NULL</option>'}
            <option value="value">value…</option>
          </select>
          <div class="flex-1">${input}</div>
        </div>
      </div>`;
    }).join('\n');

    const actions = `<a class="btn-secondary" href="/data/${encodeURIComponent(table)}">← ${escapeHtml(table)}</a>`;
    const body = `
      ${pageHeader(`Insert into <span class="font-mono">${escapeHtml(table)}</span>`, 'Choose a value for each column, or leave it to the database default.', actions)}
      ${flash('error', req.query.error)}
      <form method="POST" action="/data/${encodeURIComponent(table)}/insert" class="card surface-target card-pad space-y-4 max-w-3xl">
        ${fieldsHtml}
        <div class="flex justify-end"><button type="submit" class="btn-primary">Insert row</button></div>
      </form>
    `;
    res.send(page({ title: `Insert — ${table}`, body, appConfig, user, activeNav: 'data' }));
  });

  router.post('/data/:table/insert', requireAdmin, async (req, res) => {
    const user = req.session.user;
    const t = await loadTable(db, req, res, appConfig);
    if (!t) return;
    const { table, columns, pk } = t;
    const back = `/data/${encodeURIComponent(table)}/new`;

    const { fields, error } = collectFields(req.body, columns, (c) => !dbSchema.isHashColumn(c.name));
    if (error) return refuse(res, appConfig, user, 400, 'Unknown column', error);

    const cols = [], params = [];
    for (const [idx, f] of fields) {
      const col = columns[idx];
      const mode = f.mode || (f.value !== undefined ? 'value' : 'default');
      if (mode === 'default') continue;
      if (mode === 'null') {
        if (col.notnull) return res.redirect(back + '?error=' + encodeURIComponent(`"${col.name}" cannot be NULL.`));
        cols.push(col.name); params.push(null);
      } else if (mode === 'value') {
        cols.push(col.name); params.push(coerce(col, f.value === undefined ? '' : f.value));
      } else {
        return refuse(res, appConfig, user, 400, 'Bad request', `Unknown mode for column "${col.name}".`);
      }
    }
    // NOT NULL hash columns with no default get the unusable sentinel.
    for (const c of columns) {
      if (dbSchema.isHashColumn(c.name) && c.notnull && c.dflt == null) { cols.push(c.name); params.push(HASH_SENTINEL); }
    }
    const sql = cols.length
      ? `INSERT INTO ${dbSchema.quoteIdent(table)} (${cols.map(dbSchema.quoteIdent).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`
      : (db.engine === 'mysql' ? `INSERT INTO ${dbSchema.quoteIdent(table)} () VALUES ()` : `INSERT INTO ${dbSchema.quoteIdent(table)} DEFAULT VALUES`);
    try {
      const r = await db.runAsync(sql, params);
      console.log(`[data] ${user.username} inserted into ${table}${r && r.lastID ? ' (id ' + r.lastID + ')' : ''}`);
      // Land on the new row when its key is knowable: a single auto
      // primary key comes back as lastID; otherwise the posted values.
      let keyObj = null;
      if (pk.length === 1 && pk[0].auto && r && r.lastID) keyObj = { [pk[0].name]: r.lastID };
      else if (pk.length && pk.every(c => cols.includes(c.name))) {
        keyObj = {};
        for (const c of pk) keyObj[c.name] = params[cols.indexOf(c.name)];
      }
      if (keyObj) return res.redirect(`/data/${encodeURIComponent(table)}/row?key=${encodeURIComponent(JSON.stringify(keyObj))}&msg=` + encodeURIComponent('Row inserted.'));
      res.redirect(`/data/${encodeURIComponent(table)}?msg=` + encodeURIComponent('Row inserted.'));
    } catch (err) {
      console.error('[data] insert failed:', err);
      res.redirect(back + '?error=' + encodeURIComponent('Insert failed: ' + (err.message || 'unknown error')));
    }
  });

  return router;
};
