// helpers/pageKit.js — small building blocks shared by the content pages
// (Events, Raffles, Nonprofits, Categories & Cities, Board).
//
// The older pages (Members → now Nonprofits, Locked Users, …) each carried
// their own copy of dbBanner / safeGet / safeAll / sqlTime; the new pages
// share these instead. Same behavior: every DB read goes through safeGet /
// safeAll so a dead database renders a "Database unavailable" banner rather
// than a crash, and every timestamp written is a JS-computed UTC
// 'YYYY-MM-DD HH:MM:SS' string (the web app's sqlTime format) so nothing
// depends on SQLite datetime() or MySQL NOW().
//
// Remote SQLite (db/remoteSqlite.js) rules every caller here follows:
//   * no reads inside db.transaction() — compute first, then write;
//   * no reliance on ON DELETE CASCADE / SET NULL — child rows are deleted
//     (or nulled) explicitly, because each sqlite3 CLI run starts with
//     foreign keys OFF.

const multer = require('multer');
const { escapeHtml } = require('../views/escapeHtml');
const webAppAccess = require('./webAppAccess');
const waConfig = require('./webAppConfig');
const uploads = require('./webAppUploads');

function dbBanner(err) {
  if (!err) return '';
  // A column / table the console expects but the Web App hasn't created yet:
  // the Web App adds them (boot migrations) when it next starts.
  if (/no such column|no such table|unknown column|doesn't exist/i.test(err.message || '')) {
    return `<div class="flash-error mb-6">
    <strong class="font-semibold">Start (or restart) the Web App to finish an update.</strong>
    This console expects database changes the Web App makes when it starts, and they aren't there yet
    (${escapeHtml(err.message || 'unknown error')}). Use Web App Settings → Start / Restart Web App, then reload this page.
  </div>`;
  }
  return `<div class="flash-error mb-6">
    <strong class="font-semibold">Database unavailable.</strong>
    ${escapeHtml(err.message || 'unknown error')}. Some data on this page could not be loaded.
  </div>`;
}

async function safeGet(db, sql, params, fallback) {
  try { return { value: await db.getAsync(sql, params), err: null }; }
  catch (err) { return { value: fallback, err }; }
}
async function safeAll(db, sql, params) {
  try { return { rows: await db.allAsync(sql, params), err: null }; }
  catch (err) { return { rows: [], err }; }
}

function sqlTime(msFromNow = 0) {
  return new Date(Date.now() + msFromNow).toISOString().replace('T', ' ').replace(/\..+/, '');
}

function pageHeader(title, subtitle, actions) {
  return `<header class="flex items-start justify-between gap-4 mb-6">
    <div class="min-w-0">
      <h1 class="text-2xl font-bold text-slate-900 dark:text-slate-100">${escapeHtml(title)}</h1>
      ${subtitle ? `<p class="mt-1 text-sm text-slate-500 dark:text-slate-400">${escapeHtml(subtitle)}</p>` : ''}
    </div>
    ${actions ? `<div class="flex items-center gap-2 flex-wrap justify-end shrink-0">${actions}</div>` : ''}
  </header>`;
}

// Positive integer route param, or null.
function idParam(v) {
  const n = parseInt(v, 10);
  return Number.isInteger(n) && n > 0 && String(n) === String(v) ? n : null;
}

// Trimmed string or null (blank → null). `max` truncates defensively; the
// forms carry matching maxlength attributes.
function str(v, max) {
  if (v === undefined || v === null) return null;
  const s = String(v).replace(/\r\n?/g, '\n').trim();
  if (!s) return null;
  return max ? s.slice(0, max) : s;
}

// URL fields: blank → null; otherwise must be http(s) (mailto allowed where
// noted). Returns { value } or { error }.
function urlField(v, label, allowMailto) {
  const s = str(v, 1000);
  if (!s) return { value: null };
  const ok = allowMailto ? /^(https?:\/\/|mailto:)\S+$/i : /^https?:\/\/\S+$/i;
  if (!ok.test(s)) return { error: `${label} must start with https:// (or http://).` };
  return { value: s };
}

// 'Coyote Cruisers Car & Bike Show!' → 'coyote-cruisers-car-bike-show'
function slugify(s) {
  return String(s || '').toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 80).replace(/-+$/g, '');
}
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// Make `wanted` unique in table.col (both code constants, never user input),
// appending -2, -3, … when taken by a row other than `exceptId`.
async function uniqueSlug(db, table, idCol, wanted, exceptId) {
  const base = wanted || 'item';
  for (let i = 1; i < 200; i++) {
    const cand = i === 1 ? base : `${base.slice(0, 76)}-${i}`;
    const row = await db.getAsync(`SELECT ${idCol} AS id FROM ${table} WHERE slug = ? AND ${idCol} <> ?`, [cand, exceptId || 0]);
    if (!row) return cand;
  }
  throw new Error('Could not find a free slug — choose one by hand.');
}

// Re-number `sort` (1..n) after moving one row up or down among its
// siblings. `table`, `idCol` and `scopeCol` are code constants. Reads happen
// BEFORE the transaction (remote SQLite can't read inside one).
async function moveRow(db, table, idCol, id, dir, scopeCol, scopeVal) {
  const where = scopeCol ? `WHERE ${scopeCol} = ?` : '';
  const rows = await db.allAsync(`SELECT ${idCol} AS id FROM ${table} ${where} ORDER BY sort, ${idCol}`, scopeCol ? [scopeVal] : []);
  const ids = rows.map(r => Number(r.id));
  const i = ids.indexOf(Number(id));
  if (i < 0) return false;
  const j = dir === 'up' ? i - 1 : i + 1;
  if (j < 0 || j >= ids.length) return false;
  [ids[i], ids[j]] = [ids[j], ids[i]];
  await db.transaction(async (tx) => {
    for (let k = 0; k < ids.length; k++) {
      await tx.runAsync(`UPDATE ${table} SET sort = ? WHERE ${idCol} = ?`, [k + 1, ids[k]]);
    }
  });
  return true;
}

// Next sort value at the end of a list.
async function nextSort(db, table, scopeCol, scopeVal) {
  const where = scopeCol ? `WHERE ${scopeCol} = ?` : '';
  const row = await db.getAsync(`SELECT MAX(sort) AS m FROM ${table} ${where}`, scopeCol ? [scopeVal] : []);
  return (row && row.m != null ? Number(row.m) : 0) + 1;
}

// Multipart single-image parser (field "image"). The browser has already
// resized it; the server-side cap is the contract's 8 MB, and the real
// format check (magic bytes) happens in webAppUploads.saveImage.
const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: uploads.MAX_BYTES, files: 1, fields: 10 }
}).single('image');

function wantsJson(req) {
  return (req.get('accept') || '').includes('application/json');
}

// Run multer, then the handler; JSON callers get { ok:false, error } on a
// parse failure or a handler error, form posts get redirected to `back`
// with ?error= (same shape as reply() below, so a plain form post never
// lands on a JSON body).
function withImage(back, handler) {
  return (req, res) => {
    imageUpload(req, res, (err) => {
      const to = typeof back === 'function' ? back(req) : back;
      if (err) {
        const msg = err.code === 'LIMIT_FILE_SIZE' ? 'Image is larger than 8 MB.' : (err.message || 'Upload failed');
        return reply(req, res, to, false, msg);
      }
      Promise.resolve(handler(req, res)).catch((e) => {
        console.error('[upload] handler failed:', e);
        if (res.headersSent) return;
        if (wantsJson(req)) return res.status(500).json({ ok: false, error: e.message || 'Upload failed' });
        reply(req, res, to, false, e.message || 'Upload failed');
      });
    });
  };
}

// Reply to an upload / small action either as JSON (fetch from the page's
// image widget) or as a redirect (plain form post).
function reply(req, res, back, ok, message) {
  if (wantsJson(req)) return res.status(ok ? 200 : 400).json(ok ? { ok: true, message } : { ok: false, error: message });
  return res.redirect(back + (back.includes('?') ? '&' : '?') + (ok ? 'msg=' : 'error=') + encodeURIComponent(message));
}

// The Web App's public URL (remote config.json publicBaseUrl) for "View on
// site" links. One remote read per minute at most — over SSM a read costs
// about a second. '' when it can't be read.
let _pbu = { at: 0, key: '', value: '' };
async function webAppPublicUrl(appConfig) {
  if (!webAppAccess.isConfigured(appConfig)) return '';
  const key = JSON.stringify(appConfig.webApp || {});
  if (_pbu.key === key && Date.now() - _pbu.at < 60000) return _pbu.value;
  let value = '';
  try {
    const { json } = await waConfig.readRemoteConfig(webAppAccess.createAccessorFromConfig(appConfig));
    // Same rules as the Website card: on EC2 the load balancer in front of
    // the instance, on SSH the host — never a localhost address unless the
    // Web App runs on this machine.
    const addr = await require('./websiteCard').resolveWebsiteAddress(appConfig, json || {});
    value = String((addr && addr.url) || '').trim().replace(/\/+$/, '');
  } catch (e) { value = ''; }
  _pbu = { at: Date.now(), key, value };
  return value;
}

// <img> for a stored upload, served through the console's /wa-uploads proxy.
function uploadImg(rel, alt, cls) {
  if (!uploads.isValidRel(rel)) return '';
  return `<img src="/wa-uploads/${escapeHtml(rel)}" alt="${escapeHtml(alt || '')}" loading="lazy" class="${cls || 'h-24 w-auto rounded-lg border border-slate-200 dark:border-slate-700 object-cover'}">`;
}

// The shared upload widget: pick a file → the browser resizes it (canvas,
// ≤1600 px, JPEG ~0.82, /js/image-upload.js) → POST multipart to `action`
// → reload. Works without JS too (plain form post, original file).
// The browser's own file box is hidden (Safari draws a thumbnail icon next to
// the name; every browser words it differently): a "Choose File" button and
// the chosen file's name stand in for it. The real input stays in the label,
// so clicking the button — or Space / Enter when it has focus — opens the
// picker.
function uploadForm(action, label, opts) {
  const o = opts || {};
  return `<form method="POST" action="${escapeHtml(action)}" enctype="multipart/form-data" class="m-0 flex items-center gap-2 flex-wrap"
      x-data="{ busy: false, err: '', name: '' }"
      x-on:submit.prevent="if (!$refs.f.files.length) { err = 'Choose a file first.'; return; }
        busy = true; err = ''; window.macUploadImage($el.action, $refs.f.files[0], { alt: $refs.alt ? $refs.alt.value : '' })
        .then(r => { if (r.ok) window.location.reload(); else { err = r.error || 'Upload failed'; busy = false; } })">
    <label class="inline-flex items-center rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-brand-700 cursor-pointer focus-within:ring-2 focus-within:ring-brand-500 focus-within:ring-offset-2 dark:focus-within:ring-offset-slate-900">
      <input x-ref="f" type="file" name="image" accept="image/jpeg,image/png,image/webp" class="sr-only"
             x-on:change="name = $event.target.files.length ? $event.target.files[0].name : ''; err = ''">
      Choose File
    </label>
    <span class="text-sm text-slate-600 dark:text-slate-300 truncate max-w-[16rem]" x-text="name || 'No file chosen'" :title="name">No file chosen</span>
    ${o.alt ? `<input x-ref="alt" class="input max-w-xs" type="text" name="alt" maxlength="300" placeholder="Describe the photo (alt text)">` : ''}
    <button type="submit" class="btn-secondary text-sm" :disabled="busy">
      <span x-show="!busy">${escapeHtml(label || 'Upload')}</span><span x-show="busy" x-cloak>Uploading…</span>
    </button>
    <span x-show="err" x-cloak class="text-xs text-red-600 dark:text-red-400" x-text="err"></span>
  </form>`;
}

// Is the Web App answering at its public URL? Used before showing a preview
// (the pop-up frames that URL, so it has to be up). From the console server:
// GET <base>/health (liveness — answered even in maintenance mode), then
// GET <base>/api/public/config, which is 503 while maintenance mode is on.
// Resolves { ok: true } or { ok: false, reason: 'offline' | 'maintenance' |
// 'error', message }. Never throws.
async function webAppReachable(base, timeoutMs = 4000) {
  const get = (path) => fetch(base + path, { signal: AbortSignal.timeout(timeoutMs), redirect: 'manual', headers: { Accept: 'application/json' } });
  try {
    const h = await get('/health');
    if (!h.ok) return { ok: false, reason: 'error', message: `The Web App answered ${h.status} at ${base}/health.` };
  } catch (e) {
    return { ok: false, reason: 'offline', message: `The Web App isn't responding at ${base}.` };
  }
  try {
    const c = await get('/api/public/config');
    if (c.status === 503) return { ok: false, reason: 'maintenance', message: 'The Web App is in maintenance mode, so the preview would only show the maintenance screen.' };
  } catch (e) { /* /health answered; let the preview try */ }
  return { ok: true };
}

function yes(v) { return v === 1 || v === true || v === '1' || v === 'on' || v === 'true'; }

module.exports = {
  dbBanner, safeGet, safeAll, sqlTime, pageHeader, idParam, str, urlField,
  slugify, SLUG_RE, uniqueSlug, moveRow, nextSort,
  withImage, reply, wantsJson, webAppPublicUrl, webAppReachable, uploadImg, uploadForm, yes
};
