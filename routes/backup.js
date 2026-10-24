// routes/backup.js — backup + restore for four things (plus a one-file
// rebuild bundle of the last three):
//
//   1. Console settings  — THIS admin console's own config.json (a subset of
//      top-level keys; see BACKUP_KEYS). Local file.
//   2. Web App configuration — the REMOTE web app's config.json (what the
//      Web App Settings page edits), read/written over the transport
//      (helpers/webAppAccess.js).
//   3. Web App website — the REMOTE HTML fragments (what the Web App Website
//      page edits), over the same transport.
//   4. Web App DATABASE — mmoa_web_app.db (or the MySQL database) itself:
//      nonprofit accounts + profiles, events, raffles, board, categories,
//      cities, tokens, lockouts — every table the live schema has. Read/written through the
//      admin console's OWN db handle, so it works for whichever engine is
//      configured (SQLite local / remote, or MySQL). Exported as a portable,
//      engine-neutral JSON table dump.
//
// All exports are downloadable JSON envelopes; all imports are JSON uploads.
// What's NOT backed up: this console's own sessionKeys (per-host) and
// local_admins.json (separate file, password hashes).
//
// A REBUILD BUNDLE (v2) is the complete snapshot of the Web App — everything
// needed to rebuild its state at that moment, with a manifest (_meta) that
// Verify checks it against:
//   config            config.json
//   localSecrets      local-secrets.json (session signing keys — members stay
//                     signed in after a restore)
//   maintenance       maintenance.json (Maintenance Mode state)
//   website           HTML/<section>.html + HTML/images/*
//   uploads           uploads/** (event flyers / covers, raffle photos,
//                     nonprofit photos, board photos)
//   database          every table of the live catalog, ONE point-in-time
//                     snapshot (see dumpAllTables)
//   templates         this console's raffle text templates (helpers/templates.js)
//   console           this console's own settings export (see buildBackup)
//   _meta             created at, console version, engine, per-table row
//                     counts, every file's sha256 + size, the time window the
//                     files and the database were read in, and the DB image
//                     paths that had no file on disk.
//
// Ported from car_show_admin_console/routes/backup.js; the car-show-only
// tables and the AWS-settings sync are gone, everything else (selective
// restore, type-to-confirm database restore, bundle status window) is kept.

const express = require('express');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const { page, flash, waRestartPrompt } = require('../views/layout');
const { escapeHtml } = require('../views/escapeHtml');
const { requireAdmin } = require('../middleware/auth');
const webAppAccess = require('../helpers/webAppAccess');
const waConfig = require('../helpers/webAppConfig');
const dbSchema = require('../helpers/dbSchema');
const csRestore = require('../helpers/consoleSettingsRestore');
const tpl = require('../helpers/templates');
const CONSOLE_VERSION = (() => { try { return require('../package.json').version || null; } catch (e) { return null; } })();

// Canonical list of editable website fragments (reused from the website route).
const WA_SECTIONS = require('./webAppWebsite').SECTIONS || [];
const WA_SECTION_KEYS = WA_SECTIONS.map(s => s.key);
const WA_WEBSITE_LABELS = WA_SECTIONS.reduce((m, s) => { m[s.key] = s.label; return m; }, {});

// ── Web App rebuild bundles ───────────────────────────────────────────
// One .json file = config + website (HTML sections, images) + uploads
// (uploads/** — event flyers, raffle and nonprofit photos, board photos) +
// database, so a rebuilt Web App comes back in ONE restore instead of
// several. Bundles live on this console's disk (backups/, gitignored) so
// Restore can pick from a list and no browser upload limit fights the
// images; download is offered too. Over SSM a single file read is capped at
// ~24 KB, so an image or upload that can't be captured is listed in
// skippedImages / uploads.skipped and surfaced as a warning rather than
// silently dropped (restores write through writeFileChunked, so size is no
// problem in that direction). Bundles made before v2 may carry
// website.windows (the dropped HTML/windows.json); it is ignored.
const BUNDLE_DIR = path.join(__dirname, '..', 'backups');
const BUNDLE_TYPE = 'web-app-bundle';
// v2 bundles carry local-secrets.json, maintenance.json, the console's
// templates + settings and a manifest; v1 bundles (older consoles) still
// restore, with Verify saying what it could not check.
const BUNDLE_VERSION = 2;
const SECRETS_FILE = 'local-secrets.json';
const MAINT_FILE = 'maintenance.json';
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
// The exact bytes a restore writes for a JSON file (config.json,
// local-secrets.json, maintenance.json) — and therefore what the manifest
// hashes, so Verify can recompute it from the parsed object in the bundle.
const jsonFileText = (obj) => JSON.stringify(obj, null, 2) + '\n';
// Every uploads/<kind>/<file> path a database dump refers to (flyer_path,
// cover_path, org_images.path, raffle_images.path, board photo_path, …):
// found by SHAPE in every string value of every row, so a column added later
// is covered without a list to maintain.
function dbImagePaths(tables) {
  const out = new Set();
  for (const t of Object.keys(tables || {})) {
    for (const row of (Array.isArray(tables[t]) ? tables[t] : [])) {
      for (const v of Object.values(row || {})) if (uploadsHelper.isValidRel(v)) out.add(v);
    }
  }
  return [...out].sort();
}
const BUNDLE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/; // not ".op-status.json"
// Summary sidecar written next to each bundle (<bundle>.json.meta.json) so
// the list page never re-parses a multi-MB bundle — see listBundles.
const META_SUFFIX = '.meta.json';
const isMetaName = (n) => /\.meta\.json$/i.test(String(n || ''));
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg)$/i;
const IMAGES_REL_DIR = 'HTML/images';
const UPLOADS_REL_DIR = 'uploads';
const uploadsHelper = require('../helpers/webAppUploads');
const RESTORE_CONFIRM = 'RESTORE';
const MAINT_TITLE = 'Scheduled maintenance';
const MAINT_MESSAGE = 'We are performing maintenance and will be back shortly.';
// POSIX single-quote for shell args (same helper the website route uses).
const shq = (s) => `'` + String(s).replace(/'/g, `'\\''`) + `'`;
// A JS string literal that is safe INSIDE a double-quoted HTML attribute
// (the Alpine x-data below): single-quoted, with quotes, backslashes and
// angle brackets escaped. JSON.stringify is NOT safe there — its double
// quotes end the attribute early and the rest of the code lands on the page.
const jsStr = (s) => "'" + String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '\\x22').replace(/</g, '\\x3c').replace(/&/g, '\\x26') + "'";
function bundleStamp() {
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  return `${String(d.getFullYear()).slice(-2)}_${p(d.getMonth() + 1)}_${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
// A bundle filename from user input: basename only, .json, no traversal,
// and never a summary sidecar.
function safeBundleName(n) {
  const b = path.basename(String(n || ''));
  return BUNDLE_NAME_RE.test(b) && !b.includes('..') && !isMetaName(b) ? b : null;
}
// backups/ holds the web app's secrets, nonprofit password hashes and
// uploaded images: owner-only directory, owner-only files (the chmod covers
// a directory created by hand or by an older version at the default mode).
function ensureBundleDir() {
  fs.mkdirSync(BUNDLE_DIR, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(BUNDLE_DIR, 0o700); } catch (e) { /* best effort */ }
}
// The stamp is to the second: a second bundle in the same second (two
// operators, a script) must not overwrite the first — append -2, -3, ….
// Run fn over items with at most `n` in flight. File transfers use it:
// over EC2 every piece of every file is its own SSM round trip, and the SSM
// agent runs several commands at once, so 4 files in parallel cut a
// photo-heavy backup / restore to about a quarter of the time.
const FILE_PARALLEL = 4;
// Largest HTML section a restore writes: the editor saves through a 64 KB
// JSON request, so it could never save back anything bigger.
const SECTION_MAX_BYTES = 60 * 1024;
// Largest single image an Image Restore writes (the editor allows 8 MB, the
// web app's portal up to its configured uploads.maxMb).
const RESTORE_IMAGE_MAX = 32 * 1024 * 1024;
// On the first failure no new item is started, and the call only rejects
// once every transfer already in flight has settled — so a failed restore
// is never reported (and its lock released) while files are still being
// written.
async function mapPool(items, n, fn) {
  let i = 0, firstErr = null;
  const worker = async () => {
    while (!firstErr && i < items.length) {
      const k = i++;
      try { await fn(items[k], k); } catch (e) { if (!firstErr) firstErr = e; }
    }
  };
  await Promise.allSettled(Array.from({ length: Math.min(n, items.length) }, worker));
  if (firstErr) throw firstErr;
}

function uniqueBundleName(base) {
  let name = `${base}.json`;
  for (let n = 2; fs.existsSync(path.join(BUNDLE_DIR, name)); n++) name = `${base}-${n}.json`;
  return name;
}
function writeBundleFile(name, data) {
  ensureBundleDir();
  fs.writeFileSync(path.join(BUNDLE_DIR, name), data, { mode: 0o600 });
  try { fs.chmodSync(path.join(BUNDLE_DIR, name), 0o600); } catch (e) { /* best effort */ }
}
// Same rules as views/layout.js (cssUrlSafe / isSafeCssColor) and
// routes/settings.js: a background image is only ever /images/<file>, a
// color only a hex or rgb()/rgba() literal. Applied to an imported `theme`
// section so a tampered settings backup can't put arbitrary text into the
// inline <style> or the Appearance page's Alpine expressions.
function cssUrlSafe(v) {
  return (typeof v === 'string' && /^\/images\/[A-Za-z0-9._-]+$/.test(v)) ? v : '';
}
function isSafeCssColor(v) {
  return typeof v === 'string' && /^#[0-9a-fA-F]{3,8}$|^rgba?\([\d.,\s%]+\)$/.test(v.trim());
}
// Returns { theme, dropped } — dropped = names of the values that were
// replaced with '' because they failed the checks above.
function sanitizeTheme(t) {
  const src = (t && typeof t === 'object' && !Array.isArray(t)) ? t : {};
  const out = Object.assign({}, src);
  const dropped = [];
  out.mode = src.mode === 'dark' ? 'dark' : 'light';
  for (const k of ['login', 'app']) {
    const blk = Object.assign({}, (src[k] && typeof src[k] === 'object' && !Array.isArray(src[k])) ? src[k] : {});
    if (blk.backgroundImage !== undefined && blk.backgroundImage !== '') {
      const safe = cssUrlSafe(blk.backgroundImage);
      if (!safe) dropped.push(`theme.${k}.backgroundImage`);
      blk.backgroundImage = safe;
    }
    if (blk.backgroundColor !== undefined && blk.backgroundColor !== '') {
      if (isSafeCssColor(blk.backgroundColor)) blk.backgroundColor = blk.backgroundColor.trim();
      else { dropped.push(`theme.${k}.backgroundColor`); blk.backgroundColor = ''; }
    }
    for (const ok of ['cardOpacity', 'surfaceOpacity']) {
      if (blk[ok] === undefined) continue;
      const n = Number(blk[ok]);
      if (!Number.isFinite(n)) { dropped.push(`theme.${k}.${ok}`); delete blk[ok]; continue; }
      blk[ok] = Math.min(1, Math.max(0.3, n));
    }
    out[k] = blk;
  }
  return { theme: out, dropped };
}
function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
// Bundles carry base64 images, so allow far more than the 4 MB single-file limit.
const bundleUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 256 * 1024 * 1024, files: 1 },
  fileFilter(req, file, cb) {
    if (!/\.json$/i.test(file.originalname)) return cb(new Error('Please upload a .json bundle.'));
    cb(null, true);
  }
});

// Friendly labels for the selectable restore checkboxes. Unknown keys fall
// back to the raw key name.
const SETTINGS_LABELS = {
  port: 'Port', appTitle: 'App title', appSubtitle: 'App subtitle', publicBaseUrl: 'Public base URL',
  server: 'Server / TLS', sessionKeyMode: 'Session key mode', sessionMaxAgeHours: 'Session max age',
  passwordMinLength: 'Password min length', database: 'Database', security: 'Security',
  theme: 'Appearance (theme + its images)', webApp: 'Web App access (connection + commands)', timeZone: 'Event time zone',
  templates: 'Templates folder'
};
const WA_CONFIG_LABELS = {
  port: 'Port', appTitle: 'App title', appSubtitle: 'App subtitle', orgName: 'Organization name',
  publicBaseUrl: 'Public base URL', server: 'Server / TLS', email: 'Email',
  sessionKeyMode: 'Session key mode', sessionKeys: 'Session keys', sessionMaxAgeHours: 'Session max age',
  passwordMinLength: 'Password min length', passwordResetTokenTtlHours: 'Password reset token TTL',
  allowMemberRegistration: 'Allow nonprofit sign-ups', site: 'Public site info (phone / EIN / Facebook)', uploads: 'Uploads', maintenanceCommand: 'Maintenance command',
  database: 'Database', security: 'Security', aws: 'AWS (SES credentials)'
};
// The only top-level keys of the WEB APP's config.json a restore may write:
// the keys Web App Settings edits (routes/webAppSettings.js FIELDS, grouped
// by their top-level key) plus sessionKeys. Anything else in an uploaded
// file — including keys the web app would treat as commands — is ignored.
const WA_CONFIG_KEYS = Object.keys(WA_CONFIG_LABELS);
// Keys whose values THIS console later runs as shell commands on the web
// app host. A restore leaves them as they are unless the operator ticks
// "also restore commands" — a tampered backup must not be able to plant a
// command that the Maintenance Mode / power-bar buttons then execute.
//   web app config: maintenanceCommand (Web App Website → Maintenance Mode)
//   console settings: webApp.commands.{start,stop,restart} (power bar)
const WA_COMMAND_KEYS = ['maintenanceCommand'];
// Settings that describe the MACHINE the Web App runs on rather than the
// site: the listening port, TLS / proxy setup (server), the database
// connection, and whether AWS credentials come from the instance profile.
// The EC2 install script writes these for the instance it builds, so a full
// restore keeps the host's values by default (opts.keepHostSettings) — a
// bundle made on another machine must not point the new server at a cert,
// port or database it doesn't have.
const WA_HOST_KEYS = ['port', 'server', 'database'];
// Also the host's own, but only when it has a value (a fresh install's
// empty publicBaseUrl takes the bundle's): the public address this server
// answers on — links in emails, og: tags, the console's Open website.
const WA_HOST_KEYS_IF_SET = ['publicBaseUrl'];
const RESTORE_COMMANDS_LABEL = 'Also restore the shell commands in this file (the Web App maintenance command / Start · Stop · Restart commands). Leave this off unless you made the backup yourself — the console runs these on the Web App host.';

// Shape checks for restored Web App config sections (on top of
// webAppSettings.validateConfigValues, which covers numbers / choices):
// text keys are strings, object sections are plain objects (not too deep),
// address / link fields are http(s), session keys look like keys. Prototype
// keys are stripped. Returns [error, …] and mutates `cfg` (stripping only).
const WA_TEXT_KEYS = ['appTitle', 'appSubtitle', 'orgName', 'publicBaseUrl', 'sessionKeyMode', 'maintenanceCommand'];
const WA_OBJECT_KEYS = ['site', 'uploads', 'server', 'database', 'email', 'aws', 'security'];
const WA_URL_PATHS = ['publicBaseUrl', 'site.facebookUrl', 'site.instagramUrl', 'site.youtubeUrl', 'site.xUrl', 'site.nextdoorUrl', 'site.donationUrl'];
function stripProto(v, d = 0) {
  if (d > 10) throw new Error('nested too deeply');
  if (Array.isArray(v)) { v.forEach(x => stripProto(x, d + 1)); return; }
  if (v && typeof v === 'object') for (const k of Object.keys(v)) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') delete v[k]; else stripProto(v[k], d + 1);
  }
}
function validKeyList(a) {
  return Array.isArray(a) && a.length >= 1 && a.every(k => typeof k === 'string' && (k === '' || k.length >= 16));
}
function checkWaConfigShapes(cfg, keys) {
  const errs = [];
  for (const k of keys) {
    const v = cfg[k];
    try { stripProto(v); } catch (e) { errs.push(`${k}: nested too deeply`); continue; }
    if (WA_TEXT_KEYS.includes(k) && v !== undefined && v !== null && (typeof v !== 'string' || v.length > 2000)) errs.push(`${k}: must be text (up to 2000 characters)`);
    if (WA_OBJECT_KEYS.includes(k) && !(v && typeof v === 'object' && !Array.isArray(v))) errs.push(`${k}: must be a group of settings, not ${Array.isArray(v) ? 'a list' : typeof v}`);
    if (k === 'site' && v && typeof v === 'object') for (const [sk, sv] of Object.entries(v)) if (typeof sv === 'string' && sv.length > 2000) errs.push(`site.${sk}: longer than 2000 characters`);
    if (k === 'sessionKeys' && !validKeyList(v)) errs.push('sessionKeys: not a list of signing keys (each at least 16 characters)');
  }
  for (const pth of WA_URL_PATHS) {
    if (!keys.includes(pth.split('.')[0])) continue;
    const v = waConfig.getPath(cfg, pth);
    if (v && (typeof v !== 'string' || !/^https?:\/\/[^\s<>"']+$/i.test(v))) errs.push(`${pth}: must be empty or an http(s) address`);
  }
  return errs;
}

// Normalize a multi-value form field (checkboxes share name="sections") into
// an array of strings.
function normalizeArray(v) {
  if (v === undefined || v === null) return [];
  if (typeof v === 'string') return v ? [v] : [];
  if (Array.isArray(v)) return v.map(String);
  return [];
}

// Top-level keys of THIS console's config.json that participate in backup.
//   Security → 'security', Database → 'database', Appearance → 'theme',
//   Web App access → 'webApp'; the rest are identity / session / server
//   fields without their own tab.
const BACKUP_KEYS = [
  'port', 'appTitle', 'appSubtitle', 'publicBaseUrl',
  'server', 'sessionKeyMode', 'sessionMaxAgeHours', 'passwordMinLength',
  'database', 'security', 'theme', 'webApp', 'timeZone', 'templates'
];

function stripForExport(value) {
  if (Array.isArray(value)) return value.map(stripForExport);
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) {
      if (k.startsWith('_')) continue;
      out[k] = stripForExport(value[k]);
    }
    return out;
  }
  return value;
}
function buildBackup(appConfig) {
  const out = { _meta: {
    type: 'admin-console-settings',
    exportedAt: new Date().toISOString(),
    exportedFrom: os.hostname(),
    appTitle: appConfig.appTitle || '',
    version: 2
  }};
  for (const k of BACKUP_KEYS) {
    if (appConfig[k] !== undefined) out[k] = stripForExport(appConfig[k]);
  }
  // restartPending describes the Web App's current state, not a setting.
  if (out.webApp && typeof out.webApp === 'object') delete out.webApp.restartPending;
  // The Appearance images themselves (files under public/images/), so a
  // restored theme never points at a missing or since-replaced file.
  out._images = csRestore.exportImages(appConfig.theme);
  return out;
}

// Date stamp for backup filenames: YY_MM_DD (local date).
function dateStamp() {
  const d = new Date();
  const yy = String(d.getFullYear()).slice(-2);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yy}_${mm}_${dd}`;
}

// File-upload middleware: JSON only, up to 4 MB (website bundles are larger
// than a single config but still small).
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 4 * 1024 * 1024, files: 1 },
  fileFilter(req, file, cb) {
    const okType = /^application\/(json|octet-stream)$|^text\//.test(file.mimetype);
    const okExt = /\.json$/i.test(file.originalname);
    if (!okType && !okExt) return cb(new Error('Please upload a .json file.'));
    cb(null, true);
  }
});
function uploadJson(redirectBase) {
  return function (req, res, next) {
    upload.single('backup')(req, res, (err) => {
      if (err) {
        console.error('[backup] upload error:', err.message);
        return res.redirect(redirectBase + '?error=' + encodeURIComponent(err.code === 'LIMIT_FILE_SIZE' ? 'That file is larger than the 4 MB limit for this restore.' : err.message));
      }
      next();
    });
  };
}

// Parse the uploaded JSON body into an object, or redirect with an error.
// Returns the parsed object, or null (after redirecting).
// Accept what the browser accepts: a UTF-8 byte-order mark, or UTF-16.
function parseJsonBuffer(buf) {
  const text = (buf[0] === 0xff && buf[1] === 0xfe) ? buf.slice(2).toString('utf16le')
    : (buf[0] === 0xfe && buf[1] === 0xff) ? Buffer.from(buf.slice(2)).swap16().toString('utf16le')
    : buf.toString('utf8');
  return JSON.parse(text.replace(/^\uFEFF/, ''));
}

function parseUpload(req, res) {
  if (!req.file || !req.file.buffer) {
    res.redirect('/backup-restore?error=' + encodeURIComponent('No file received.'));
    return null;
  }
  let parsed;
  try {
    parsed = parseJsonBuffer(req.file.buffer);
  } catch (err) {
    res.redirect('/backup-restore?error=' + encodeURIComponent('Not valid JSON: ' + err.message));
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    res.redirect('/backup-restore?error=' + encodeURIComponent('Backup must be a JSON object.'));
    return null;
  }
  return parsed;
}

// ── UI building blocks ─────────────────────────────────────────────────────
const FILE_INPUT_CLS = 'block w-full text-sm text-slate-600 dark:text-slate-300 file:mr-3 file:rounded-lg file:border-0 file:bg-brand-600 file:px-4 file:py-2 file:text-sm file:font-semibold file:text-white hover:file:bg-brand-700';

function groupHeading(title, desc) {
  return `<div class="mt-8 mb-3">
    <h2 class="text-lg font-semibold text-slate-900 dark:text-slate-100">${title}</h2>
    <p class="text-sm text-slate-500 dark:text-slate-400">${desc}</p>
  </div>`;
}

function downloadBtn(href) {
  return `<div class="mt-5"><a class="btn-primary" href="${href}" download>
    <span aria-hidden="true">⤓</span> <span>Download backup</span>
  </a></div>`;
}

// A self-contained restore form with SECTION SELECTION. The browser parses
// the uploaded JSON, lists the sections it contains as checkboxes, and only
// the checked ones are submitted (name="sections") and restored server-side.
//   kind      — 'settings' | 'waconfig' | 'wawebsite' (drives what counts as a section)
//   validKeys — array to constrain selectable keys, or null (any top-level key)
//   labelMap  — {key: friendly label}
//   commandsOpt — when true, adds the "also restore commands" checkbox
//               (name="restore_commands"); without it the handler keeps the
//               live shell commands (see WA_COMMAND_KEYS)
function selectiveRestoreForm(kind, action, confirmText, headsHtml, validKeys, labelMap, commandsOpt, extraHtml) {
  const validJson = escapeHtml(JSON.stringify(validKeys || null));
  const labelJson = escapeHtml(JSON.stringify(labelMap || {}));
  return `<form method="POST" action="${action}" enctype="multipart/form-data" class="mt-5 space-y-4"
                data-kind="${kind}" data-valid="${validJson}" data-labels="${labelJson}"
                x-data="{
                  fileName: '', parseError: '', sections: [], selected: [], confirmed: false, cmdPreview: '',
                  get canSubmit() { return this.sections.length > 0 && this.selected.length > 0 && this.confirmed; },
                  selectAll(v) { this.selected = v ? this.sections.map(s => s.key) : []; },
                  onFile(e) {
                    this.fileName = ''; this.parseError = ''; this.sections = []; this.selected = []; this.confirmed = false; this.cmdPreview = '';
                    const f = e.target.files && e.target.files[0];
                    if (!f) return;
                    this.fileName = f.name;
                    const ds = this.\$root.dataset;
                    const knd = ds.kind;
                    const valid = JSON.parse(ds.valid || 'null');
                    const labels = JSON.parse(ds.labels || '{}');
                    const reader = new FileReader();
                    reader.onload = () => {
                      let parsed;
                      try { parsed = JSON.parse(reader.result); } catch (err) { this.parseError = 'Not valid JSON: ' + err.message; return; }
                      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) { this.parseError = 'Backup must be a JSON object.'; return; }
                      const metaType = parsed._meta && parsed._meta.type;
                      let keys = [];
                      if (knd === 'wawebsite') {
                        if (metaType !== 'web-app-website') { this.parseError = 'This is not a Web App website backup.'; return; }
                        const secs = parsed.sections || {};
                        keys = Object.keys(secs).filter(k => typeof secs[k] === 'string');
                        if (valid) keys = keys.filter(k => valid.includes(k));
                        for (const k of keys) labels[k] = (labels[k] || k) + ' — ' + (new Blob([secs[k]]).size / 1024).toFixed(1) + ' KB';
                      } else if (knd === 'waconfig') {
                        if (metaType && metaType !== 'web-app-config') { this.parseError = 'This is not a Web App config backup.'; return; }
                        const cfg = (parsed.config && typeof parsed.config === 'object') ? parsed.config : parsed;
                        keys = Object.keys(cfg).filter(k => !k.startsWith('_'));
                        if (parsed.localSecrets && typeof parsed.localSecrets === 'object') keys.push('localSecrets');
                        if (valid) keys = keys.filter(k => valid.includes(k));
                        this.cmdPreview = typeof cfg.maintenanceCommand === 'string' ? cfg.maintenanceCommand : '';
                      } else {
                        if (metaType !== 'admin-console-settings') { this.parseError = 'This is not a console settings backup (download one with Backup above).'; return; }
                        keys = Object.keys(parsed).filter(k => !k.startsWith('_'));
                        if (valid) keys = keys.filter(k => valid.includes(k));
                      }
                      if (!keys.length) { this.parseError = 'No restorable sections found in that file.'; return; }
                      this.sections = keys.map(k => ({ key: k, label: labels[k] || k }));
                      this.selected = keys.slice();
                    };
                    reader.onerror = () => { this.parseError = 'Could not read the file.'; };
                    reader.readAsText(f);
                  }
                }">
    ${headsHtml || ''}
    <div>
      <label class="label">Backup file (.json)</label>
      <input class="${FILE_INPUT_CLS}" type="file" name="backup" accept="application/json,.json" required
             x-on:change="onFile(\$event)">
      <p class="mt-2 text-xs text-slate-500" x-show="fileName" x-cloak>Selected: <span class="font-mono" x-text="fileName"></span></p>
      <p class="mt-2 text-xs text-red-600 dark:text-red-400" x-show="parseError" x-cloak x-text="parseError"></p>
    </div>

    <div x-show="sections.length" x-cloak class="rounded-lg border border-slate-200 dark:border-slate-700 p-3">
      <div class="flex items-center justify-between mb-2">
        <span class="text-sm font-medium text-slate-700 dark:text-slate-200">Sections to restore</span>
        <span class="text-xs text-slate-500 dark:text-slate-400">
          <button type="button" class="hover:underline" x-on:click="selectAll(true)">Select all</button> ·
          <button type="button" class="hover:underline" x-on:click="selectAll(false)">None</button>
        </span>
      </div>
      <div class="space-y-1 max-h-60 overflow-y-auto">
        <template x-for="s in sections" :key="s.key">
          <label class="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200">
            <input type="checkbox" name="sections" :value="s.key" x-model="selected">
            <span x-text="s.label"></span>
            <span class="font-mono text-xs text-slate-400" x-text="'(' + s.key + ')'" x-show="s.label !== s.key"></span>
          </label>
        </template>
      </div>
    </div>

    ${commandsOpt ? `<label class="flex items-start gap-2 text-xs text-amber-700 dark:text-amber-300" x-show="sections.length" x-cloak>
      <input type="checkbox" name="restore_commands" value="1" class="mt-0.5">
      <span>${escapeHtml(typeof commandsOpt === 'string' ? commandsOpt : RESTORE_COMMANDS_LABEL)}
        <span x-show="cmdPreview" x-cloak class="block mt-1 text-slate-600 dark:text-slate-300">The file's maintenance command: <code class="font-mono break-all" x-text="cmdPreview"></code></span></span>
    </label>` : ''}
    ${extraHtml || ''}
    <label class="flex items-start gap-2 text-sm text-slate-700 dark:text-slate-200" x-show="sections.length" x-cloak>
      <input type="checkbox" x-model="confirmed" class="mt-0.5">
      <span>${confirmText}</span>
    </label>
    <div class="flex justify-end">
      <button type="submit" class="btn-danger" :disabled="!canSubmit" :class="canSubmit ? '' : 'opacity-50 cursor-not-allowed'">
        Restore selected
      </button>
    </div>
  </form>`;
}

function notConfiguredCard() {
  return `<div class="card surface-target card-pad text-sm text-slate-500 dark:text-slate-400">
    Web App access is not configured. Set it under
    <a class="text-brand-600 hover:underline" href="/settings/web-app">Settings → Web App</a>
    to enable these backups.
  </div>`;
}

// Database restore form — a FULL restore, so no per-section selection: it's
// all-or-nothing and destructive, gated by a type-to-confirm ("RESTORE").
function databaseRestoreForm(action, engine) {
  return `<form method="POST" action="${action}" enctype="multipart/form-data" class="mt-5 space-y-4"
    x-data="{
      fileName: '', parseError: '', ok: false, meta: null, confirmText: '', fit: [],
      get canSubmit() { return this.ok && this.confirmText.trim() === 'RESTORE'; },
      onFile(e) {
        this.fileName = ''; this.parseError = ''; this.ok = false; this.meta = null; this.confirmText = ''; this.fit = [];
        const f = e.target.files && e.target.files[0]; if (!f) return;
        this.fileName = f.name;
        const r = new FileReader();
        r.onload = () => {
          let p; try { p = JSON.parse(r.result); } catch (err) { this.parseError = 'Not valid JSON: ' + err.message; return; }
          if (!p || typeof p !== 'object' || Array.isArray(p)) { this.parseError = 'Backup must be a JSON object.'; return; }
          const t = p._meta && p._meta.type;
          if (t !== 'web-app-database') { this.parseError = 'This is not a Web App database backup.'; return; }
          if (!p.tables || typeof p.tables !== 'object' || Array.isArray(p.tables)) { this.parseError = 'No database tables found in that file.'; return; }
          this.meta = p._meta || {}; this.ok = true;
          fetch('/backup-restore/database/schema', { headers: { Accept: 'application/json' } }).then(x => x.json()).then(d => {
            if (!d.ok) return;
            const live = d.tables, file = p.tables, out = [];
            const emptied = Object.keys(live).filter(k => !(k in file));
            const skipped = Object.keys(file).filter(k => !(k in live));
            if (emptied.length) out.push('Will be left EMPTY (not in the file): ' + emptied.join(', '));
            if (skipped.length) out.push('Not in this database, skipped: ' + skipped.join(', '));
            for (const k of Object.keys(live)) {
              const rows = Array.isArray(file[k]) ? file[k] : null; if (!rows || !rows.length) continue;
              const seen = new Set(); rows.forEach(r => r && typeof r === 'object' && Object.keys(r).forEach(c => seen.add(c)));
              const absent = live[k].filter(c => !seen.has(c)), extra = [...seen].filter(c => !live[k].includes(c));
              if (absent.length) out.push(k + ': older backup, no ' + absent.join(', ') + ' (defaults until the Web App restarts)');
              if (extra.length) out.push(k + ': newer backup, column(s) dropped: ' + extra.join(', '));
            }
            this.fit = out;
          }).catch(() => {});
        };
        r.onerror = () => { this.parseError = 'Could not read the file.'; };
        r.readAsText(f);
      }
    }">
    <div class="flash-error text-xs"><strong>Danger:</strong> this REPLACES the entire <code class="font-mono">${escapeHtml(engine)}</code> database — every nonprofit account and profile, event, raffle, board role, category, city, token and lockout — with the uploaded file. Image files under uploads/ are not touched (they are in a rebuild bundle, not here). Existing data is deleted. Stop the Web App (or enable Maintenance Mode) before restoring.</div>
    <div>
      <label class="label">Database backup file (.json)</label>
      <input class="${FILE_INPUT_CLS}" type="file" name="backup" accept="application/json,.json" required x-on:change="onFile(\$event)">
      <p class="mt-2 text-xs text-slate-500" x-show="fileName" x-cloak>Selected: <span class="font-mono" x-text="fileName"></span></p>
      <ul class="mt-2 text-xs text-amber-700 dark:text-amber-300 list-disc pl-5 space-y-0.5" x-show="ok && fit.length" x-cloak><template x-for="w in fit"><li x-text="w"></li></template></ul>
      <p class="mt-2 text-xs text-slate-500" x-show="ok && meta" x-cloak>Backup engine: <span class="font-mono" x-text="(meta && meta.engine) || 'unknown'"></span> · <span x-text="(meta && meta.tableCount) ?? '?'"></span> tables · <span x-text="(meta && meta.rowCount) ?? '?'"></span> rows</p>
      <p class="mt-2 text-xs text-red-600 dark:text-red-400" x-show="parseError" x-cloak x-text="parseError"></p>
    </div>
    <div x-show="ok" x-cloak>
      <label class="label">Type <span class="font-mono font-semibold">RESTORE</span> to confirm</label>
      <input class="input" type="text" name="confirm_text" autocomplete="off" x-model="confirmText" placeholder="RESTORE">
    </div>
    <div class="flex justify-end">
      <button type="submit" class="btn-danger" :disabled="!canSubmit" :class="canSubmit ? '' : 'opacity-50 cursor-not-allowed'">Restore database</button>
    </div>
  </form>`;
}

module.exports = function (db, appConfig, appConfigModule) {
  const router = express.Router();
  const audit = require('../helpers/audit')(db);

  // ── Database backup/restore helpers (engine-aware) ──────────────────────
  // Identifiers only ever come from the LIVE schema (helpers/dbSchema.js),
  // never from the uploaded file, so a crafted backup can't inject SQL.
  const quoteIdent = dbSchema.quoteIdent;
  const dbListTables = () => dbSchema.listTables(db);
  const dbListColumns = async (table) => (await dbSchema.describeTable(db, table)).map(c => c.name);

  // ONE point-in-time snapshot of every table in the live catalog:
  //   local SQLite  — all SELECTs inside one BEGIN … COMMIT. The web app's
  //                   file is in WAL mode, so the read transaction sees a
  //                   stable snapshot without blocking the site's writes.
  //   MySQL         — START TRANSACTION WITH CONSISTENT SNAPSHOT (REPEATABLE
  //                   READ) on one pooled connection (database.js, {snapshot}).
  //   remote SQLite — one sqlite3 invocation on the Web App host that runs
  //                   BEGIN, a SELECT per table between marker rows, COMMIT
  //                   (db/remoteSqlite.js dumpTables / splitTableDump); on
  //                   EC2 the output comes back through the temp-file +
  //                   readFileChunked path.
  async function dumpAllTables() {
    const tables = await dbListTables();
    const startedAt = new Date().toISOString();
    let out, method;
    if (db.remote && typeof db.dumpTables === 'function') {
      method = 'sqlite3 on the Web App host — one BEGIN…COMMIT invocation';
      out = await db.dumpTables(tables);
    } else {
      method = db.engine === 'mysql'
        ? 'START TRANSACTION WITH CONSISTENT SNAPSHOT (REPEATABLE READ)'
        : 'SQLite read transaction (BEGIN … COMMIT)';
      out = await db.transaction(async (tx) => {
        const o = {};
        for (const t of tables) o[t] = await tx.allAsync(`SELECT * FROM ${quoteIdent(t)}`, []);
        return o;
      }, { snapshot: true });
    }
    const finishedAt = new Date().toISOString();
    const counts = {};
    let rowCount = 0;
    for (const t of tables) { counts[t] = (out[t] || []).length; rowCount += counts[t]; }
    return { tables: out, counts, tableCount: tables.length, rowCount, snapshot: { method, startedAt, finishedAt } };
  }

  async function buildDatabaseBackup() {
    const d = await dumpAllTables();
    return {
      _meta: {
        type: 'web-app-database', engine: db.engine,
        exportedAt: new Date().toISOString(), exportedFrom: os.hostname(),
        version: 2, tableCount: d.tableCount, rowCount: d.rowCount, tables: d.counts, snapshot: d.snapshot
      },
      tables: d.tables
    };
  }

  // Coerce a backed-up value to something bindable. The web-app schema is
  // TEXT/INTEGER/TIMESTAMP only; an object (defensive) is JSON-stringified.
  function bindVal(v) {
    if (v === null || v === undefined) return null;
    if (typeof v === 'object') return JSON.stringify(v);
    return v;
  }

  // Compare a bundle's tables with the LIVE schema before anything is
  // written. errors = the load would fail (a required column with no value
  // and no default), warnings = it would silently lose or blank something
  // (a table the live DB lacks, a live table the bundle lacks, columns the
  // live DB doesn't have).
  async function schemaCheck(backupTables) {
    const errors = [], warnings = [];
    if (!backupTables || typeof backupTables !== 'object' || Array.isArray(backupTables)) return { errors: ['the bundle has no database tables'], warnings };
    const live = await dbListTables();
    const liveSet = new Set(live);
    const has = (t) => Object.prototype.hasOwnProperty.call(backupTables, t);
    const extra = Object.keys(backupTables).filter(t => !liveSet.has(t));
    const missing = live.filter(t => !has(t));
    if (extra.length) warnings.push(`${extra.length} table(s) in the bundle don't exist here and will be skipped: ${extra.join(', ')}`);
    if (missing.length) warnings.push(`${missing.length} table(s) here are not in the bundle and will be left EMPTY: ${missing.join(', ')}`);
    const described = await dbSchema.describeTables(db, live.filter(has));
    for (const [t, cols] of described) {
      const rows = backupTables[t];
      if (!Array.isArray(rows)) { errors.push(`${t} is not a list of rows`); continue; }
      const names = new Set(cols.map(c => c.name));
      const unknown = new Set();
      let nonObj = 0;
      for (const r of rows) {
        if (!r || typeof r !== 'object' || Array.isArray(r)) { nonObj++; continue; }
        for (const k of Object.keys(r)) if (!names.has(k)) unknown.add(k);
      }
      if (nonObj) errors.push(`${t}: ${nonObj} row(s) are not records`);
      const nulAt = rows.findIndex(r => r && typeof r === 'object' && Object.values(r).some(v => typeof v === 'string' && v.includes('\u0000')));
      if (nulAt !== -1) errors.push(`${t}: row ${nulAt + 1} has a NUL character in a value (it would be cut off / corrupt the load)`);
      if (unknown.size) warnings.push(`${t}: column(s) not in this database will be dropped: ${[...unknown].join(', ')}`);
      if (rows.length) {
        const seen = new Set();
        for (const r of rows) if (r && typeof r === 'object') for (const k of Object.keys(r)) seen.add(k);
        const absent = cols.filter(c => !seen.has(c.name)).map(c => c.name);
        if (absent.length) warnings.push(`${t}: the bundle has no ${absent.join(', ')} (made by an older version) — those columns get their defaults until the Web App restarts and re-runs its upgrades; RESTART the Web App before letting visitors in`);
      }
      for (const c of cols) {
        if (!c.notnull || c.dflt != null || c.auto) continue;
        const i = rows.findIndex(r => r && typeof r === 'object' && (r[c.name] === undefined || r[c.name] === null));
        if (i !== -1) errors.push(`${t}: row ${i + 1} has no value for required column ${c.name}`);
      }
    }
    return { errors, warnings };
  }

  // The restore REPLACES the whole database, as the form promises: EVERY
  // live table is emptied (alphabetical order, FK checks off), then the
  // tables the backup also has are reloaded. A live table the backup lacks
  // ends up empty; a backup table the live schema lacks is skipped. Both are
  // reported in `warnings` so the result never hides what happened.
  async function restoreDatabase(backupTables) {
    const has = (t) => Object.prototype.hasOwnProperty.call(backupTables, t);
    const liveTables = await dbListTables(); // ORDER BY name
    const liveSet = new Set(liveTables);
    const targets = liveTables.filter(has);
    const clearedOnly = liveTables.filter(t => !has(t));
    const notLive = Object.keys(backupTables).filter(t => !liveSet.has(t));
    const colsByTable = {};
    for (const t of targets) colsByTable[t] = new Set(await dbListColumns(t));

    const sc = await schemaCheck(backupTables);
    if (sc.errors.length) throw new Error('The backup does not fit this database — nothing was changed: ' + sc.errors.join('; '));
    let fkProblems = [];
    const doWork = async (tx) => {
      for (const t of liveTables) {
        await tx.runAsync(`DELETE FROM ${quoteIdent(t)}`, []);
        if (!has(t)) continue;
        const rows = Array.isArray(backupTables[t]) ? backupTables[t] : [];
        const cols = colsByTable[t];
        for (const row of rows) {
          const keys = Object.keys(row || {}).filter(k => cols.has(k));
          if (!keys.length) continue;
          const sql = `INSERT INTO ${quoteIdent(t)} (${keys.map(quoteIdent).join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`;
          try { await tx.runAsync(sql, keys.map(k => bindVal(row[k]))); }
          catch (e) { throw new Error(`table ${t}, row ${rows.indexOf(row) + 1}: ${e.message || e}`); }
        }
      }
      // Local SQLite can list references to rows that don't exist (FKs are
      // off for the load). Reported, not fatal: the remote driver doesn't
      // enforce FKs at all, so a live site can legitimately have some.
      if (db.engine === 'sqlite' && !db.remote) {
        try {
          const v = await tx.allAsync('PRAGMA foreign_key_check', []);
          const by = {};
          for (const r of v) by[r.table] = (by[r.table] || 0) + 1;
          fkProblems = Object.keys(by).map(t => `${t} (${by[t]})`);
        } catch (e) { /* informational only */ }
      }
    };

    // Disable FK enforcement during the wipe+reload so table order doesn't
    // matter — engine-specific mechanism (the whole point of "check config").
    if (db.engine === 'mysql') {
      await db.transaction(async (tx) => {
        await tx.runAsync('SET FOREIGN_KEY_CHECKS = 0', []);
        try {
          await doWork(tx);
        } finally {
          // FOREIGN_KEY_CHECKS is a SESSION variable on the pooled
          // connection: put it back whether doWork succeeded or threw —
          // this runs before the wrapper's COMMIT / ROLLBACK and release,
          // so the next request to get this connection never runs with FK
          // checks off. (A statement error doesn't kill a MySQL
          // connection, so the SET still works after a failed INSERT; if
          // the connection itself died, mysql2 drops it from the pool.)
          await tx.runAsync('SET FOREIGN_KEY_CHECKS = 1', []).catch(() => {});
        }
      });
    } else {
      // SQLite: foreign_keys can't be toggled inside a transaction, so bracket it.
      await db.runAsync('PRAGMA foreign_keys = OFF', []);
      try {
        await db.transaction(doWork);
      } finally {
        await db.runAsync('PRAGMA foreign_keys = ON', []).catch(() => {});
      }
    }
    const warnings = sc.warnings.filter(w => !/will be (skipped|left EMPTY)/.test(w));
    if (clearedOnly.length) warnings.push(`${clearedOnly.length} live table(s) not in the backup were emptied: ${clearedOnly.join(', ')}`);
    if (notLive.length) warnings.push(`${notLive.length} table(s) in the backup don't exist in the live schema and were skipped: ${notLive.join(', ')}`);
    if (fkProblems.length) warnings.push(`rows pointing at records that don't exist: ${fkProblems.join(', ')}`);
    return { tables: targets.length, cleared: clearedOnly, skipped: notLive, warnings };
  }

  // ── Web App rebuild: bundle helpers ────────────────────────────────

  // Status of the backup/restore in flight (one at a time), readable at
  // GET /backup-restore/bundle/status. The browser's status window polls it,
  // so the operator sees each step as it happens — and if they close the
  // window, reload, or navigate away, the operation keeps running here and
  // the page picks the status back up. Restoring the Web App is
  // backbone work; "is it still going?" must always have an answer.
  // startOp is the ONLY way to claim the slot and it refuses while an
  // operation is running — check and claim happen in one synchronous step,
  // so two requests can't both pass (there is no await in between).
  // Callers must call it BEFORE any await (the access test, the bundle read).
  // The status is also written to backups/.op-status.json on every change,
  // so a console that stopped mid-operation (crash, restart, kill) shows on
  // its next start that the backup / restore was INTERRUPTED and where.
  const OP_FILE = path.join(BUNDLE_DIR, '.op-status.json');
  function saveOp() {
    try { fs.mkdirSync(BUNDLE_DIR, { recursive: true, mode: 0o700 }); fs.writeFileSync(OP_FILE, JSON.stringify(opStatus), { mode: 0o600 }); }
    catch (e) { /* status display only */ }
  }
  // Temp files from a crash, a timed-out piece or a failed clean-up (one can
  // be a full SQL copy of the database, password hashes included). Only ones
  // older than a minute, so a console save in flight right now isn't touched.
  // Run before every restore and every database backup. Returns the count.
  async function sweepTempFiles(accessor) {
    try {
      if (!accessor || !accessor.appPath) return 0;
      const ap = accessor.appPath;
      const dirs = [ap, waConfig.joinPath(ap, 'HTML'), waConfig.joinPath(ap, IMAGES_REL_DIR), ...uploadsHelper.KINDS.map(k => waConfig.joinPath(ap, UPLOADS_REL_DIR + '/' + k))];
      const pat = `\\( -name '*.console-tx.*' -o -name '*.console-out.*' -o -name '*.wa-tmp.*' -o -name '.wa-ls.*' -o -name '.wa-restore-probe' \\)`;
      const cmd = dirs.map(d => `[ -d ${shq(d)} ] && find ${shq(d)} -maxdepth 1 -type f ${pat} -mmin +1 -print -exec rm -f {} \\;`).join('; ') + '; true';
      const sw = await accessor.runCommand(cmd, { timeoutMs: 60000, comment: 'remove stale temp files' });
      return String(sw.stdout || '').split('\n').filter(Boolean).length;
    } catch (e) { return 0; }
  }

  // Upload paths the LIVE database points at (only the tables that hold
  // them) — files a clean-up must never remove.
  async function liveImagePaths() {
    const out = {};
    try {
      const live = new Set(await dbListTables());
      for (const t of ['org_images', 'events', 'raffles', 'raffle_images', 'board_members']) {
        if (live.has(t)) out[t] = await db.allAsync(`SELECT * FROM ${quoteIdent(t)}`, []);
      }
    } catch (e) { return null; }
    return dbImagePaths(out);
  }

  // backups/.restore-log.jsonl — one line per database-replacing restore,
  // on the console's own disk: the admin_audit table lives IN the database a
  // restore replaces, so its history is whatever the file carried.
  function restoreLog(req, entry) {
    try {
      fs.mkdirSync(BUNDLE_DIR, { recursive: true, mode: 0o700 });
      fs.appendFileSync(path.join(BUNDLE_DIR, '.restore-log.jsonl'), JSON.stringify({ at: new Date().toISOString(), admin: req.session && req.session.user && req.session.user.username, ip: req.ip, ...entry }) + '\n', { mode: 0o600 });
    } catch (e) { console.warn('[backup] could not write the restore log:', e.message); }
  }
  let opStatus = null;
  try {
    const saved = JSON.parse(fs.readFileSync(OP_FILE, 'utf8'));
    if (saved && typeof saved === 'object') {
      opStatus = saved;
      if (saved.running) {
        const at = (saved.steps || []).find(st => st.state === 'in_progress');
        opStatus = { ...saved, running: false, ok: false, interrupted: true, finishedAt: null,
          error: `INTERRUPTED — the console stopped while this ${saved.kind} was running${at ? ` (during "${at.step}")` : ''}. ${/restore/.test(saved.kind) ? 'Run the restore again to finish it.' : 'Run the backup again.'}` };
        for (const st of opStatus.steps || []) if (st.state === 'in_progress') st.state = 'failed';
        saveOp();
      }
    }
  } catch (e) { /* none yet */ }
  let opSeq = 0;
  function startOp(kind, name) {
    if (opStatus && opStatus.running) return false;
    opStatus = { id: ++opSeq, kind, name: name || null, running: true, ok: null, error: null,
                 startedAt: new Date().toISOString(), finishedAt: null, steps: [] };
    saveOp();
    return true;
  }
  function busyError(res) {
    return res.status(409).json({ ok: false, error: `A ${opStatus.kind} is already running — wait for it to finish.` });
  }
  function mark(step, state, detail) {
    if (!opStatus || !opStatus.running) return; // a finished op's stragglers don't rewrite it
    const s = opStatus.steps.find(x => x.step === step);
    const at = new Date().toISOString();
    if (s) { s.state = state; s.detail = detail || s.detail || ''; s.at = at; }
    else opStatus.steps.push({ step, state, detail: detail || '', at });
    saveOp();
  }
  function finishOp(ok, error) {
    if (!opStatus) return;
    // A failure lands on whichever step was in progress.
    if (!ok) for (const s of opStatus.steps) if (s.state === 'in_progress') { s.state = 'failed'; s.detail = error || s.detail; }
    opStatus.running = false; opStatus.ok = !!ok; opStatus.error = ok ? null : (error || 'failed');
    opStatus.finishedAt = new Date().toISOString();
    saveOp();
  }

  // Structural check of a parsed bundle — the list's badge and the sidecar
  // summary (cheap: no hashing). Reports problems rather than throwing so
  // the page can show them. verifyBundle() below is the full check.
  function summarizeBundle(j) {
    const problems = [];
    const meta = (j && j._meta) || {};
    if (meta.type !== BUNDLE_TYPE) problems.push(`not a Web App bundle (type "${meta.type || 'none'}")`);
    const cfg = j && j.config;
    const cfgOk = !!(cfg && typeof cfg === 'object' && !Array.isArray(cfg));
    if (!cfgOk) problems.push('config: missing');
    const web = (j && j.website) || {};
    const sections = (web.sections && typeof web.sections === 'object')
      ? Object.keys(web.sections).filter(k => typeof web.sections[k] === 'string') : [];
    // A section missing from the bundle is a warning, not a blocker: the
    // restore writes what's there and leaves the rest of the fresh install's
    // files alone. Config and the database are the parts that must exist.
    const warnings = Array.isArray(meta.warnings) ? meta.warnings.slice() : [];
    const missingSections = WA_SECTION_KEYS.filter(k => !sections.includes(k));
    if (!sections.length) problems.push('website: no HTML sections');
    else if (missingSections.length) warnings.push(`website: ${missingSections.length} section(s) not in the bundle (${missingSections.join(', ')}) — those files stay as they are on the host`);
    const images = (web.images && typeof web.images === 'object') ? Object.keys(web.images) : [];
    const up = (j && j.uploads) || {};
    const uploadFiles = (up.files && typeof up.files === 'object') ? Object.keys(up.files).filter(uploadsHelper.isValidRel) : [];
    const dbm = (j && j.database) || {};
    const tables = (dbm.tables && typeof dbm.tables === 'object' && !Array.isArray(dbm.tables)) ? Object.keys(dbm.tables) : [];
    if (!tables.length) problems.push('database: no tables');
    const rows = tables.reduce((n, t) => n + (Array.isArray(dbm.tables[t]) ? dbm.tables[t].length : 0), 0);
    const tplObj = (j && j.templates && typeof j.templates === 'object' && !Array.isArray(j.templates)) ? j.templates : null;
    const templates = tplObj ? Object.keys(tplObj).reduce((n, k) => n + (Array.isArray(tplObj[k]) ? tplObj[k].length : 0), 0) : 0;
    const isObj = (v) => !!(v && typeof v === 'object' && !Array.isArray(v));
    if (Array.isArray(meta.missingFiles) && meta.missingFiles.length && !warnings.some(w => /image path\(s\) in the database (have|had) no file/.test(w))) warnings.push(`${meta.missingFiles.length} image path(s) in the database had no file on the host when the bundle was made: ${meta.missingFiles.join(', ')}`);
    return {
      valid: problems.length === 0, problems,
      version: Number(meta.version) || 1,
      exportedAt: meta.exportedAt || null, exportedFrom: meta.exportedFrom || null, via: meta.via || null,
      consoleVersion: meta.consoleVersion || null,
      engine: (dbm._meta && dbm._meta.engine) || meta.engine || null,
      configKeys: cfgOk ? Object.keys(cfg).filter(k => !k.startsWith('_')).length : 0,
      localSecrets: isObj(j && j.localSecrets), maintenance: isObj(j && j.maintenance),
      sections: sections.length,
      images: images.length, skippedImages: Array.isArray(web.skippedImages) ? web.skippedImages : [],
      uploads: uploadFiles.length, skippedUploads: Array.isArray(up.skipped) ? up.skipped : [],
      tables: tables.length, rows,
      templates, consoleSettings: isObj(j && j.console),
      manifest: isObj(meta.files) && isObj(meta.tables),
      warnings
    };
  }

  // The full check behind the Verify button and the restore gate: the
  // structural summary above PLUS, against the manifest (_meta): every
  // table's row count, every file's sha256, every image path the database
  // refers to, templates, secrets. Returns { valid, checks, summary } where
  // checks = [{ name, ok, level: 'error' | 'warn' | 'info', detail }] —
  // `valid` means no 'error' check failed (warnings never block a restore).
  function verifyBundle(j) {
    const checks = [];
    const add = (name, ok, detail, level) => checks.push({ name, ok: !!ok, level: ok ? 'ok' : (level || 'error'), detail: detail || '' });
    const summary = summarizeBundle(j);
    const meta = (j && j._meta) || {};
    add('JSON parses', true, '');
    add('Manifest (_meta) present', summary.manifest, summary.manifest
      ? `bundle v${summary.version} made ${meta.exportedAt || '?'} by console ${meta.consoleVersion || '?'} on ${meta.exportedFrom || '?'} via ${meta.via || '?'}`
      : `no manifest — bundle v${summary.version} from an older console; row counts and file hashes cannot be checked`, 'warn');
    add('Web App bundle type', meta.type === BUNDLE_TYPE, meta.type === BUNDLE_TYPE ? BUNDLE_TYPE : `type "${meta.type || 'none'}"`);
    add('config.json present', summary.configKeys > 0, summary.configKeys ? `${summary.configKeys} top-level keys` : 'missing');
    add('local-secrets.json present (session keys)', summary.localSecrets, summary.localSecrets ? 'yes' : 'no — the server keeps its own session keys (members of THAT install stay signed in; members from the backed-up site sign in again)', 'warn');
    add('maintenance.json present', summary.maintenance, summary.maintenance ? `yes (enabled: ${!!(j.maintenance && j.maintenance.enabled)})` : 'no — left as it is on the host', 'warn');
    const missingSec = WA_SECTION_KEYS.filter(k => !(j && j.website && j.website.sections && typeof j.website.sections[k] === 'string'));
    add('Website HTML sections', summary.sections > 0 && !missingSec.length, missingSec.length ? `${summary.sections} of ${WA_SECTION_KEYS.length} — missing: ${missingSec.join(', ')}` : `${summary.sections} sections`, summary.sections ? 'warn' : 'error');
    add('Website images', true, `${summary.images} files${summary.skippedImages.length ? `, ${summary.skippedImages.length} skipped when the bundle was made` : ''}`);
    add('Uploads', true, `${summary.uploads} files${summary.skippedUploads.length ? `, ${summary.skippedUploads.length} skipped when the bundle was made` : ''}`);
    // Database: tables + row counts against the manifest.
    const dbm = (j && j.database) || {};
    const tables = (dbm.tables && typeof dbm.tables === 'object' && !Array.isArray(dbm.tables)) ? dbm.tables : {};
    add('Database tables present', summary.tables > 0, summary.tables ? `${summary.tables} tables / ${summary.rows} rows (${summary.engine || '?'})` : 'no tables');
    if (summary.manifest) {
      const want = meta.tables || {};
      const bad = [];
      for (const t of Object.keys(want)) {
        const n = Array.isArray(tables[t]) ? tables[t].length : null;
        if (n !== Number(want[t])) bad.push(`${t}: manifest ${want[t]}, dump ${n === null ? 'missing' : n}`);
      }
      for (const t of Object.keys(tables)) if (!Object.prototype.hasOwnProperty.call(want, t)) bad.push(`${t}: in the dump but not in the manifest`);
      add('Row counts match the manifest', !bad.length, bad.length ? bad.join('; ') : `${Object.keys(want).length} tables checked`);
      const th = meta.tableHashes;
      if (th && typeof th === 'object') {
        const changed = Object.keys(th).filter(t => !Array.isArray(tables[t]) || sha256(Buffer.from(JSON.stringify(tables[t]), 'utf8')) !== th[t]);
        add('Table contents match the manifest', !changed.length, changed.length ? `${changed.length} table(s) changed since the bundle was made: ${changed.join(', ')}` : `${Object.keys(th).length} tables hashed`);
      }
      // Files: sha256 of every manifest entry against the bundle's content.
      const files = meta.files || {};
      const web = (j && j.website) || {};
      const up = (j && j.uploads) || {};
      let checked = 0; const mismatched = [], absent = [];
      for (const key of Object.keys(files)) {
        const want = files[key] && files[key].sha256;
        let buf = null;
        if (key === 'config.json') buf = summary.configKeys ? Buffer.from(jsonFileText(j.config), 'utf8') : null;
        else if (key === SECRETS_FILE) buf = summary.localSecrets ? Buffer.from(jsonFileText(j.localSecrets), 'utf8') : null;
        else if (key === MAINT_FILE) buf = summary.maintenance ? Buffer.from(jsonFileText(j.maintenance), 'utf8') : null;
        else if (/^HTML\/images\//.test(key)) { const n = key.slice('HTML/images/'.length); buf = (web.images && typeof web.images[n] === 'string') ? Buffer.from(web.images[n], 'base64') : null; }
        else if (/^HTML\//.test(key)) { const k = key.slice(5).replace(/\.html$/, ''); buf = (web.sections && typeof web.sections[k] === 'string') ? Buffer.from(web.sections[k], 'utf8') : null; }
        else if (/^uploads\//.test(key)) { const rel = key.slice(8); buf = (up.files && typeof up.files[rel] === 'string') ? Buffer.from(up.files[rel], 'base64') : null; }
        if (!buf) { absent.push(key); continue; }
        checked++;
        if (sha256(buf) !== want) mismatched.push(key);
      }
      const fileProblems = [];
      const unlisted = [
        ...Object.keys((web.images && typeof web.images === 'object') ? web.images : {}).map(n => 'HTML/images/' + n),
        ...Object.keys((up.files && typeof up.files === 'object') ? up.files : {}).map(r => 'uploads/' + r)
      ].filter(k => !Object.prototype.hasOwnProperty.call(files, k));
      if (unlisted.length) fileProblems.push(`${unlisted.length} in the bundle but not in the manifest: ${unlisted.slice(0, 10).join(', ')}${unlisted.length > 10 ? '…' : ''}`);
      if (absent.length) fileProblems.push(`${absent.length} listed in the manifest but not in the bundle: ${absent.slice(0, 10).join(', ')}${absent.length > 10 ? '…' : ''}`);
      if (mismatched.length) fileProblems.push(`${mismatched.length} with a different sha256: ${mismatched.slice(0, 10).join(', ')}${mismatched.length > 10 ? '…' : ''}`);
      add('File hashes match the manifest', !fileProblems.length, fileProblems.length ? fileProblems.join('; ') : `${checked} files, ${fmtBytes(Number(meta.totalBytes) || 0)}`);
    }
    // Every table is a list of row objects (a v1 bundle has no manifest to
    // catch a damaged table, and a non-list would silently restore as empty).
    const shapeBad = [];
    for (const t of Object.keys(tables)) {
      if (!Array.isArray(tables[t])) { shapeBad.push(`${t} is not a list of rows`); continue; }
      const nonObj = tables[t].filter(r => !r || typeof r !== 'object' || Array.isArray(r)).length;
      if (nonObj) shapeBad.push(`${t}: ${nonObj} row(s) are not records`);
    }
    add('Database tables are well formed', !shapeBad.length, shapeBad.length ? shapeBad.join('; ') : `${Object.keys(tables).length} tables`);
    // Every image path the database refers to has a file in the bundle.
    const refs = dbImagePaths(tables);
    const upFiles = (j && j.uploads && j.uploads.files && typeof j.uploads.files === 'object') ? j.uploads.files : {};
    const noFile = refs.filter(r => typeof upFiles[r] !== 'string');
    add('Database image paths have a file in the bundle', !noFile.length, noFile.length
      ? `${noFile.length} of ${refs.length} missing: ${noFile.slice(0, 10).join(', ')}${noFile.length > 10 ? '…' : ''}`
      : `${refs.length} paths checked`, 'warn');
    add('Console templates present', summary.templates > 0, summary.templates ? `${summary.templates} templates` : 'none in the bundle', 'warn');
    add('Console settings present', summary.consoleSettings, summary.consoleSettings ? 'yes (download it from the bundle list to restore it separately)' : 'no', 'info');
    const valid = summary.valid && !checks.some(c => !c.ok && c.level === 'error');
    return { valid, checks, summary };
  }

  // ── Bundle summary sidecars ─────────────────────────────────────────
  // <bundle>.json.meta.json holds summarizeBundle() + the bundle's size and
  // mtime. The list page reads these (plus a statSync per bundle) instead of
  // JSON.parsing every bundle on every page view — a few multi-MB bundles
  // would otherwise block the event loop for seconds each time. Written
  // when a bundle is created or uploaded; a bundle without one (older
  // console, hand-copied file) is parsed ONCE and gets its sidecar then. A
  // sidecar whose size / mtime no longer match the bundle is ignored.
  function metaPath(name) { return path.join(BUNDLE_DIR, name + META_SUFFIX); }
  function writeBundleMeta(name, summary, st) {
    const meta = { version: 1, name, size: st.size, mtimeMs: st.mtimeMs, summary };
    try { fs.writeFileSync(metaPath(name), JSON.stringify(meta), { mode: 0o600 }); }
    catch (e) { console.warn(`[backup] could not write ${name}${META_SUFFIX}: ${e.message}`); }
    return meta;
  }
  function readBundleMeta(name, st) {
    try {
      const m = JSON.parse(fs.readFileSync(metaPath(name), 'utf8'));
      if (m && m.version === 1 && m.size === st.size && m.mtimeMs === st.mtimeMs && m.summary && typeof m.summary === 'object') return m;
    } catch (e) { /* missing or unreadable → re-summarize */ }
    return null;
  }
  function removeBundleMeta(name) {
    try { fs.unlinkSync(metaPath(name)); } catch (e) { /* none, or already gone */ }
  }

  function listBundles() {
    let names = [];
    try { names = fs.readdirSync(BUNDLE_DIR).filter(n => BUNDLE_NAME_RE.test(n) && !isMetaName(n)); } catch (e) { return []; }
    return names.map((n) => {
      const p = path.join(BUNDLE_DIR, n);
      let st; try { st = fs.statSync(p); } catch (e) { return null; }
      let meta = readBundleMeta(n, st);
      if (!meta) {
        let summary;
        try { summary = summarizeBundle(JSON.parse(fs.readFileSync(p, 'utf8'))); }
        catch (e) { summary = { valid: false, problems: ['not valid JSON: ' + e.message], warnings: [], skippedImages: [] }; }
        meta = writeBundleMeta(n, summary, st);
      }
      const made = (meta.summary && meta.summary.exportedAt) || st.mtime.toISOString();
      return { name: n, size: st.size, mtime: made, summary: meta.summary };
    }).filter(Boolean).sort((a, b) => b.mtime.localeCompare(a.mtime));
  }

  function readBundleFile(name) {
    const n = safeBundleName(name);
    if (!n) throw new Error('Bad bundle name.');
    const p = path.join(BUNDLE_DIR, n);
    if (!fs.existsSync(p)) throw new Error(`Bundle ${n} not found.`);
    return { name: n, path: p, bundle: JSON.parse(fs.readFileSync(p, 'utf8')) };
  }

  // Capture everything (see the file header): config, secrets, maintenance
  // state, website (sections, images) and uploads/** via the transport, the
  // database via this console's own handle (one snapshot), this console's
  // templates and settings from its own disk — and a manifest of it all.
  async function buildBundle(progress = () => {}, opts = {}) {
    if (!db || !db.available) throw new Error('Database is not available (Settings → Web App).');
    const accessor = webAppAccess.createAccessorFromConfig(appConfig);
    const warnings = [];
    const files = {}; // manifest: 'relative/path' → { sha256, bytes }
    const addFile = (key, buf) => { files[key] = { sha256: sha256(buf), bytes: buf.length }; };
    const filesStartedAt = new Date().toISOString();

    progress('Configuration', 'in_progress', 'reading config.json, local-secrets.json, maintenance.json');
    const { json: config } = await waConfig.readRemoteConfig(accessor);
    addFile('config.json', Buffer.from(jsonFileText(config), 'utf8'));
    const secretsPath = waConfig.joinPath(accessor.appPath, SECRETS_FILE);
    const maintPath = waConfig.joinPath(accessor.appPath, MAINT_FILE);
    const fragPaths = WA_SECTION_KEYS.map(k => waConfig.joinPath(accessor.appPath, 'HTML/' + k + '.html'));
    const imgDir = waConfig.joinPath(accessor.appPath, IMAGES_REL_DIR);
    const upDirs = uploadsHelper.KINDS.map(k => waConfig.joinPath(accessor.appPath, UPLOADS_REL_DIR + '/' + k));
    const b = await accessor.readBundle({ files: [secretsPath, maintPath, ...fragPaths], dirs: [imgDir, ...upDirs] }, { encoding: 'utf8' });
    // A small JSON file next to config.json: parsed (so the restore writes
    // it back in the same canonical form the manifest hashes), null when
    // the host has none.
    const readJsonFile = (p, label) => {
      const f = b.files[p];
      if (!f || f.missing || f.err || typeof f.content !== 'string') {
        if (f && f.err) warnings.push(`${label} not captured: ${f.err}`);
        return null;
      }
      try {
        const o = JSON.parse(f.content);
        if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error('not a JSON object');
        return o;
      } catch (e) { warnings.push(`${label} is not valid JSON (${e.message}) — not captured`); return null; }
    };
    const localSecrets = readJsonFile(secretsPath, SECRETS_FILE);
    if (localSecrets) addFile(SECRETS_FILE, Buffer.from(jsonFileText(localSecrets), 'utf8'));
    else if (!warnings.some(w => w.startsWith(SECRETS_FILE))) warnings.push(`${SECRETS_FILE} not found on the host — the Web App generates it on first boot; members will sign in again after a restore`);
    let maintenance = readJsonFile(maintPath, MAINT_FILE);
    // The Full Backup flow can turn Maintenance Mode on just for the backup;
    // record the site as it was before that, or restoring this bundle would
    // put the site into maintenance.
    if (maintenance && opts.maintenanceOnForBackup && maintenance.enabled === true) maintenance = { ...maintenance, enabled: false };
    if (maintenance) addFile(MAINT_FILE, Buffer.from(jsonFileText(maintenance), 'utf8'));
    progress('Configuration', 'ok', `${Object.keys(config).filter(k => !k.startsWith('_')).length} top-level keys · ${SECRETS_FILE} ${localSecrets ? 'captured' : 'absent'} · ${MAINT_FILE} ${maintenance ? 'captured' : 'absent'}`);
    progress('Website', 'in_progress', 'HTML sections');

    const sections = {};
    WA_SECTION_KEYS.forEach((k, i) => {
      const f = b.files[fragPaths[i]];
      if (f && typeof f.content === 'string' && !f.err) { sections[k] = f.content; addFile(`HTML/${k}.html`, Buffer.from(f.content, 'utf8')); }
      else warnings.push(`website section "${k}" not captured${f && f.err ? ': ' + f.err : ' (missing on the host)'}`);
    });
    progress('Website', 'ok', `${Object.keys(sections).length} sections`);
    const images = {}, skippedImages = [];
    const allImgNames = ((b.dirs[imgDir] || {}).names || []);
    const names = allImgNames.filter(n => IMAGE_EXT.test(n) && /^[A-Za-z0-9._-]+$/.test(n)).sort();
    const odd = allImgNames.filter(n => !names.includes(n) && !/^(README\.txt|\.gitkeep)$/.test(n) && !n.startsWith('.'));
    if (odd.length) warnings.push(`${odd.length} file(s) in HTML/images not captured (only .png .jpg .gif .webp .svg with plain names — letters, digits . _ - — are backed up): ${odd.join(', ')}`);
    for (const d of [imgDir, ...upDirs]) {
      const e = b.dirs[d] && b.dirs[d].err;
      if (e) throw new Error(`Could not list ${d} on the Web App host: ${e}`);
    }
    progress('Images', 'in_progress', `${names.length} to capture`);
    await mapPool(names, FILE_PARALLEL, async (n) => {
      try {
        const buf = Buffer.from(await accessor.readFile(waConfig.joinPath(imgDir, n)));
        images[n] = buf.toString('base64');
        addFile(`${IMAGES_REL_DIR}/${n}`, buf);
      } catch (e) {
        skippedImages.push(n);
        warnings.push(`image "${n}" skipped: ${e.message || e}`);
      }
    });

    progress('Images', skippedImages.length ? 'warn' : 'ok', `${Object.keys(images).length} captured${skippedImages.length ? `, ${skippedImages.length} skipped` : ''}`);

    // uploads/<kind>/<random>.<ext> — only names matching the uploads
    // contract are captured (stray temp files are not).
    const upNames = [];
    uploadsHelper.KINDS.forEach((k, i) => {
      for (const n of ((b.dirs[upDirs[i]] || {}).names || [])) {
        const rel = `${k}/${n}`;
        if (uploadsHelper.isValidRel(rel)) upNames.push(rel);
      }
    });
    upNames.sort();
    progress('Uploads', 'in_progress', `${upNames.length} to capture`);
    const upFiles = {}, skippedUploads = [];
    let upDone = 0;
    await mapPool(upNames, FILE_PARALLEL, async (rel) => {
      try {
        const buf = Buffer.from(await accessor.readFile(waConfig.joinPath(accessor.appPath, UPLOADS_REL_DIR + '/' + rel)));
        upFiles[rel] = buf.toString('base64');
        addFile(`${UPLOADS_REL_DIR}/${rel}`, buf);
      } catch (e) {
        skippedUploads.push(rel);
        warnings.push(`upload "${rel}" skipped: ${e.message || e}`);
      }
      if (++upDone % 10 === 0) progress('Uploads', 'in_progress', `${upDone} of ${upNames.length}`);
    });
    progress('Uploads', skippedUploads.length ? 'warn' : 'ok', `${Object.keys(upFiles).length} captured${skippedUploads.length ? `, ${skippedUploads.length} skipped` : ''}`);
    const filesFinishedAt = new Date().toISOString();

    progress('Database', 'in_progress', 'one snapshot of every table');
    const database = await buildDatabaseBackup();
    // Cross-check: every image path the dump refers to should be a file we
    // captured. Reported (manifest + Verify), never a failure.
    const missingFiles = dbImagePaths(database.tables).filter(rel => typeof upFiles[rel] !== 'string');
    if (missingFiles.length) warnings.push(`${missingFiles.length} image path(s) in the database have no file on the host: ${missingFiles.join(', ')}`);
    progress('Database', missingFiles.length ? 'warn' : 'ok', `${database._meta.tableCount} tables / ${database._meta.rowCount} rows — ${database._meta.snapshot.method}${missingFiles.length ? ` · ${missingFiles.length} referenced image file(s) missing on the host` : ''}`);

    progress('Console', 'in_progress', 'raffle text templates + console settings');
    let templates = {};
    try { templates = tpl.exportAll(appConfig); }
    catch (e) { warnings.push(`console templates not captured: ${e.message || e}`); }
    const tplCounts = {};
    let tplTotal = 0;
    for (const k of Object.keys(templates)) { tplCounts[k] = templates[k].length; tplTotal += templates[k].length; }
    const consoleSettings = buildBackup(appConfig);
    progress('Console', 'ok', `${tplTotal} templates (${Object.keys(templates).join(', ')}) · ${Object.keys(consoleSettings).filter(k => !k.startsWith('_')).length} settings keys`);

    const totalBytes = Object.values(files).reduce((n, f) => n + f.bytes, 0);
    return {
      _meta: {
        type: BUNDLE_TYPE, version: BUNDLE_VERSION, exportedAt: new Date().toISOString(), exportedFrom: os.hostname(),
        consoleVersion: CONSOLE_VERSION,
        webAppConfigVersion: (config._version !== undefined ? config._version : (config.version !== undefined ? config.version : null)),
        via: accessor.describe(), engine: db.engine, warnings,
        window: { filesStartedAt, filesFinishedAt, dbStartedAt: database._meta.snapshot.startedAt, dbFinishedAt: database._meta.snapshot.finishedAt },
        tables: database._meta.tables, tableCount: database._meta.tableCount, rowCount: database._meta.rowCount,
        tableHashes: Object.fromEntries(Object.keys(database.tables).map(t => [t, sha256(Buffer.from(JSON.stringify(database.tables[t]), 'utf8'))])),
        files, fileCount: Object.keys(files).length, totalBytes,
        templates: { count: tplTotal, kinds: tplCounts },
        secrets: { localSecrets: !!localSecrets },
        missingFiles
      },
      config,
      localSecrets,
      maintenance,
      website: { sections, images, skippedImages },
      uploads: { files: upFiles, skipped: skippedUploads },
      database,
      templates,
      console: consoleSettings
    };
  }

  // Can this console actually do a restore? Read AND write, not just read —
  // a read-only transport would pass every "can I see it" check and then die
  // halfway through writing. Each check reports independently.
  async function testAccess() {
    const checks = [];
    const add = (name, ok, detail) => checks.push({ name, ok: !!ok, detail: detail || '' });
    if (!webAppAccess.isConfigured(appConfig)) {
      add('Web App access configured', false, 'Set it under Settings → Web App');
      return { ok: false, checks };
    }
    const accessor = webAppAccess.createAccessorFromConfig(appConfig);
    add('Web App access configured', true, accessor.describe());
    try {
      const r = await accessor.runCommand('echo __WA_OK__', { cwd: accessor.appPath || undefined, timeoutMs: 60000, comment: 'rebuild access test' });
      add('Run a command on the host', r.code === 0 && /__WA_OK__/.test(r.stdout || ''), r.code === 0 ? '' : (r.stderr || `exit ${r.code}`));
    } catch (e) { add('Run a command on the host', false, e.message || String(e)); }
    try { await waConfig.readRemoteConfig(accessor); add('Read config.json', true, waConfig.remoteConfigPath(accessor)); }
    catch (e) { add('Read config.json', false, e.message || String(e)); }
    const probe = waConfig.joinPath(accessor.appPath, '.wa-restore-probe');
    try {
      await accessor.writeFile(probe, 'restore probe ' + new Date().toISOString() + '\n');
      const there = await accessor.exists(probe);
      add('Write a file in the install directory', there, there ? probe : 'written, but not found afterwards');
    } catch (e) { add('Write a file in the install directory', false, e.message || String(e)); }
    finally { await accessor.runCommand(`rm -f -- ${shq(probe)}`, { timeoutMs: 20000 }).catch(() => {}); }
    try {
      const dir = waConfig.joinPath(accessor.appPath, IMAGES_REL_DIR);
      const r = await accessor.runCommand(`mkdir -p -- ${shq(dir)} && test -w ${shq(dir)} && echo __WA_W__`, { timeoutMs: 20000 });
      add('Write to HTML/images', /__WA_W__/.test(r.stdout || ''), r.stderr || '');
    } catch (e) { add('Write to HTML/images', false, e.message || String(e)); }
    try {
      const dirs = [UPLOADS_REL_DIR, ...uploadsHelper.KINDS.map(k => UPLOADS_REL_DIR + '/' + k)].map(d => waConfig.joinPath(accessor.appPath, d));
      const script = dirs.map(d => `mkdir -p -- ${shq(d)} && test -w ${shq(d)} || echo __WA_NO__${d}`).join('; ') + '; echo __WA_DONE__';
      const r = await accessor.runCommand(script, { timeoutMs: 20000 });
      const no = (r.stdout || '').split('\n').filter(l => l.startsWith('__WA_NO__')).map(l => l.slice(9));
      add('Write to uploads/ and its folders', /__WA_DONE__/.test(r.stdout || '') && !no.length, no.length ? 'not writable: ' + no.join(', ') : (r.stderr || ''));
    } catch (e) { add('Write to uploads/', false, e.message || String(e)); }
    add('Database available', !!(db && db.available), db ? `${db.engine || ''}${db.statusMessage ? ' — ' + db.statusMessage : ''}`.trim() : 'no database handle');
    return { ok: checks.every(c => c.ok), checks };
  }

  // Put back everything the bundle holds. The ORDER is what makes a failed
  // restore safe:
  //   1. database — first, and all-or-nothing (restoreDatabase checks the
  //      bundle against the live schema, then empties and reloads every
  //      table in ONE transaction). If it fails, nothing at all has changed.
  //   2. configuration (config.json + local-secrets.json)
  //   3. website (HTML sections, images) and uploads — written, never yet
  //      removed, so a failure part-way leaves extra files, never missing
  //      ones (re-running the restore finishes the job)
  //   4. console templates
  //   5. removal of website images / uploads the bundle doesn't have
  //      (opts.pruneFiles) — only after every write above succeeded, and
  //      never a file the bundle lists as skipped
  //   6. maintenance.json — last; kept ON when the operator turned
  //      Maintenance Mode on for this restore (opts.keepMaintenanceOn), so
  //      visitors don't see the site before the Web App restarts.
  // Only known web-app config keys are written (WA_CONFIG_KEYS); the
  // maintenance command is kept as the host has it unless
  // opts.restoreCommands; the host's machine settings (WA_HOST_KEYS +
  // aws.runningInAws) are kept unless opts.keepHostSettings === false.
  // Returns { steps, restored, skipped, maintenanceEnabled }.
  async function restoreBundle(bundle, progress = () => {}, opts = {}) {
    const accessor = webAppAccess.createAccessorFromConfig(appConfig);
    const steps = [];
    const restored = [], skipped = [];
    const done = (step, detail, state) => { steps.push({ step, ok: true, detail }); progress(step, state || 'ok', detail); };

    // ── 0. leftovers of an earlier failed / interrupted run ──
    const swept = await sweepTempFiles(accessor);
    if (swept) progress('Clean-up', 'ok', `${swept} leftover temp file(s) from an earlier run removed`);

    // ── 1. database ──
    const tables = (bundle.database && bundle.database.tables && typeof bundle.database.tables === 'object') ? bundle.database.tables : null;
    if (!tables) throw new Error('The bundle has no database tables.');
    progress('Database', 'in_progress', `replacing ${Object.keys(tables).length} tables in one transaction — this is the long step`);
    const r = await restoreDatabase(tables);
    restored.push(`database (${r.tables} tables)`);
    done('Database', `${r.tables} tables replaced${r.warnings.length ? ' — ' + r.warnings.join('; ') : ''}`, r.warnings.length ? 'warn' : 'ok');

    // ── 2. configuration ──
    progress('Configuration', 'in_progress', 'writing config.json');
    const { json } = await waConfig.readRemoteConfig(accessor);
    const cfg = (bundle.config && typeof bundle.config === 'object' && !Array.isArray(bundle.config)) ? bundle.config : {};
    let nKeys = 0;
    const keptCommands = [], ignoredKeys = [], keptHost = [];
    const keepHost = opts.keepHostSettings !== false;
    const hostPortBefore = json.port;
    for (const k of Object.keys(cfg)) {
      if (k.startsWith('_')) continue; // the web app's own _comment keys — the host's copy stays
      if (!WA_CONFIG_KEYS.includes(k)) { ignoredKeys.push(k); continue; }
      if (WA_COMMAND_KEYS.includes(k) && !opts.restoreCommands) {
        if (JSON.stringify(cfg[k]) !== JSON.stringify(json[k])) keptCommands.push(k);
        continue;
      }
      if (keepHost && WA_HOST_KEYS.includes(k)) { keptHost.push(json[k] === undefined ? `${k} (default)` : k); continue; }
      if (keepHost && WA_HOST_KEYS_IF_SET.includes(k) && typeof json[k] === 'string' && json[k].trim()) {
        if (json[k] !== cfg[k]) keptHost.push(`${k} (${json[k]}; the bundle had ${cfg[k] || 'none'})`);
        continue;
      }
      if (keepHost && k === 'aws' && cfg.aws && typeof cfg.aws === 'object') {
        // The bundle's AWS settings, but THIS machine's way of getting
        // credentials (absent on the host = the default, off).
        const hostAws = json.aws && typeof json.aws === 'object' ? json.aws : {};
        json.aws = { ...cfg.aws };
        if (hostAws.runningInAws === undefined) delete json.aws.runningInAws; else json.aws.runningInAws = hostAws.runningInAws;
        if (typeof hostAws.region === 'string' && hostAws.region.trim()) json.aws.region = hostAws.region;
        keptHost.push('aws.runningInAws', 'aws.region'); nKeys++; continue;
      }
      json[k] = cfg[k]; nKeys++;
    }
    // A site setting the bundle doesn't have was at its default when the
    // backup was made — remove it here too so the default applies again.
    const resetKeys = [];
    if (Object.keys(cfg).length) {
      for (const k of WA_CONFIG_KEYS) {
        if (Object.prototype.hasOwnProperty.call(cfg, k) || WA_COMMAND_KEYS.includes(k) || (keepHost && (WA_HOST_KEYS.includes(k) || WA_HOST_KEYS_IF_SET.includes(k))) || k === 'sessionKeys') continue;
        if (json[k] !== undefined) { delete json[k]; resetKeys.push(k); }
      }
    }
    await waConfig.writeRemoteConfig(accessor, json);
    restored.push(`config.json (${nKeys} keys)`);
    const cfgNotes = [];
    if (keptCommands.length) { cfgNotes.push(`${keptCommands.join(', ')} differs from the bundle and was left as on the host (tick "also restore commands" to take it from the bundle)`); skipped.push(keptCommands.join(', ')); }
    if (keptHost.length) cfgNotes.push(`this server's own ${keptHost.join(', ')} kept`);
    if (resetKeys.length) cfgNotes.push(`not in the bundle, back to defaults: ${resetKeys.join(', ')}`);
    if (!keepHost && cfg.port !== undefined && hostPortBefore !== undefined && Number(cfg.port) !== Number(hostPortBefore)) cfgNotes.push(`PORT CHANGED from ${hostPortBefore} to ${cfg.port} (the bundle's) — the Web App will listen there after its restart`);
    if (ignoredKeys.length) cfgNotes.push(`${ignoredKeys.length} unknown key(s) ignored: ${ignoredKeys.join(', ')}`);
    const secrets = (bundle.localSecrets && typeof bundle.localSecrets === 'object' && !Array.isArray(bundle.localSecrets)) ? bundle.localSecrets : null;
    if (secrets) {
      const sp = waConfig.joinPath(accessor.appPath, SECRETS_FILE);
      // Create it private first (a fresh host has none) so the write keeps 0600.
      await accessor.runCommand(`( umask 077; [ -e ${shq(sp)} ] || : > ${shq(sp)} )`, { timeoutMs: 20000 }).catch(() => {});
      await accessor.writeFile(sp, jsonFileText(secrets));
      const cm = await accessor.runCommand(`chmod 600 ${shq(sp)}`, { timeoutMs: 20000 }).catch(e => ({ code: 1, stderr: e.message }));
      restored.push(SECRETS_FILE);
      cfgNotes.push(`${SECRETS_FILE} written (members stay signed in)${cm && cm.code === 0 ? '' : ' — WARNING: could not make it private (chmod 600): ' + ((cm && cm.stderr) || 'failed').trim()}`);
    } else {
      skipped.push(SECRETS_FILE + ' (not in the bundle)');
      cfgNotes.push(`${SECRETS_FILE} not in the bundle — this server's own session keys are kept`);
    }
    done('Configuration', `${nKeys} top-level keys written to config.json${cfgNotes.length ? ' — ' + cfgNotes.join('; ') : ''}`, (keptCommands.length || !secrets) ? 'warn' : 'ok');

    // ── 3. website + uploads (writes only) ──
    progress('Website', 'in_progress', 'HTML sections, images');
    const web = bundle.website || {};
    const secs = (web.sections && typeof web.sections === 'object') ? web.sections : {};
    let nSec = 0;
    for (const k of WA_SECTION_KEYS) {
      if (typeof secs[k] !== 'string') continue;
      await accessor.writeFile(waConfig.joinPath(accessor.appPath, 'HTML/' + k + '.html'), secs[k]);
      nSec++;
    }
    const imgDir = waConfig.joinPath(accessor.appPath, IMAGES_REL_DIR);
    const imgNames = (web.images && typeof web.images === 'object')
      ? Object.keys(web.images).filter(x => IMAGE_EXT.test(x) && /^[A-Za-z0-9._-]+$/.test(x)) : [];
    let nImg = 0;
    // Chunked: mkdir -p + atomic write, ≤40 KB SSM pieces on EC2.
    await mapPool(imgNames, FILE_PARALLEL, async (x) => {
      await accessor.writeFileChunked(waConfig.joinPath(imgDir, x), Buffer.from(String(web.images[x]), 'base64'));
      nImg++;
    });
    restored.push(`${nSec} HTML sections`, `${nImg} website images`);
    done('Website', `${nSec} HTML sections, ${nImg} images`);

    const up = (bundle.uploads && bundle.uploads.files && typeof bundle.uploads.files === 'object') ? bundle.uploads.files : {};
    const upRels = Object.keys(up).filter(uploadsHelper.isValidRel);
    progress('Uploads', 'in_progress', `${upRels.length} files`);
    let nUp = 0;
    await mapPool(upRels, FILE_PARALLEL, async (rel) => {
      await accessor.writeFileChunked(waConfig.joinPath(accessor.appPath, UPLOADS_REL_DIR + '/' + rel), Buffer.from(String(up[rel]), 'base64'));
      if (++nUp % 10 === 0) progress('Uploads', 'in_progress', `${nUp} of ${upRels.length}`);
    });
    restored.push(`${nUp} uploads`);
    done('Uploads', `${nUp} files written to uploads/`);

    // ── 4. console templates ──
    const tplData = (bundle.templates && typeof bundle.templates === 'object' && !Array.isArray(bundle.templates)) ? bundle.templates : null;
    progress('Templates', 'in_progress', 'console raffle text templates');
    if (opts.restoreTemplates === false) {
      skipped.push('console templates (not ticked)');
      done('Templates', 'skipped — not ticked', 'warn');
    } else if (!tplData) {
      skipped.push('console templates (not in the bundle)');
      done('Templates', 'none in the bundle — the console\'s templates are left as they are', 'warn');
    } else {
      const t = tpl.importAll(appConfig, tplData);
      const gone = tpl.pruneAll(appConfig, tplData);
      restored.push(`${t.written} console templates`);
      done('Templates', `${t.written} written to ${tpl.baseDir(appConfig)}${gone.length ? `; ${gone.length} not in the bundle removed (${gone.join(', ')})` : ''}${t.skipped.length ? ' — skipped: ' + t.skipped.join('; ') : ''}`, t.skipped.length ? 'warn' : 'ok');
    }

    // ── 5. remove files the bundle doesn't have ──
    if (opts.pruneFiles) {
      progress('Remove extra files', 'in_progress', 'website images and uploads added after the backup');
      // Never a file the bundle lists as skipped (unreadable when it was
      // made — the live copy is the only one); images only (README.txt /
      // .gitkeep stay); upload names must match the uploads contract.
      const keepImg = new Set([...imgNames, ...(Array.isArray(web.skippedImages) ? web.skippedImages : [])]);
      // …and never a file the restored database still points at (it may be
      // missing from the bundle because it couldn't be read at backup time).
      const keepUp = new Set([...upRels, ...((bundle.uploads && Array.isArray(bundle.uploads.skipped)) ? bundle.uploads.skipped : []), ...dbImagePaths(tables)]);
      const upDirs = uploadsHelper.KINDS.map(k => waConfig.joinPath(accessor.appPath, UPLOADS_REL_DIR + '/' + k));
      const listing = await accessor.readBundle({ files: [], dirs: [imgDir, ...upDirs] });
      for (const d of [imgDir, ...upDirs]) {
        const e = listing.dirs[d] && listing.dirs[d].err;
        if (e) throw new Error(`Could not list ${d} to remove files not in the bundle: ${e}`);
      }
      const extraImg = ((listing.dirs[imgDir] || {}).names || []).filter(n => IMAGE_EXT.test(n) && /^[A-Za-z0-9._-]+$/.test(n) && !keepImg.has(n));
      const extraUp = [];
      uploadsHelper.KINDS.forEach((k, i) => {
        for (const n of ((listing.dirs[upDirs[i]] || {}).names || [])) {
          const rel = `${k}/${n}`;
          if (uploadsHelper.isValidRel(rel) && !keepUp.has(rel)) extraUp.push(rel);
        }
      });
      const paths = [...extraImg.map(n => waConfig.joinPath(imgDir, n)), ...extraUp.map(rel => uploadsHelper.absPath(accessor, rel))];
      for (let i = 0; i < paths.length; i += 200) {
        const rr = await accessor.runCommand(`rm -f -- ${paths.slice(i, i + 200).map(shq).join(' ')}`, { timeoutMs: 60000, comment: 'bundle restore: remove files not in the bundle' });
        if (rr.code !== 0) throw new Error(`Could not remove files not in the bundle: ${(rr.stderr || '').trim() || 'exit ' + rr.code}`);
      }
      restored.push(`${extraImg.length} website images + ${extraUp.length} uploads not in the bundle removed`);
      done('Remove extra files', `${extraImg.length} website image(s), ${extraUp.length} upload(s) not in the bundle removed`);
    } else {
      skipped.push('files not in the bundle (kept)');
    }

    // ── 6. maintenance.json ──
    progress('Maintenance file', 'in_progress', MAINT_FILE);
    const maint = (bundle.maintenance && typeof bundle.maintenance === 'object' && !Array.isArray(bundle.maintenance)) ? bundle.maintenance : null;
    let maintenanceEnabled = null;
    if (opts.keepMaintenanceOn) {
      // The operator turned Maintenance Mode on for this restore: leave it
      // on until they've restarted the Web App (the page offers both).
      maintenanceEnabled = true;
      skipped.push(`${MAINT_FILE} (kept ON for this restore)`);
      done('Maintenance file', `left ON (you enabled it for this restore) — the bundle's was ${maint ? (maint.enabled === true ? 'on' : 'off') : 'not included'}. Restart the Web App, then turn Maintenance Mode off.`, 'warn');
    } else if (maint) {
      await accessor.writeFile(waConfig.joinPath(accessor.appPath, MAINT_FILE), jsonFileText(maint));
      maintenanceEnabled = maint.enabled === true;
      restored.push(`${MAINT_FILE} (enabled: ${maintenanceEnabled})`);
      done('Maintenance file', `${MAINT_FILE} written — Maintenance Mode ${maintenanceEnabled ? 'ENABLED (as it was when the bundle was made)' : 'off, as it was when the bundle was made'}`, maintenanceEnabled ? 'warn' : 'ok');
    } else {
      skipped.push(MAINT_FILE + ' (not in the bundle)');
      done('Maintenance file', `${MAINT_FILE} not in the bundle — left as it is on the host`, 'warn');
    }

    waConfig.markWebAppWritten(appConfig);
    appConfigModule.save();
    return { steps, restored, skipped, maintenanceEnabled };
  }

  // The "Web App rebuild" group: two guided flows + the bundle list.
  // The flows run in the browser (Alpine) so the maintenance-mode questions
  // can be asked between steps; each step is its own JSON endpoint below.
  function rebuildCard(bundles, dbReady) {
    const rows = bundles.map((b) => {
      const s = b.summary || {};
      const badge = s.valid
        ? `<span class="pill-running">valid</span>`
        : `<span class="pill-failed" title="${escapeHtml((s.problems || []).join('; '))}">invalid</span>`;
      const warn = (s.warnings && s.warnings.length)
        ? ` <span class="text-xs text-amber-600 dark:text-amber-400" title="${escapeHtml(s.warnings.join('; '))}">⚠ ${s.warnings.length} warning(s)</span>` : '';
      return `<tr class="border-t border-slate-100 dark:border-slate-800">
        <td class="py-2 pr-2"><input type="radio" name="bundle" value="${escapeHtml(b.name)}" x-model="selected" class="h-4 w-4"></td>
        <td class="py-2 pr-3 font-mono text-xs break-all">${escapeHtml(b.name)}</td>
        <td class="py-2 pr-3 whitespace-nowrap text-slate-500" title="when the bundle was made (UTC)">${escapeHtml(b.mtime.replace('T', ' ').slice(0, 16))} UTC</td>
        <td class="py-2 pr-3 whitespace-nowrap text-slate-500">${fmtBytes(b.size)}</td>
        <td class="py-2 pr-3 text-xs text-slate-600 dark:text-slate-300">${s.valid ? `v${s.version || 1} · ${s.configKeys} config keys · secrets ${s.localSecrets ? 'yes' : 'no'} · ${s.sections} sections · ${s.images} images${s.skippedImages && s.skippedImages.length ? ` (${s.skippedImages.length} skipped)` : ''} · ${s.uploads || 0} uploads${s.skippedUploads && s.skippedUploads.length ? ` (${s.skippedUploads.length} skipped)` : ''} · ${s.tables} tables / ${s.rows} rows · ${s.templates || 0} templates${s.manifest ? '' : ' · no manifest'}` : escapeHtml((s.problems || []).join('; '))}</td>
        <td class="py-2">${badge}${warn}</td>
        <td class="py-2 text-right whitespace-nowrap">
          <a class="btn-secondary text-xs px-2 py-1" href="/backup-restore/bundle/download/${encodeURIComponent(b.name)}" download>Download</a>
          ${s.consoleSettings ? `<a class="btn-secondary text-xs px-2 py-1 ml-1" href="/backup-restore/bundle/console-settings/${encodeURIComponent(b.name)}" download title="The console settings export inside this bundle, as a file for Console settings → Restore">Console settings</a>` : ''}
          <button type="button" class="btn-danger text-xs px-2 py-1 ml-1" x-on:click="del('${escapeHtml(b.name)}')">Delete</button>
        </td>
      </tr>`;
    }).join('');

    return `<div class="card surface-target card-pad" x-data="{
        busy: '', log: [], selected: '', confirmText: '', maintOn: false, restoreCommands: false, pruneFiles: true, keepHostSettings: true, restoreTemplates: true,
        md: { open: false, what: '', title: ${jsStr(MAINT_TITLE)}, message: ${jsStr(MAINT_MESSAGE)}, resolve: null },
        sw: { open: false, op: null, timer: null, now: Date.now() },
        say(kind, text) { this.log.push({ kind, text }); },
        clear() { this.log = []; },
        async post(url, body) {
          const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }, body: JSON.stringify(body || {}) });
          return await r.json().catch(() => ({ ok: false, error: 'Bad response from server' }));
        },
        init() { this.resumeIfRunning(); },
        async maint(action) {
          const r = await this.post('/web-app-website/maintenance', { action, title: this.md.title, message: this.md.message });
          this.say(r.ok ? 'ok' : 'err', 'Maintenance Mode ' + action + ': ' + (r.ok ? 'done' : (r.error || r.stderr || 'failed')));
          return !!r.ok;
        },
        askMaintenance(what) {
          this.md.what = what; this.md.open = true;
          return new Promise(res => { this.md.resolve = res; });
        },
        async answerMaint(yes) {
          this.md.open = false;
          const res = this.md.resolve; this.md.resolve = null;
          if (!yes) { this.say('info', 'Maintenance Mode left as is.'); }
          else this.maintOn = await this.maint('enable');
          if (res) res(yes);
        },
        async offerDisableMaintenance(outcome) {
          if (!this.maintOn) return;
          const yes = await window.uiConfirm(outcome + ' Maintenance Mode is still ENABLED on the Web App — disable it now so visitors can reach it again?', { title: 'Maintenance Mode', confirmLabel: 'Disable', cancelLabel: 'Leave enabled', danger: false });
          if (yes) { if (await this.maint('disable')) this.maintOn = false; }
          else this.say('info', 'Maintenance Mode left ENABLED — disable it from Web App Website when ready.');
        },
        async pollOnce() {
          try {
            const r = await fetch('/backup-restore/bundle/status', { headers: { 'Accept': 'application/json' } });
            const o = await r.json();
            if (o && !o.idle) this.sw.op = o;
            this.sw.now = Date.now();
            return o;
          } catch (e) { return null; }
        },
        startWatch() { this.stopWatch(); this.sw.open = true; this.sw.timer = setInterval(() => this.pollOnce(), 1500); },
        stopWatch() { if (this.sw.timer) clearInterval(this.sw.timer); this.sw.timer = null; },
        elapsed() {
          const o = this.sw.op; if (!o || !o.startedAt) return '';
          const a = new Date(o.startedAt).getTime(), b = o.finishedAt ? new Date(o.finishedAt).getTime() : this.sw.now;
          const s = Math.max(0, Math.round((b - a) / 1000));
          return (s >= 60 ? Math.floor(s / 60) + 'm ' : '') + (s % 60) + 's';
        },
        opTitle() {
          const o = this.sw.op; if (!o) return 'Status';
          const what = ({ restore: 'Restore', verify: 'Verify', backup: 'Backup', 'database restore': 'Database restore', 'image restore': 'Image restore', 'website restore': 'Website restore' })[o.kind] || 'Operation';
          if (o.kind === 'verify') return o.ok ? 'Bundle verified — complete' : 'Bundle verification FAILED';
          return o.running ? what + ' is still running…' : (o.ok ? what + ' finished' : what + ' FAILED');
        },
        // The Verify checklist, in the Progress log AND the status window.
        showChecks(name, r) {
          const checks = r.checks || [];
          checks.forEach(c => this.say(c.ok ? 'ok' : (c.level === 'error' ? 'err' : c.level === 'info' ? 'info' : 'warn'), c.name + (c.detail ? ' — ' + c.detail : '')));
          const at = new Date().toISOString();
          this.sw.op = { kind: 'verify', name, running: false, ok: !!r.valid, error: r.valid ? null : 'one or more checks failed', startedAt: at, finishedAt: at,
            steps: checks.map(c => ({ step: c.name, state: c.ok ? 'ok' : (c.level === 'error' ? 'failed' : 'warn'), detail: c.detail || '' })) };
          this.sw.open = true;
        },
        async resumeIfRunning() {
          const o = await this.pollOnce();
          if (!o || !o.running) return;
          this.busy = o.kind; this.startWatch();
          this.say('info', 'A ' + o.kind + ' started earlier is still running on this console — watching it.');
          while (this.sw.op && this.sw.op.running) await new Promise(r => setTimeout(r, 1500));
          this.stopWatch();
          const d = this.sw.op;
          this.say(d.ok ? 'ok' : 'err', 'The ' + d.kind + (d.ok ? ' finished.' : ' failed: ' + (d.error || 'unknown error')));
          this.say('info', 'If you enabled Maintenance Mode for it, disable it from Web App Website.');
          this.busy = '';
          if (d.kind === 'backup' && d.ok) setTimeout(() => window.location.reload(), 1500);
        },
        async fullBackup() {
          if (this.busy) return;
          this.busy = 'backup'; this.clear();
          try {
            const wasOn = this.maintOn;
            await this.askMaintenance('backup');
            this.say('info', 'Capturing configuration, website and database…');
            this.sw.op = null; this.startWatch();
            const r = await this.post('/backup-restore/bundle/create', { maintenanceOnForBackup: !wasOn && !!this.maintOn });
            this.stopWatch(); await this.pollOnce();
            if (!r.ok) { this.say('err', 'Backup failed: ' + (r.error || 'unknown error')); await this.offerDisableMaintenance('The backup FAILED.'); return; }
            const s = r.summary || {};
            this.say('ok', 'Saved ' + r.name + ' — ' + s.configKeys + ' config keys, ' + s.sections + ' sections, ' + s.images + ' images, ' + (s.uploads || 0) + ' uploads, ' + s.tables + ' tables / ' + s.rows + ' rows.');
            (s.warnings || []).forEach(w => this.say('warn', w));
            await this.offerDisableMaintenance('The backup finished.');
            this.say('info', 'Reloading the bundle list…');
            setTimeout(() => window.location.reload(), 900);
          } finally { this.busy = ''; }
        },
        async testAccess() {
          if (this.busy) return;
          this.busy = 'test'; this.clear();
          try {
            const r = await this.post('/backup-restore/bundle/test-access', {});
            (r.checks || []).forEach(c => this.say(c.ok ? 'ok' : 'err', c.name + (c.detail ? ' — ' + c.detail : '')));
            this.say(r.ok ? 'ok' : 'err', r.ok ? 'All access checks passed.' : 'Fix the failing checks before restoring.');
          } finally { this.busy = ''; }
        },
        async verify() {
          if (this.busy || !this.selected) return;
          this.busy = 'verify'; this.clear();
          try {
            const r = await this.post('/backup-restore/bundle/verify', { name: this.selected });
            if (!r.ok && !r.checks) { this.say('err', r.error || 'Verify failed'); return; }
            this.showChecks(this.selected, r);
            const s = r.summary || {};
            this.say(r.valid ? 'ok' : 'err', r.valid
              ? 'Bundle is complete: ' + s.configKeys + ' config keys, secrets ' + (s.localSecrets ? 'yes' : 'no') + ', ' + s.sections + ' HTML sections, ' + s.images + ' images, ' + (s.uploads || 0) + ' uploads, ' + s.tables + ' tables / ' + s.rows + ' rows (' + (s.engine || '?') + '), ' + (s.templates || 0) + ' templates.'
              : 'Bundle has problems — see the checklist above.');
            (s.warnings || []).forEach(w => this.say('warn', w));
          } finally { this.busy = ''; }
        },
        async fullRestore() {
          if (this.busy || !this.selected || this.confirmText.trim() !== ${jsStr(RESTORE_CONFIRM)}) return;
          this.busy = 'restore'; this.clear();
          try {
            this.say('info', 'Step 1/4 — testing access to the Web App…');
            const a = await this.post('/backup-restore/bundle/test-access', {});
            (a.checks || []).forEach(c => this.say(c.ok ? 'ok' : 'err', c.name + (c.detail ? ' — ' + c.detail : '')));
            if (!a.ok) { this.say('err', 'Stopped: fix the failing access checks first (Settings → Web App).'); return; }
            this.say('info', 'Step 2/4 — Maintenance Mode');
            await this.askMaintenance('restore');
            this.say('info', 'Step 3/4 — verifying the bundle…');
            const v = await this.post('/backup-restore/bundle/verify', { name: this.selected });
            if (!v.ok && !v.checks) { this.say('err', 'Stopped: ' + (v.error || 'verify failed')); await this.offerDisableMaintenance('The restore did not start (the bundle could not be verified).'); return; }
            this.showChecks(this.selected, v); this.sw.open = false;
            if (!v.valid) { this.say('err', 'Stopped: the bundle failed verification (see the checklist).'); await this.offerDisableMaintenance('The restore did not start (the bundle failed verification).'); return; }
            this.say('ok', 'Bundle verified.');
            const go = await window.uiConfirm('Restore ' + this.selected + ' now? This REPLACES the Web App configuration' + (this.keepHostSettings ? ' (keeping the port, TLS, database connection and AWS credential source of this server)' : '') + ', session keys, website files, images and uploads' + (this.pruneFiles ? ' (removing images not in the bundle)' : '') + ', the ENTIRE database' + (this.restoreTemplates ? ' and the raffle text templates' : '') + '.', { title: 'Restore the Web App?', confirmLabel: 'Restore now', cancelLabel: 'Cancel' });
            if (!go) { this.say('info', 'Restore canceled.'); await this.offerDisableMaintenance('The restore was canceled.'); return; }
            this.say('info', 'Step 4/4 — restoring (database → configuration + secrets → website → uploads → templates → removing extra files → maintenance file)…');
            this.sw.op = null; this.startWatch();
            let r = await this.post('/backup-restore/bundle/restore', { name: this.selected, confirm: this.confirmText.trim(), restoreCommands: !!this.restoreCommands, pruneFiles: !!this.pruneFiles, keepHostSettings: !!this.keepHostSettings, restoreTemplates: !!this.restoreTemplates, keepMaintenanceOn: !!this.maintOn });
            if (!r.ok && !r.steps) {
              // No proper answer (a proxy timed the request out?) — the restore
              // may still be running: follow its status until it finishes.
              this.say('warn', 'No answer from the console (' + (r.error || 'timeout') + ') — following the restore status…');
              let st = null;
              for (let k = 0; k < 7200; k++) {
                st = await fetch('/backup-restore/bundle/status', { headers: { Accept: 'application/json' } }).then(x => x.json()).catch(() => null);
                if (st && !st.running) break;
                await new Promise(res => setTimeout(res, 2000));
              }
              if (st && !st.running) {
                const steps = (st.steps || []).map(x => ({ step: x.step, ok: x.state === 'ok' || x.state === 'warn', detail: x.detail }));
                r = { ok: !!st.ok, error: st.error, steps, dbCommitted: steps.some(x => x.step === 'Database' && x.ok), maintenanceEnabled: this.maintOn };
              }
            }
            this.stopWatch(); await this.pollOnce();
            (r.steps || []).forEach(s => this.say(s.ok ? 'ok' : 'err', s.step + ' — ' + s.detail));
            if (!r.ok) {
              this.say('err', 'Restore failed: ' + (r.error || 'unknown error') + (r.dbCommitted ? ' — the database IS restored but some files may not be; fix the cause and run the restore again (it finishes the job).' : ' — nothing was changed (the database step runs first and was rolled back, or never started).'));
              await this.offerDisableMaintenance('The restore FAILED.'); return;
            }
            this.say('ok', 'Restore complete.');
            this.maintOn = !!r.maintenanceEnabled;
            // The Web App reads config.json and its session keys only at
            // start-up: restart BEFORE anyone is let back in.
            const rs = await window.uiConfirm('Restart the Web App now so it loads the restored configuration and session keys?' + (this.maintOn ? ' Maintenance Mode stays on until you turn it off.' : ''), { title: 'Restart the Web App', confirmLabel: 'Restart now', cancelLabel: 'Later', danger: false });
            let restarted = false;
            if (rs) {
              const p = await this.post('/web-app-settings/power', { action: 'restart' });
              restarted = !!p.ok;
              this.say(p.ok ? 'ok' : 'err', 'Restart: ' + (p.ok ? 'done' : (p.error || p.stderr || 'failed') + ' — restart it from Web App Settings (or on the server) before letting visitors in.'));
            } else this.say('warn', 'Restart the Web App (Web App Settings) before letting visitors back in — it is still running the old configuration.');
            if (restarted) await this.offerDisableMaintenance('The restore finished and the Web App was restarted.');
            else if (this.maintOn) this.say('warn', 'Maintenance Mode stays ON until the Web App has been restarted — then turn it off from Web App Website.');
            if (restarted) window.location.href = '/backup-restore?ok=bundle&restarted=1';
            // Not restarted: stay on this page so the messages above remain visible.
          } finally { this.busy = ''; }
        },
        async del(name) {
          if (!(await window.uiConfirm('Delete bundle ' + name + '? This cannot be undone.', { title: 'Delete bundle', confirmLabel: 'Delete' }))) return;
          const r = await this.post('/backup-restore/bundle/delete', { name });
          if (r.ok) window.location.reload(); else this.say('err', r.error || 'Delete failed');
        }
      }">
      <div class="grid lg:grid-cols-2 gap-6">
        <section>
          <h3 class="text-base font-semibold text-slate-900 dark:text-slate-100">Web App Full Backup</h3>
          <p class="mt-1 text-sm text-slate-500 dark:text-slate-400">One click captures everything needed to rebuild the Web App as it is right now: <code class="font-mono">config.json</code>, <code class="font-mono">local-secrets.json</code> (session keys — members stay signed in), <code class="font-mono">maintenance.json</code>, the website (HTML sections, images), every uploaded image (uploads/ — flyers, prize, nonprofit and board photos), the whole database as one point-in-time snapshot, plus this console's raffle text templates and settings — with a manifest (row counts, a hash per table and per file) that Verify checks against. Over EC2 (SSM) every file is captured, in pieces, so a photo-heavy site takes a while — SSH or Local access is faster.</p>
          <div class="mt-3 text-xs text-amber-600 dark:text-amber-400"><strong>Sensitive:</strong> a bundle holds the Web App's secrets (SMTP / AWS credentials, session keys) and nonprofit password hashes. Treat it like the database.</div>
          <div class="mt-4">
            <button type="button" class="btn-primary" x-on:click="fullBackup()" :disabled="!!busy" :class="busy ? 'opacity-50 cursor-not-allowed' : ''">
              <span x-show="busy !== 'backup'">Web App Full Backup</span><span x-show="busy === 'backup'">Backing up…</span>
            </button>
          </div>
        </section>
        <section>
          <h3 class="text-base font-semibold text-slate-900 dark:text-slate-100">Web App Full Restore</h3>
          <p class="mt-1 text-sm text-slate-500 dark:text-slate-400">After the Web App is redeployed: point <a class="text-brand-600 hover:underline" href="/settings/web-app">Settings → Web App</a> at the new instance, select a bundle below, then run the guided restore — it tests access, offers Maintenance Mode, verifies the bundle, restores the database first (all-or-nothing) → configuration + session keys → website → uploads → console templates → removes files not in the bundle → maintenance file, and finishes with the Web App restart the new config needs. The console settings inside a bundle are not applied here — use the <em>Console settings</em> download on the bundle row with Console settings → Restore.</p>
          ${dbReady ? '' : `<div class="mt-3 flash-error text-xs">Database is not available — the restore can't run until <a class="underline" href="/settings/web-app">Settings → Web App</a> reaches it.</div>`}
          <div class="mt-4 flex flex-wrap items-center gap-2">
            <button type="button" class="btn-secondary" x-on:click="testAccess()" :disabled="!!busy">Test access to the Web App</button>
            <button type="button" class="btn-secondary" x-on:click="verify()" :disabled="!!busy || !selected">Verify selected bundle</button>
          </div>
          <label class="mt-3 flex items-start gap-2 text-xs text-slate-700 dark:text-slate-200">
            <input type="checkbox" x-model="restoreTemplates" class="mt-0.5">
            <span>Restore this console's raffle text templates from the bundle (writes into the Settings → Templates folder; a template with the same id is replaced, others are kept).</span>
          </label>
          <label class="mt-2 flex items-start gap-2 text-xs text-slate-700 dark:text-slate-200">
            <input type="checkbox" x-model="pruneFiles" class="mt-0.5">
            <span>Remove images not in the bundle (website images and uploads added after the backup are deleted, so the site's files match the backup exactly; off = they are kept).</span>
          </label>
          <label class="mt-2 flex items-start gap-2 text-xs text-slate-700 dark:text-slate-200">
            <input type="checkbox" x-model="keepHostSettings" class="mt-0.5">
            <span>Keep this server's own machine settings — port, TLS / proxy (server), database connection and where AWS credentials come from — instead of the bundle's. Recommended, especially when restoring onto a new server; everything else in the configuration comes from the bundle.</span>
          </label>
          <label class="mt-2 flex items-start gap-2 text-xs text-amber-700 dark:text-amber-300">
            <input type="checkbox" x-model="restoreCommands" class="mt-0.5">
            <span>${escapeHtml(RESTORE_COMMANDS_LABEL)}</span>
          </label>
          <div class="mt-3 flex flex-wrap items-center gap-2">
            <input class="input max-w-[12rem]" type="text" x-model="confirmText" autocomplete="off" placeholder="Type ${RESTORE_CONFIRM}">
            <button type="button" class="btn-danger" x-on:click="fullRestore()"
                    :disabled="!!busy || !selected || confirmText.trim() !== '${RESTORE_CONFIRM}'"
                    :class="(!!busy || !selected || confirmText.trim() !== '${RESTORE_CONFIRM}') ? 'opacity-50 cursor-not-allowed' : ''">
              <span x-show="busy !== 'restore'">Web App Full Restore</span><span x-show="busy === 'restore'">Restoring…</span>
            </button>
          </div>
        </section>
      </div>

      <div class="mt-6">
        <div class="flex items-center justify-between gap-3 flex-wrap">
          <h4 class="text-sm font-semibold text-slate-900 dark:text-slate-100">Bundles on this console <span class="font-normal text-slate-400">(backups/)</span></h4>
          <form method="POST" action="/backup-restore/bundle/upload" enctype="multipart/form-data" class="flex items-center gap-2">
            <input class="${FILE_INPUT_CLS} max-w-xs" type="file" name="bundle" accept="application/json,.json" required>
            <button type="submit" class="btn-secondary text-sm">Upload bundle</button>
          </form>
        </div>
        ${bundles.length ? `
        <div class="mt-3 overflow-x-auto">
          <table class="w-full text-sm">
            <thead><tr class="text-left text-xs text-slate-500 dark:text-slate-400"><th class="pb-1"></th><th class="pb-1">Bundle</th><th class="pb-1">Created</th><th class="pb-1">Size</th><th class="pb-1">Contents</th><th class="pb-1">Check</th><th class="pb-1"></th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>` : `<p class="mt-3 text-sm text-slate-400 italic">No bundles yet — run a Full Backup, or upload one.</p>`}
      </div>

      <div class="mt-5" x-show="log.length || sw.op" x-cloak>
        <div class="flex items-center justify-between mb-1">
          <div class="text-xs font-semibold text-slate-500 dark:text-slate-400">Progress</div>
          <button type="button" class="btn-secondary text-xs px-2 py-1" x-show="sw.op && !sw.open" x-on:click="sw.open = true">
            <span x-text="sw.op && sw.op.running ? '⏳ Show status (' + (sw.op.kind || 'operation') + ' still running)' : 'Show last status'"></span>
          </button>
        </div>
        <div class="rounded-lg border border-slate-200 dark:border-slate-700 bg-white/60 dark:bg-slate-900 p-3 space-y-1 max-h-72 overflow-auto font-mono text-xs" x-show="log.length">
          <template x-for="(l, i) in log" :key="i">
            <div :class="l.kind === 'ok' ? 'text-emerald-700 dark:text-emerald-300' : l.kind === 'err' ? 'text-red-600 dark:text-red-400' : l.kind === 'warn' ? 'text-amber-600 dark:text-amber-400' : 'text-slate-600 dark:text-slate-300'">
              <span x-text="l.kind === 'ok' ? '✓' : l.kind === 'err' ? '✗' : l.kind === 'warn' ? '⚠' : '·'"></span> <span x-text="l.text"></span>
            </div>
          </template>
        </div>
      </div>

      <!-- Maintenance Mode dialog: the same Title / Message inputs as Web App Website → Maintenance Mode -->
      <div x-show="md.open" x-cloak class="fixed inset-0 flex items-center justify-center p-4 bg-black/60" style="z-index:1000">
        <div class="card surface-target card-pad w-full max-w-lg" role="dialog" aria-modal="true" aria-labelledby="wa-maint-title">
          <h3 id="wa-maint-title" class="text-base font-semibold text-slate-900 dark:text-slate-100">Maintenance Mode</h3>
          <p class="mt-2 text-sm text-slate-700 dark:text-slate-200">Enable Maintenance Mode on the Web App while the <strong x-text="md.what"></strong> runs? Visitors see the page below until it is disabled again.</p>
          <div class="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div><label class="label">Title</label>
              <input class="input" type="text" x-model="md.title" autocomplete="off" placeholder="e.g. Scheduled maintenance"></div>
            <div><label class="label">Message</label>
              <input class="input" type="text" x-model="md.message" autocomplete="off" placeholder="e.g. We'll be back shortly"></div>
          </div>
          <div class="mt-5 flex justify-end gap-2">
            <button type="button" class="btn-secondary" x-on:click="answerMaint(false)">No, continue without it</button>
            <button type="button" class="btn-primary" x-on:click="answerMaint(true)">Enable</button>
          </div>
        </div>
      </div>

      <!-- Status window: live steps from GET /backup-restore/bundle/status. Closing it never stops the operation. -->
      <div x-show="sw.open" x-cloak class="fixed inset-0 flex items-center justify-center p-4 bg-black/60" style="z-index:999">
        <div class="card surface-target card-pad w-full max-w-lg" role="dialog" aria-modal="true" aria-labelledby="wa-status-title">
          <div class="flex items-start gap-3">
            <div class="text-2xl leading-none" aria-hidden="true" x-text="!sw.op || sw.op.running ? '⏳' : sw.op.ok ? '✅' : '❌'"></div>
            <div class="flex-1 min-w-0">
              <h3 id="wa-status-title" class="text-base font-semibold text-slate-900 dark:text-slate-100" x-text="sw.op ? opTitle() : 'Starting…'"></h3>
              <div class="mt-1 text-xs text-slate-500 dark:text-slate-400" x-show="sw.op">
                <span x-show="sw.op && sw.op.name" x-text="sw.op ? (sw.op.name || '') : ''"></span>
                <span> · elapsed <span x-text="elapsed()"></span></span>
              </div>
            </div>
          </div>
          <div class="mt-4 space-y-1.5 text-sm" x-show="sw.op && sw.op.steps.length">
            <template x-for="s in (sw.op ? sw.op.steps : [])" :key="s.step">
              <div class="flex items-start gap-2" :class="s.state === 'ok' ? 'text-emerald-700 dark:text-emerald-300' : s.state === 'failed' ? 'text-red-600 dark:text-red-400' : s.state === 'warn' ? 'text-amber-600 dark:text-amber-400' : 'text-slate-700 dark:text-slate-200'">
                <span class="w-4 shrink-0" x-text="s.state === 'ok' ? '✓' : s.state === 'failed' ? '✗' : s.state === 'warn' ? '⚠' : '⏳'"></span>
                <span><span class="font-semibold" x-text="s.step"></span><span x-show="s.detail" x-text="' — ' + s.detail"></span></span>
              </div>
            </template>
          </div>
          <p class="mt-3 text-xs text-slate-500 dark:text-slate-400" x-show="!sw.op || !sw.op.steps.length">Waiting for the first step to report…</p>
          <div class="mt-4 rounded-lg border p-3 text-xs" x-show="sw.op && sw.op.running"
               :class="sw.op && sw.op.kind === 'restore' ? 'border-red-300 bg-red-50 text-red-800 dark:border-red-800 dark:bg-red-900/30 dark:text-red-200' : 'border-brand-300 bg-brand-50 text-brand-800 dark:border-brand-800 dark:bg-brand-900/40 dark:text-brand-200'">
            <template x-if="sw.op && sw.op.kind === 'restore'">
              <div><strong>The Web App is being restored — this is backbone infrastructure.</strong> Do not restart or redeploy it, and do not change Settings → Web App, until this finishes. The restore runs on this console: closing this window, reloading, or navigating away does not stop it — reopen it with “Show status”.</div>
            </template>
            <template x-if="sw.op && sw.op.kind !== 'restore'">
              <div>The backup runs on this console — closing this window does not stop it. Reopen it with “Show status”.</div>
            </template>
          </div>
          <div class="mt-4 rounded-lg border p-3 text-xs border-red-300 bg-red-50 text-red-800 dark:border-red-800 dark:bg-red-900/30 dark:text-red-200" x-show="sw.op && !sw.op.running && sw.op.ok === false">
            <strong x-text="(sw.op && sw.op.kind === 'restore' ? 'Restore' : 'Backup') + ' failed: '"></strong><span x-text="sw.op ? sw.op.error : ''"></span>
            <div class="mt-1" x-show="sw.op && sw.op.kind === 'restore'">The Web App may be partially restored. Fix the cause and run the restore again before taking it out of Maintenance Mode.</div>
          </div>
          <div class="mt-5 flex justify-end gap-2">
            <button type="button" class="btn-secondary" x-on:click="sw.open = false" x-text="sw.op && sw.op.running ? 'Close (keeps running)' : 'Close'"></button>
          </div>
        </div>
      </div>
    </div>`;
  }

  router.get('/backup-restore', requireAdmin, (req, res) => {
    const user = req.session.user;
    const waReady = webAppAccess.isConfigured(appConfig);
    const waDesc = waReady ? webAppAccess.createAccessorFromConfig(appConfig).describe() : '';

    const keyList = BACKUP_KEYS.map(k => `<code class="font-mono text-xs px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200">${k}</code>`).join(' ');

    const nTxt = req.query.n ? ` (${parseInt(req.query.n, 10) || 0} section(s))` : '';
    const okMap = {
      bundle: 'Web App restored from the bundle — database, configuration, session keys, website, uploads, console templates and maintenance file.' + (req.query.restarted ? ' The Web App was restarted and is running the restored configuration.' : ' Restart the Web App so it reads the restored config.'),
      bundleup: 'Bundle uploaded.',
      settings: `Console settings restored${nTxt}.`,
      waconfig: `Web App config restored${nTxt}.`,
      wawebsite: `Web App website restored${nTxt}.`,
      waimages: `Images restored${req.query.n ? ' (' + (parseInt(req.query.n, 10) || 0) + ' website image(s), ' + (parseInt(req.query.u, 10) || 0) + ' upload(s))' : ''}.`,
      database: `Web App database restored${req.query.n ? ' (' + (parseInt(req.query.n, 10) || 0) + ' tables)' : ''}.`
    };
    const okMsg = okMap[req.query.ok] ? `<div class="flash-ok mb-4">${okMap[req.query.ok]}</div>` : '';
    const interruptedMsg = (opStatus && opStatus.interrupted)
      ? `<div class="flash-error mb-4"><strong>${escapeHtml(({ restore: 'A Full Restore', backup: 'A Full Backup', 'database restore': 'A Database Restore', 'image restore': 'An Image Restore', 'website restore': 'A Website Restore' }[opStatus.kind] || 'An operation') + ' was interrupted.')}</strong> ${escapeHtml(opStatus.error || '')}${opStatus.name ? ` File: <code class="font-mono">${escapeHtml(opStatus.name)}</code>.` : ''} Started ${escapeHtml(String(opStatus.startedAt || '').replace('T', ' ').slice(0, 19))} UTC.</div>`
      : '';

    // ── Group 1: Console settings (local file) ──
    const consoleGroup = `
      ${groupHeading('Console settings', "This admin console's own config.json.")}
      <div class="grid lg:grid-cols-2 gap-6">
        <section class="card surface-target card-pad">
          <h3 class="text-base font-semibold text-slate-900 dark:text-slate-100">Backup</h3>
          <p class="mt-1 text-sm text-slate-500 dark:text-slate-400">Download all console settings as a JSON file.</p>
          <div class="mt-4 text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
            <div class="font-semibold mb-1 text-slate-600 dark:text-slate-300">Included keys</div>
            <div class="flex flex-wrap gap-1.5">${keyList}</div>
            <div class="mt-3 text-slate-400">
              <strong>Also included:</strong> the Appearance background images. <strong>Excluded:</strong> <code class="font-mono">sessionKeys</code> (per host),
              <code class="font-mono">local_admins.json</code> (admin accounts — a new console asks you to create one) and the raffle text templates themselves (they are in the Web App Full Backup).
            </div>
            <div class="mt-3 text-amber-600 dark:text-amber-400">
              <strong>Sensitive:</strong> contains secrets in plain text — the Web App SSH private key / AWS keys and the MySQL password. Store securely.
            </div>
          </div>
          ${downloadBtn('/backup-restore/export')}
        </section>
        <section class="card surface-target card-pad">
          <h3 class="text-base font-semibold text-slate-900 dark:text-slate-100">Restore</h3>
          <p class="mt-1 text-sm text-slate-500 dark:text-slate-400">Upload a console-settings backup, then pick which sections to restore. Each selected section REPLACES that section of <code class="font-mono">config.json</code> (a secret the file doesn't carry is kept). Every value is checked first; anything that would stop the console starting or lock you out is refused and nothing is written.</p>
          ${selectiveRestoreForm('settings', '/backup-restore/import',
            'I understand this will overwrite the selected console settings.',
            `<div class="flash-error text-xs"><strong>Heads up:</strong> port, server / TLS, public base URL, session and security settings and the database take effect after the console restarts — the result says which. Title, appearance, time zone and templates folder apply right away. <strong>Web App access</strong> (where and how this console reaches the Web App, and its Start / Stop / Restart commands) is only taken from the file if you tick the box below.</div>`,
            BACKUP_KEYS, SETTINGS_LABELS, 'Also restore the Web App access: the connection (mode, folder, SSH / EC2 settings) and the Start / Stop / Restart commands. Leave this off unless you made the backup yourself — a different folder or host changes which scripts the power bar runs.')}
        </section>
      </div>`;

    // ── Group 2: Web App configuration (remote config.json) ──
    const waConfigGroup = `
      ${groupHeading('Web App configuration', `The remote Web App's <code class="font-mono">config.json</code> (what Web App Settings edits)${waReady ? ' · ' + waDesc : ''}.`)}
      ${!waReady ? notConfiguredCard() : `
      <div class="grid lg:grid-cols-2 gap-6">
        <section class="card surface-target card-pad">
          <h3 class="text-base font-semibold text-slate-900 dark:text-slate-100">Backup</h3>
          <p class="mt-1 text-sm text-slate-500 dark:text-slate-400">Download the remote Web App <code class="font-mono">config.json</code> as a JSON snapshot, plus its session keys (<code class="font-mono">local-secrets.json</code>) so members stay signed in after a restore.</p>
          <div class="mt-3 text-xs text-amber-600 dark:text-amber-400"><strong>Sensitive:</strong> includes the Web App's own secrets (SMTP password, AWS keys, session keys). Store securely.</div>
          ${downloadBtn('/backup-restore/web-app-config/export')}
        </section>
        <section class="card surface-target card-pad">
          <h3 class="text-base font-semibold text-slate-900 dark:text-slate-100">Restore</h3>
          <p class="mt-1 text-sm text-slate-500 dark:text-slate-400">Upload a snapshot, then pick which sections to restore. Each ticked section replaces that section of the remote <code class="font-mono">config.json</code>; everything else is left untouched. Values are checked with Web App Settings' own limits first — nothing is written if one fails.</p>
          ${selectiveRestoreForm('waconfig', '/backup-restore/web-app-config/import',
            'I understand this overwrites the selected sections in the Web App config.json.',
            `<div class="flash-error text-xs"><strong>Heads up:</strong> every restored section takes effect after the Web App restarts (the page offers it). Only the keys Web App Settings edits can be restored; <code class="font-mono">maintenanceCommand</code> is kept as it is unless you tick the commands box below.</div>`,
            [...WA_CONFIG_KEYS, 'localSecrets'], { ...WA_CONFIG_LABELS, localSecrets: 'Session keys (members stay signed in)' },
            'Also restore the maintenance command from the file. Leave this off unless you made the backup yourself — the console runs it on the Web App host when you use Maintenance Mode.',
            `<label class="flex items-start gap-2 text-xs text-amber-700 dark:text-amber-300" x-show="sections.length" x-cloak>
              <input type="checkbox" name="restore_session_keys" value="1" class="mt-0.5">
              <span>Also restore the session keys (signing keys) — members stay signed in. Only for a backup you made yourself: whoever has the file can sign in as any member with them.</span>
            </label>
            <input type="hidden" name="keep_host" value="0">
            <label class="flex items-start gap-2 text-xs text-slate-700 dark:text-slate-200" x-show="sections.length" x-cloak>
              <input type="checkbox" name="keep_host" value="1" checked class="mt-0.5">
              <span>Keep this server's own machine settings — port, TLS / proxy (server), database connection, public address (publicBaseUrl) and AWS credential source / region — instead of the file's. Recommended, especially when restoring onto a new server.</span>
            </label>`)}
        </section>
      </div>`}`;

    // ── Group 3: Web App website (remote HTML fragments) ──
    const waWebsiteGroup = `
      ${groupHeading('Web App website', 'The website copy HTML section files — hero, about, help, partner, footer (what Web App Website edits).')}
      ${!waReady ? notConfiguredCard() : `
      <div class="grid lg:grid-cols-2 gap-6">
        <section class="card surface-target card-pad">
          <h3 class="text-base font-semibold text-slate-900 dark:text-slate-100">Backup</h3>
          <p class="mt-1 text-sm text-slate-500 dark:text-slate-400">Download all ${WA_SECTION_KEYS.length} website HTML sections in one JSON file. (Images are not included. Images can be backed up below.)</p>
          ${downloadBtn('/backup-restore/web-app-website/export')}
        </section>
        <section class="card surface-target card-pad">
          <h3 class="text-base font-semibold text-slate-900 dark:text-slate-100">Restore</h3>
          <p class="mt-1 text-sm text-slate-500 dark:text-slate-400">Upload a website backup, then pick which sections to restore. Only the selected HTML sections are overwritten.</p>
          ${selectiveRestoreForm('wawebsite', '/backup-restore/web-app-website/import',
            'I understand this overwrites the selected website HTML sections.',
            `<div class="flash-error text-xs"><strong>Heads up:</strong> overwrites the selected section files; changes are live on the next page load (no restart).</div>`,
            WA_SECTION_KEYS, WA_WEBSITE_LABELS)}
        </section>
      </div>
      <div class="grid lg:grid-cols-2 gap-6 mt-6">
        <section class="card surface-target card-pad">
          <h3 class="text-base font-semibold text-slate-900 dark:text-slate-100">Image Backup</h3>
          <p class="mt-1 text-sm text-slate-500 dark:text-slate-400">Download every image in one JSON file, with a size and SHA-256 per file: the website images (<code class="font-mono">HTML/images/</code> — Web App Website → Images) and the uploads (<code class="font-mono">uploads/</code> — event flyers and covers, raffle photos, nonprofit photos, board photos).</p>
          <div class="mt-3 text-xs text-slate-500 dark:text-slate-400">Over EC2 (SSM) access a large set of images can take several minutes.</div>
          ${downloadBtn('/backup-restore/web-app-images/export')}
        </section>
        <section class="card surface-target card-pad">
          <h3 class="text-base font-semibold text-slate-900 dark:text-slate-100">Image Restore</h3>
          <p class="mt-1 text-sm text-slate-500 dark:text-slate-400">Upload an Image Backup (or a Web App Full Backup bundle — its images are used). Each website image and upload is written back to its folder, replacing a file with the same name; images that are not in the backup are left alone. Uploads only show on the site while the database still points at them — restore the database too if its rows were lost.</p>
          <form method="POST" action="/backup-restore/web-app-images/import" enctype="multipart/form-data" class="mt-5 space-y-4"
                x-data="{ fileName: '', confirmed: false, typeErr: '' }">
            <input type="file" name="backup" accept=".json,application/json" required
                   x-on:change="fileName = ''; typeErr = ''; const f = $event.target.files[0]; if (!f) return;
                     f.slice(0, 4096).text().then(t => { if (/&quot;type&quot;\\s*:\\s*&quot;(web-app-images|web-app-bundle)&quot;/.test(t)) fileName = f.name; else typeErr = 'That file is not an Image Backup or a Web App Full Backup bundle.'; })"
                   class="block text-sm text-slate-600 dark:text-slate-300 file:mr-3 file:rounded-lg file:border-0 file:bg-brand-600 file:px-4 file:py-2 file:text-sm file:font-semibold file:text-white hover:file:bg-brand-700">
            <p x-show="typeErr" x-cloak class="text-xs text-red-600 dark:text-red-300" x-text="typeErr"></p>
            <div class="flash-error text-xs"><strong>Heads up:</strong> same-name images are overwritten and are live on the next page load (no restart). Over EC2 (SSM) access this can take several minutes — keep the page open until it finishes.</div>
            <input type="hidden" name="prune_files" value="0">
            <label class="flex items-start gap-2 text-xs text-slate-700 dark:text-slate-200"><input type="checkbox" name="prune_files" value="1" checked class="h-4 w-4 mt-0.5">
              <span>Remove images added after the backup, so the site looks as it did (website images and uploads not in the file; photos the database uses are always kept).</span></label>
            <label class="flex items-start gap-2 text-sm"><input type="checkbox" class="h-4 w-4 mt-0.5" x-model="confirmed">
              <span>I understand this overwrites website images and uploads with the same names.</span></label>
            <button type="submit" class="btn-danger" :disabled="!fileName || !confirmed" :class="(!fileName || !confirmed) ? 'opacity-50 cursor-not-allowed' : ''">Restore images</button>
          </form>
        </section>
      </div>`}`;

    // ── Group 4: Web App database (mmoa_web_app.db / MySQL) ──
    // Uses the admin console's own DB handle, so it works whether the engine
    // is SQLite or MySQL and doesn't need the web app transport configured.
    const dbReady = !!(db && db.available);
    const dbEngine = (db && db.engine) || 'none';
    const dbGroup = `
      ${groupHeading('Web App database', 'The Web App database itself — nonprofit accounts and profiles, events, raffles, board, categories and cities, tokens and lockouts. This is the one store with no other copy. (Uploaded images live in uploads/ — use a rebuild bundle to capture them too.)')}
      ${!dbReady ? `<div class="card surface-target card-pad text-sm text-slate-500 dark:text-slate-400">
        Database is not available (engine: <code class="font-mono">${escapeHtml(dbEngine)}</code>). Check <a class="text-brand-600 hover:underline" href="/settings/web-app">Settings → Web App</a>.
      </div>` : `
      <div class="grid lg:grid-cols-2 gap-6">
        <section class="card surface-target card-pad">
          <h3 class="text-base font-semibold text-slate-900 dark:text-slate-100">Backup</h3>
          <p class="mt-1 text-sm text-slate-500 dark:text-slate-400">Download a full snapshot of the <code class="font-mono">${escapeHtml(dbEngine)}</code> database as JSON — every table, all rows. The format is engine-neutral, so a SQLite backup can be restored into MySQL and vice-versa.</p>
          <div class="mt-3 text-xs text-amber-600 dark:text-amber-400"><strong>Sensitive:</strong> includes nonprofit bcrypt password hashes. Store securely.</div>
          ${downloadBtn('/backup-restore/database/export')}
        </section>
        <section class="card surface-target card-pad">
          <h3 class="text-base font-semibold text-slate-900 dark:text-slate-100">Restore</h3>
          <p class="mt-1 text-sm text-slate-500 dark:text-slate-400">Upload a database snapshot to replace <strong>all</strong> current data.</p>
          ${databaseRestoreForm('/backup-restore/database/import', dbEngine)}
        </section>
      </div>`}`;

    // ── Group 0: Web App rebuild (one bundle for everything) ──
    const rebuildGroup = `
      ${groupHeading('Web App rebuild', 'One bundle — configuration + session keys + maintenance state + website (HTML sections, images) + uploads + database (one snapshot) + this console\'s templates and settings, with a manifest — so a rebuilt Web App comes back in a single restore instead of several. Bundles are kept in <code class="font-mono">backups/</code> on this console and can be downloaded.')}
      ${!waReady ? notConfiguredCard() : rebuildCard(listBundles(), dbReady)}`;

    const body = `
      <header class="mb-2">
        <h1 class="text-2xl font-bold text-slate-900 dark:text-slate-100">Backup &amp; Restore</h1>
        <p class="mt-1 text-sm text-slate-500 dark:text-slate-400">Export settings, Web App content, and the database to JSON files, or restore them from a previously-exported file.</p>
      </header>

      ${flash('error', req.query.error)}
      ${interruptedMsg}
      ${okMsg}
      ${flash('warn', req.query.warn)}
      ${waRestartPrompt(!!req.query.restored)}

      <div class="max-w-5xl">
        ${rebuildGroup}
        ${consoleGroup}
        ${waConfigGroup}
        ${waWebsiteGroup}
        ${dbGroup}
      </div>
    `;
    res.send(page({ title: 'Backup / Restore', body, appConfig, user, activeNav: 'backup' }));
  });

  // ── Console settings: export / import ─────────────────────────────────────
  router.get('/backup-restore/export', requireAdmin, (req, res) => {
    try {
      const backup = buildBackup(appConfig);
      const json = JSON.stringify(backup, null, 2);
      audit(req, 'backup.settings_export', { kind: 'settings', label: 'Console settings', summary: `Console settings downloaded (${Object.keys(backup).filter(k => !k.startsWith('_')).length} sections, ${Object.keys(backup._images || {}).length} appearance image(s))` }).catch(() => {});
      res.set('Content-Type', 'application/json; charset=utf-8');
      res.set('Content-Disposition', `attachment; filename="admin_console_config_${dateStamp()}.json"`);
      res.send(json);
    } catch (err) {
      console.error('[backup] export failed:', err);
      res.redirect('/backup-restore?error=' + encodeURIComponent('Export failed: ' + (err.message || 'unknown error')));
    }
  });

  router.post('/backup-restore/import', requireAdmin, uploadJson('/backup-restore'), async (req, res) => {
    const parsed = parseUpload(req, res);
    if (!parsed) return;
    const selected = normalizeArray(req.body.sections);
    const sections = BACKUP_KEYS.filter(k => selected.includes(k) && Object.prototype.hasOwnProperty.call(parsed, k));
    if (!sections.length) return res.redirect('/backup-restore?error=' + encodeURIComponent('No sections selected to restore.'));
    const restoreConnection = req.body.restore_commands === '1';
    let plan;
    try { plan = await csRestore.planRestore(parsed, appConfig, { sections, restoreConnection }); }
    catch (e) { return res.redirect('/backup-restore?error=' + encodeURIComponent('Restore failed: ' + (e.message || e))); }
    if (plan.errors.length) {
      await audit(req, 'backup.settings_restore', { kind: 'settings', label: req.file && req.file.originalname, summary: `Refused: ${plan.errors.join('; ')}` });
      return res.redirect('/backup-restore?error=' + encodeURIComponent('Nothing was restored — ' + plan.errors.join('; ')));
    }
    const warnings = plan.warnings.slice();
    const updates = Object.assign({}, plan.updates);
    if (sections.includes('theme')) {
      const { theme, dropped } = sanitizeTheme(parsed.theme);
      if (dropped.length) warnings.push(`unsafe appearance value(s) dropped: ${dropped.join(', ')}`);
      updates.theme = theme;
    }
    // All-or-nothing: remember the live values, apply, save; on a failed
    // save put every key back so memory and disk agree.
    const before = {};
    for (const k of Object.keys(updates)) before[k] = appConfig[k] === undefined ? undefined : JSON.parse(JSON.stringify(appConfig[k]));
    try {
      const nImg = plan.images.length ? csRestore.writeImages(plan.images) : 0;
      for (const k of Object.keys(updates)) appConfig[k] = updates[k];
      appConfigModule.save();
      appConfigModule.load(); // back-fill defaults into the restored sections
      if (updates.theme) for (const blk of ['login', 'app']) {
        const rel = updates.theme[blk] && updates.theme[blk].backgroundImage;
        if (csRestore.imageMissing(rel)) warnings.push(`appearance image ${rel} is not on this console (the file has no copy of it) — set a new one under Settings → Appearance`);
      }
      const changed = Object.keys(updates).filter(k => JSON.stringify(before[k]) !== JSON.stringify(updates[k]));
      await audit(req, 'backup.settings_restore', { kind: 'settings', label: req.file && req.file.originalname,
        summary: `Restored: ${sections.join(', ')}${changed.length ? ` (changed: ${changed.join(', ')})` : ' (nothing changed)'}${nImg ? `; ${nImg} appearance image(s) written` : ''}${restoreConnection ? '; Web App access + commands taken from the file' : ''}` });
      const restartMsg = plan.restart.length ? `RESTART THE CONSOLE to apply: ${[...new Set(plan.restart)].join(', ')}` : '';
      res.redirect('/backup-restore?ok=settings&n=' + sections.length +
        ((warnings.length || restartMsg) ? '&warn=' + encodeURIComponent([restartMsg, ...warnings].filter(Boolean).join('; ')) : ''));
    } catch (err) {
      for (const k of Object.keys(before)) { if (before[k] === undefined) delete appConfig[k]; else appConfig[k] = before[k]; }
      console.error('[backup] import failed:', err);
      res.redirect('/backup-restore?error=' + encodeURIComponent('Restore failed, nothing was changed: ' + (err.message || 'unknown error')));
    }
  });

  // ── Web App config: export / import (remote config.json) ─────────────
  router.get('/backup-restore/web-app-config/export', requireAdmin, async (req, res) => {
    if (!webAppAccess.isConfigured(appConfig)) {
      return res.redirect('/backup-restore?error=' + encodeURIComponent('Web App access is not configured (Settings → Web App).'));
    }
    try {
      const accessor = webAppAccess.createAccessorFromConfig(appConfig);
      const { json } = await waConfig.readRemoteConfig(accessor);
      // The real session signing keys live in local-secrets.json, not in
      // config.json — carried so members stay signed in after a restore.
      let localSecrets = null;
      try { localSecrets = JSON.parse(String(await accessor.readFile(waConfig.joinPath(accessor.appPath, SECRETS_FILE), { encoding: 'utf8' }))); } catch (e) { /* none on the host */ }
      const envelope = {
        _meta: { type: 'web-app-config', exportedAt: new Date().toISOString(), exportedFrom: os.hostname(), via: accessor.describe(), version: 2 },
        config: json,
        ...(localSecrets ? { localSecrets } : {})
      };
      await audit(req, 'backup.waconfig_export', { kind: 'backup', label: 'Web App configuration', summary: `Web App config.json downloaded (${Object.keys(json).filter(k => !k.startsWith('_')).length} keys${localSecrets ? ', + session keys' : ''})` });
      res.set('Content-Type', 'application/json; charset=utf-8');
      res.set('Content-Disposition', `attachment; filename="web_app_config_${dateStamp()}.json"`);
      res.send(JSON.stringify(envelope, null, 2));
    } catch (err) {
      console.error('[backup] web app config export failed:', err);
      res.redirect('/backup-restore?error=' + encodeURIComponent('Web App config export failed: ' + (err.message || err)));
    }
  });

  router.post('/backup-restore/web-app-config/import', requireAdmin, uploadJson('/backup-restore'), async (req, res) => {
    const parsed = parseUpload(req, res);
    if (!parsed) return;
    const back = (msg) => res.redirect('/backup-restore?error=' + encodeURIComponent(msg));
    if (parsed._meta && parsed._meta.type && parsed._meta.type !== 'web-app-config') return back('That file is not a Web App config backup.');
    // Accept either the envelope ({config: {...}}) or a raw config.json.
    const cfg = (parsed.config && typeof parsed.config === 'object' && !Array.isArray(parsed.config)) ? parsed.config : parsed;
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return back('No Web App config found in that file.');
    const selected = normalizeArray(req.body.sections);
    const restoreCommands = req.body.restore_commands === '1';
    const keepHost = req.body.keep_host !== '0';
    // Session signing keys: whoever made the file could sign in as any
    // member with them, so they only come from the file on an explicit opt-in.
    const restoreKeys = req.body.restore_session_keys === '1';
    const wantSecrets = restoreKeys && selected.includes('localSecrets') && parsed.localSecrets && typeof parsed.localSecrets === 'object' && !Array.isArray(parsed.localSecrets);
    let present = selected.filter(k => WA_CONFIG_KEYS.includes(k) && Object.prototype.hasOwnProperty.call(cfg, k));
    const keyNote = (!restoreKeys && (present.includes('sessionKeys') || selected.includes('localSecrets'))) ? 'session keys kept as on the host (tick "restore the session keys" to take them from the file)' : '';
    if (!restoreKeys) present = present.filter(k => k !== 'sessionKeys');
    if (Array.isArray(parsed.config)) return back('No Web App config found in that file.');
    if (!present.length && !wantSecrets) return back(keyNote ? 'Only the session keys were selected — ' + keyNote + '.' : 'No sections selected to restore.');
    if (wantSecrets) {
      const ls = parsed.localSecrets;
      const extra = Object.keys(ls).filter(k => !['sessionKeys', 'createdAt', '_comment'].includes(k));
      if (extra.length || !validKeyList(ls.sessionKeys) || ls.sessionKeys.length < 2 || ls.sessionKeys.some(k => k.length < 16)) return back('Nothing was restored — the session keys in the file are not valid signing keys.');
    }
    const shapeErrs = checkWaConfigShapes(cfg, present);
    if (shapeErrs.length) return back('Nothing was restored — ' + shapeErrs.join('; '));
    if (!webAppAccess.isConfigured(appConfig)) return back('Web App access is not configured (Settings → Web App).');
    try {
      const accessor = webAppAccess.createAccessorFromConfig(appConfig);
      // The live config: the selected sections are laid over it. If it's
      // missing or broken (when a restore matters most), start from the file.
      let json, liveBroken = null;
      try { ({ json } = await waConfig.readRemoteConfig(accessor)); }
      catch (e) { liveBroken = (e.message || String(e)).replace(/ Fix it on the Web App before editing here\.?/, ''); json = {}; }
      const notes = [], restoredKeys = [], keptHost = [];
      const cfgPath = waConfig.remoteConfigPath(accessor);
      if (liveBroken) {
        // Rebuilding from a partial selection would silently drop every
        // section not ticked (port, database, mail…): require all of them.
        const fileKeys = Object.keys(cfg).filter(k => WA_CONFIG_KEYS.includes(k) && !WA_COMMAND_KEYS.includes(k) && k !== 'sessionKeys');
        const missing = fileKeys.filter(k => !present.includes(k));
        if (missing.length) return back(`The Web App's config.json can't be read (${liveBroken}). To rebuild it from this file, tick ALL its sections (missing: ${missing.join(', ')}).`);
        await accessor.runCommand(`[ -e ${shq(cfgPath)} ] && cp -p -- ${shq(cfgPath)} ${shq(cfgPath + '.broken-' + Date.now())} ; ( umask 077; [ -e ${shq(cfgPath)} ] || : > ${shq(cfgPath)} ); true`, { timeoutMs: 20000 }).catch(() => {});
        notes.push(`the Web App's config.json could not be read (${liveBroken}) — the old file was kept as config.json.broken-…, and config.json was rebuilt from this file`);
      }
      for (const k of present) {
        if (WA_COMMAND_KEYS.includes(k) && !restoreCommands) {
          if (JSON.stringify(cfg[k]) !== JSON.stringify(json[k])) notes.push(`${k} differs from the file and was kept as on the host — tick the commands box to restore it`);
          continue;
        }
        if (keepHost && !liveBroken && WA_HOST_KEYS.includes(k)) { keptHost.push(json[k] === undefined ? `${k} (default)` : k); continue; }
        if (keepHost && !liveBroken && WA_HOST_KEYS_IF_SET.includes(k) && typeof json[k] === 'string' && json[k].trim()) {
          if (json[k] !== cfg[k]) keptHost.push(`${k} (${json[k]})`);
          continue;
        }
        if (keepHost && !liveBroken && k === 'aws' && cfg.aws && typeof cfg.aws === 'object') {
          const h = (json.aws && typeof json.aws === 'object') ? json.aws : {};
          json.aws = { ...cfg.aws };
          if (h.runningInAws === undefined) delete json.aws.runningInAws; else json.aws.runningInAws = h.runningInAws;
          if (typeof h.region === 'string' && h.region.trim()) json.aws.region = h.region;
          keptHost.push('aws.runningInAws', 'aws.region'); restoredKeys.push(k); continue;
        }
        json[k] = JSON.parse(JSON.stringify(cfg[k]));
        restoredKeys.push(k);
      }
      // Same limits as Web App Settings; port must be a real port.
      const errs = require('./webAppSettings').validateConfigValues(json, restoredKeys);
      if (restoredKeys.includes('port') && !(Number.isInteger(json.port) && json.port >= 1 && json.port <= 65535)) errs.push(`port: ${JSON.stringify(json.port)} is not a port number`);
      if (restoredKeys.includes('server') && json.server && json.server.ssl === true) {
        for (const f of ['keyPath', 'certPath']) {
          const fp = json.server[f];
          const abs = fp && (fp.startsWith('/') ? fp : waConfig.joinPath(accessor.appPath, fp));
          if (!abs || !(await accessor.exists(abs).catch(() => false))) errs.push(`server.ssl is on but server.${f} (${fp || 'empty'}) does not exist on the Web App host — it would refuse to start`);
        }
      }
      if (errs.length) {
        await audit(req, 'backup.waconfig_restore', { kind: 'backup', label: req.file && req.file.originalname, summary: `Refused: ${errs.join('; ')}` });
        return back('Nothing was restored — the file has values Web App Settings would not accept: ' + errs.join('; '));
      }
      if (restoredKeys.length || liveBroken) {
        await waConfig.writeRemoteConfig(accessor, json);
        if (liveBroken) await accessor.runCommand(`chmod 600 ${shq(cfgPath)}`, { timeoutMs: 20000 }).catch(() => {});
        waConfig.markWebAppWritten(appConfig);
        appConfigModule.save();
      }
      if (wantSecrets) {
        const sp = waConfig.joinPath(accessor.appPath, SECRETS_FILE);
        await accessor.runCommand(`( umask 077; [ -e ${shq(sp)} ] || : > ${shq(sp)} )`, { timeoutMs: 20000 }).catch(() => {});
        await accessor.writeFile(sp, jsonFileText(parsed.localSecrets));
        await accessor.runCommand(`chmod 600 ${shq(sp)}`, { timeoutMs: 20000 }).catch(() => {});
        waConfig.markWebAppWritten(appConfig); appConfigModule.save();
        restoredKeys.push('session keys');
      }
      if (keptHost.length) notes.push(`this server's own ${keptHost.join(', ')} kept (untick "keep this server's settings" to take them from the file)`);
      if (restoredKeys.includes('database')) notes.push('database settings restored — the console keeps using its own connection (Settings → Web App); make sure both point at the same database');
      if (restoredKeys.includes('email')) {
        const h = (o) => (o && o.email && o.email.smtp && o.email.smtp.host) || '';
        notes.push(`mail now goes out via ${json.email && json.email.transport || '?'}${h(json) ? ' / ' + h(json) : ''} — password-reset links are sent that way`);
      }
      await audit(req, 'backup.waconfig_restore', { kind: 'backup', label: req.file && req.file.originalname,
        summary: `Restored: ${restoredKeys.join(', ') || 'nothing'}${keptHost.length ? `; host kept: ${keptHost.join(', ')}` : ''}${restoreCommands ? '; maintenance command taken from the file' : ''}` });
      if (keyNote) notes.push(keyNote);
      if (!restoredKeys.length && !liveBroken) return res.redirect('/backup-restore?ok=waconfig&n=0&warn=' + encodeURIComponent(['Nothing was changed.', ...notes].join(' ')));
      res.redirect('/backup-restore?ok=waconfig&restored=1&n=' + restoredKeys.length +
        '&warn=' + encodeURIComponent(['Every restored section takes effect after the Web App restarts.', ...notes].join(' ')));
    } catch (err) {
      console.error('[backup] web app config import failed:', err);
      back('Web App config restore failed, nothing was changed: ' + (/call stack/i.test(err.message || '') ? 'the file is nested too deeply' : (err.message || err)));
    }
  });

  // ── Web App website: export / import (remote HTML fragments) ─────────
  router.get('/backup-restore/web-app-website/export', requireAdmin, async (req, res) => {
    if (!webAppAccess.isConfigured(appConfig)) {
      return res.redirect('/backup-restore?error=' + encodeURIComponent('Web App access is not configured (Settings → Web App).'));
    }
    try {
      const accessor = webAppAccess.createAccessorFromConfig(appConfig);
      const sections = {};
      await Promise.all(WA_SECTION_KEYS.map(async (key) => {
        const p = waConfig.joinPath(accessor.appPath, 'HTML/' + key + '.html');
        try { sections[key] = await accessor.readFile(p, { encoding: 'utf8' }); }
        catch (e) { /* skip a missing/unreadable fragment */ }
      }));
      const missingSections = WA_SECTION_KEYS.filter(k => typeof sections[k] !== 'string');
      const envelope = {
        _meta: { type: 'web-app-website', exportedAt: new Date().toISOString(), exportedFrom: os.hostname(), via: accessor.describe(), version: 1, missing: missingSections },
        sections
      };
      res.set('Content-Type', 'application/json; charset=utf-8');
      res.set('Content-Disposition', `attachment; filename="web_app_website_${dateStamp()}.json"`);
      audit(req, 'backup.website_export', { kind: 'backup', label: 'Web App website', summary: `HTML sections downloaded: ${Object.keys(sections).join(', ')}` }).catch(() => {});
      res.send(JSON.stringify(envelope, null, 2));
    } catch (err) {
      console.error('[backup] web app website export failed:', err);
      res.redirect('/backup-restore?error=' + encodeURIComponent('Web App website export failed: ' + (err.message || err)));
    }
  });

  router.post('/backup-restore/web-app-website/import', requireAdmin, uploadJson('/backup-restore'), async (req, res) => {
    const parsed = parseUpload(req, res);
    if (!parsed) return;
    if (!parsed._meta || typeof parsed._meta !== 'object' || parsed._meta.type !== 'web-app-website') {
      return res.redirect('/backup-restore?error=' + encodeURIComponent('That file is not a Web App website backup (download one with Backup above).'));
    }
    const sections = (parsed.sections && typeof parsed.sections === 'object' && !Array.isArray(parsed.sections)) ? parsed.sections : null;
    if (!sections) {
      return res.redirect('/backup-restore?error=' + encodeURIComponent('No website sections found in that file.'));
    }
    const selected = normalizeArray(req.body.sections);
    // Restore only sections that are selected AND present AND recognized.
    const recognized = WA_SECTION_KEYS.filter(k => selected.includes(k) && typeof sections[k] === 'string');
    if (recognized.length === 0) {
      return res.redirect('/backup-restore?error=' + encodeURIComponent('No sections selected to restore.'));
    }
    if (!webAppAccess.isConfigured(appConfig)) {
      return res.redirect('/backup-restore?error=' + encodeURIComponent('Web App access is not configured (Settings → Web App).'));
    }
    // The editor saves a section through a 64 KB request; a restore may not
    // put in what the editor couldn't save back.
    const big = recognized.filter(k => Buffer.byteLength(sections[k], 'utf8') > SECTION_MAX_BYTES);
    if (big.length) {
      await audit(req, 'backup.website_restore', { kind: 'backup', label: req.file && req.file.originalname, summary: `Refused: section(s) over ${SECTION_MAX_BYTES / 1024} KB: ${big.join(', ')}` });
      return res.redirect('/backup-restore?error=' + encodeURIComponent(`Nothing was restored — section(s) larger than the editor allows (${SECTION_MAX_BYTES / 1024} KB): ${big.join(', ')}`));
    }
    // One file operation at a time with the Full / Image restores.
    if (!startOp('website restore', req.file && req.file.originalname)) return res.redirect('/backup-restore?error=' + encodeURIComponent(`A ${opStatus.kind} is running — wait for it to finish.`));
    try {
      const accessor = webAppAccess.createAccessorFromConfig(appConfig);
      const written = [];
      try {
        for (const key of recognized) { await accessor.writeFile(waConfig.joinPath(accessor.appPath, 'HTML/' + key + '.html'), sections[key]); written.push(key); }
      } catch (e) { throw new Error(`${e.message || e} — ${written.length ? 'already restored: ' + written.join(', ') : 'none restored'}; run the restore again`); }
      finishOp(true);
      await audit(req, 'backup.website_restore', { kind: 'backup', label: req.file && req.file.originalname, summary: `HTML sections restored: ${recognized.map(k => `${k} (${Buffer.byteLength(sections[k], 'utf8')} B)`).join(', ')}` });
      res.redirect('/backup-restore?ok=wawebsite&n=' + recognized.length);
    } catch (err) {
      finishOp(false, err.message || String(err));
      console.error('[backup] web app website import failed:', err);
      await audit(req, 'backup.website_restore', { kind: 'backup', label: req.file && req.file.originalname, summary: `FAILED: ${err.message || err}` });
      res.redirect('/backup-restore?error=' + encodeURIComponent('Web App website restore failed: ' + (err.message || err)));
    }
  });

  // ── Images: export / import (HTML/images/* + uploads/**) ─────────────
  // The files on Web App Website → Images, as { _meta, images: { name:
  // base64 } } — the same shape a rebuild bundle carries under
  // website.images, so Image Restore also accepts a full bundle. Names must
  // be plain (letters, digits . _ -) with an image extension; a manifest
  // sha256 is checked before anything is written.
  const IMG_NAME_RE = /^[A-Za-z0-9._-]+$/;
  router.get('/backup-restore/web-app-images/export', requireAdmin, async (req, res) => {
    if (!webAppAccess.isConfigured(appConfig)) {
      return res.redirect('/backup-restore?error=' + encodeURIComponent('Web App access is not configured (Settings → Web App).'));
    }
    try {
      const accessor = webAppAccess.createAccessorFromConfig(appConfig);
      const imgDir = waConfig.joinPath(accessor.appPath, IMAGES_REL_DIR);
      const upDirs = uploadsHelper.KINDS.map(k => waConfig.joinPath(accessor.appPath, UPLOADS_REL_DIR + '/' + k));
      const b = await accessor.readBundle({ files: [], dirs: [imgDir, ...upDirs] });
      for (const d of [imgDir, ...upDirs]) { const e = b.dirs[d] && b.dirs[d].err; if (e) throw new Error(`Could not list ${d}: ${e}`); }
      const allImg = (b.dirs[imgDir] || {}).names || [];
      const names = allImg.filter(n => IMAGE_EXT.test(n) && IMG_NAME_RE.test(n) && !n.startsWith('.')).sort();
      const problems = [];
      const odd = allImg.filter(n => !names.includes(n) && !/^(README\.txt|\.gitkeep)$/.test(n) && !n.startsWith('.'));
      if (odd.length) problems.push(`${odd.length} file(s) in HTML/images not backed up (only .png .jpg .gif .webp .svg with plain names): ${odd.join(', ')}`);
      const upRels = [];
      uploadsHelper.KINDS.forEach((k, i) => {
        for (const n of ((b.dirs[upDirs[i]] || {}).names || [])) if (uploadsHelper.isValidRel(`${k}/${n}`)) upRels.push(`${k}/${n}`);
      });
      upRels.sort();
      const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
      const images = {}, files = {}, uploads = {}, uploadFiles = {}, skipped = [];
      let bytes = 0;
      // Same reader and parallelism as the Full Backup (small files in one
      // command, 4 at a time).
      await mapPool(names, FILE_PARALLEL, async (n) => {
        try {
          const buf = Buffer.from(await accessor.readFile(waConfig.joinPath(imgDir, n)));
          images[n] = buf.toString('base64');
          files[n] = { size: buf.length, sha256: sha(buf) };
          bytes += buf.length;
        } catch (e) { skipped.push(`${IMAGES_REL_DIR}/${n}: ${e.message || e}`); }
      });
      await mapPool(upRels, FILE_PARALLEL, async (rel) => {
        try {
          const buf = Buffer.from(await accessor.readFile(waConfig.joinPath(accessor.appPath, UPLOADS_REL_DIR + '/' + rel)));
          uploads[rel] = buf.toString('base64');
          uploadFiles[rel] = { size: buf.length, sha256: sha(buf) };
          bytes += buf.length;
        } catch (e) { skipped.push(`${UPLOADS_REL_DIR}/${rel}: ${e.message || e}`); }
      });
      if (skipped.length) problems.push(`${skipped.length} file(s) could not be read: ${skipped.slice(0, 5).join('; ')}`);
      const refs = await liveImagePaths();
      const notOnDisk = (refs || []).filter(r => !upRels.includes(r));
      if (notOnDisk.length) problems.push(`${notOnDisk.length} photo(s) the database points at are not on the host, so not in this backup: ${notOnDisk.slice(0, 5).join(', ')}`);
      const nImg = Object.keys(images).length, nUp = Object.keys(uploads).length;
      const envelope = {
        _meta: { type: 'web-app-images', exportedAt: new Date().toISOString(), exportedFrom: os.hostname(), via: accessor.describe(), version: 2,
          count: nImg, uploadCount: nUp, bytes, files, uploadFiles, skipped, warnings: problems },
        images,
        uploads
      };
      await audit(req, 'backup.images_export', { kind: 'backup', label: 'Images',
        summary: `${nImg} website image(s) + ${nUp} upload(s), ${fmtBytes(bytes)}${problems.length ? ' — WARNINGS: ' + problems.join(' | ') : ''}` });
      res.set('Content-Type', 'application/json; charset=utf-8');
      res.set('Content-Disposition', `attachment; filename="web_app_images_${dateStamp()}.json"`);
      res.send(JSON.stringify(envelope));
    } catch (err) {
      console.error('[backup] web app images export failed:', err);
      res.redirect('/backup-restore?error=' + encodeURIComponent('Image backup failed: ' + (err.message || err)));
    }
  });

  router.post('/backup-restore/web-app-images/import', requireAdmin, (req, res, next) => {
    bundleUpload.single('backup')(req, res, (err) => {
      if (err) return res.redirect('/backup-restore?error=' + encodeURIComponent(err.code === 'LIMIT_FILE_SIZE' ? 'That file is larger than the 256 MB upload limit.' : (err.message || 'Upload failed')));
      next();
    });
  }, async (req, res) => {
    const back = (msg) => res.redirect('/backup-restore?error=' + encodeURIComponent(msg));
    if (!req.file) return back('No file received.');
    let parsed;
    try { parsed = parseJsonBuffer(req.file.buffer); } catch (e) { return back('That file is not valid JSON.'); }
    const refuse = async (msg) => {
      await audit(req, 'backup.images_restore', { kind: 'backup', label: req.file.originalname, summary: `Refused: ${msg}` });
      return back(msg);
    };
    const type = parsed && parsed._meta && parsed._meta.type;
    const isObj = (o) => o && typeof o === 'object' && !Array.isArray(o);
    let images = null, uploads = null, manifest = {}, upManifest = {};
    if (type === 'web-app-images') {
      images = parsed.images;
      uploads = parsed.uploads; // v2+; a v1 Image Backup has website images only
      manifest = (parsed._meta && parsed._meta.files) || {};
      upManifest = (parsed._meta && parsed._meta.uploadFiles) || {};
    } else if (type === BUNDLE_TYPE) {
      images = parsed.website && parsed.website.images;
      uploads = parsed.uploads && parsed.uploads.files;
      // The bundle's own manifest (keys "HTML/images/<n>", "uploads/<rel>").
      const mf = (parsed._meta && parsed._meta.files) || {};
      for (const k of Object.keys(mf)) {
        if (k.startsWith('HTML/images/')) manifest[k.slice(12)] = mf[k];
        else if (k.startsWith('uploads/')) upManifest[k.slice(8)] = mf[k];
      }
    } else {
      return back('That file is not an Image Backup or a Web App Full Backup bundle.');
    }
    images = isObj(images) ? images : {};
    uploads = isObj(uploads) ? uploads : {};
    const okName = (n) => IMAGE_EXT.test(n) && IMG_NAME_RE.test(n) && !n.startsWith('.') && n.length <= 200;
    const names = Object.keys(images).filter(n => okName(n) && typeof images[n] === 'string');
    const rels = Object.keys(uploads).filter(r => uploadsHelper.isValidRel(r) && typeof uploads[r] === 'string');
    const ignored = [...Object.keys(images).filter(n => !names.includes(n)), ...Object.keys(uploads).filter(r => !rels.includes(r)).map(r => 'uploads/' + r)];
    if (!names.length && !rels.length) return refuse('No images found in that file.' + (ignored.length ? ` (${ignored.length} entr${ignored.length === 1 ? 'y' : 'ies'} with names that aren't allowed were ignored.)` : ''));
    // A v2 Image Backup lists every file with a checksum; one that doesn't is damaged / edited.
    if (type === 'web-app-images' && parsed._meta.version >= 2) {
      const unlisted = [...names.filter(n => !manifest[n]), ...rels.filter(r => !upManifest[r]).map(r => 'uploads/' + r)];
      if (unlisted.length) return refuse(`Nothing was restored — ${unlisted.length} file(s) are not in the backup's checksum list: ${unlisted.slice(0, 5).join(', ')}${unlisted.length > 5 ? '…' : ''}`);
    }
    // Decode and check everything BEFORE writing anything.
    const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
    // The editor's own checks: the bytes must be the image the name says
    // (uploads: jpg / png / webp only, like the uploads contract), ≤ 8 MB.
    const sniff = require('./webAppWebsite').sniffImage;
    const decode = (label, b64, m, isUpload) => {
      if (!/^[A-Za-z0-9+/\s]*={0,2}\s*$/.test(b64)) throw new Error(`"${label}" is not valid base64. Nothing was restored.`);
      const buf = Buffer.from(b64, 'base64');
      if (!buf.length) throw new Error(`"${label}" in the file is empty. Nothing was restored.`);
      if (m && m.sha256 && sha(buf) !== m.sha256) throw new Error(`"${label}" does not match its checksum — the file is damaged. Nothing was restored.`);
      // A file that isn't the image its name says (or is huge) is SKIPPED
      // with a warning — never written, but it doesn't block the others.
      if (buf.length > RESTORE_IMAGE_MAX) return { skip: `"${label}" is larger than ${RESTORE_IMAGE_MAX / 1024 / 1024} MB` };
      const ext = (/\.([A-Za-z0-9]+)$/.exec(label) || [])[1].toLowerCase();
      const kind = isUpload ? uploadsHelper.sniffExt(buf) : (sniff(buf) || {}).kind;
      const same = kind && (kind === ext || (kind === 'jpg' && ext === 'jpeg'));
      if (!same) return { skip: `"${label}" is not a ${ext.toUpperCase()} image (its contents are ${kind ? kind.toUpperCase() : 'not an image'})` };
      return { buf };
    };
    const imgBufs = {}, upBufs = {}, notWritten = [];
    try {
      for (const n of names) { const d = decode(n, images[n], manifest[n], false); if (d.skip) notWritten.push(d.skip); else imgBufs[n] = d.buf; }
      for (const r of rels) { const d = decode(`uploads/${r}`, uploads[r], upManifest[r], true); if (d.skip) notWritten.push(d.skip); else upBufs[r] = d.buf; }
    } catch (e) { return refuse(e.message); }
    const wNames = names.filter(n => imgBufs[n]), wRels = rels.filter(r => upBufs[r]);
    if (!wNames.length && !wRels.length) return refuse('Nothing was restored — ' + notWritten.join('; '));
    const pruneFiles = req.body.prune_files !== '0';
    if (!webAppAccess.isConfigured(appConfig)) return back('Web App access is not configured (Settings → Web App).');
    let nImg = 0, nUp = 0, same = 0, removed = 0;
    const total = wNames.length + wRels.length;
    // One file operation at a time with the Full Backup / Restore (whose
    // clean-up step would otherwise delete what this writes).
    if (!startOp('image restore', req.file.originalname)) return back(`A ${opStatus.kind} is running — wait for it to finish.`);
    try {
      const accessor = webAppAccess.createAccessorFromConfig(appConfig);
      await sweepTempFiles(accessor);
      const imgDir = waConfig.joinPath(accessor.appPath, IMAGES_REL_DIR);
      // Over SSH / EC2 a file already identical on the host isn't sent
      // again (one checksum command instead of many upload pieces) — a
      // re-run after a failure only sends what's missing.
      const remote = accessor.mode !== 'local';
      const unchanged = async (abs, buf) => {
        if (!remote) return false;
        try {
          const r = await accessor.runCommand(`(sha256sum ${shq(abs)} 2>/dev/null || shasum -a 256 ${shq(abs)} 2>/dev/null) | cut -c1-64`, { timeoutMs: 30000 });
          return String(r.stdout || '').trim() === sha(buf);
        } catch (e) { return false; }
      };
      const put = async (abs, buf) => { if (await unchanged(abs, buf)) { same++; return; } await accessor.writeFileChunked(abs, buf); };
      // mkdir -p + atomic write; ≤40 KB SSM pieces on EC2; 4 at a time.
      mark('Images', 'in_progress', `${total} files`);
      await mapPool(wNames, FILE_PARALLEL, async (n) => { await put(waConfig.joinPath(imgDir, n), imgBufs[n]); nImg++; });
      await mapPool(wRels, FILE_PARALLEL, async (r) => { await put(waConfig.joinPath(accessor.appPath, UPLOADS_REL_DIR + '/' + r), upBufs[r]); nUp++; });
      mark('Images', 'ok', `${nImg} website image(s), ${nUp} upload(s)${same ? ` (${same} already identical)` : ''}`);
      if (pruneFiles) {
        // Like the Full restore: files added after the backup go, so the
        // site looks as it did — but never a file the backup lists as
        // skipped / not written, nor an upload the live database points at.
        const keepImg = new Set([...names, ...((parsed._meta && Array.isArray(parsed._meta.skipped)) ? parsed._meta.skipped.map(x => String(x).split(':')[0].replace(/^HTML\/images\//, '')) : [])]);
        const refs = await liveImagePaths();
        if (refs === null) throw new Error('could not read the database to protect the photos it uses — files not in the backup were NOT removed');
        const keepUp = new Set([...rels, ...refs]);
        const upDirs = uploadsHelper.KINDS.map(k => waConfig.joinPath(accessor.appPath, UPLOADS_REL_DIR + '/' + k));
        const listing = await accessor.readBundle({ files: [], dirs: [imgDir, ...upDirs] });
        for (const d of [imgDir, ...upDirs]) { const e = listing.dirs[d] && listing.dirs[d].err; if (e) throw new Error(`Could not list ${d} to remove files not in the backup: ${e}`); }
        const hasImages = names.length > 0 || type === 'web-app-images';
        const extra = [];
        if (hasImages) for (const n of ((listing.dirs[imgDir] || {}).names || [])) if (IMAGE_EXT.test(n) && IMG_NAME_RE.test(n) && !keepImg.has(n)) extra.push(waConfig.joinPath(imgDir, n));
        if (parsed.uploads || (parsed._meta && parsed._meta.uploadCount !== undefined)) uploadsHelper.KINDS.forEach((k, i) => {
          for (const n of ((listing.dirs[upDirs[i]] || {}).names || [])) { const rel = `${k}/${n}`; if (uploadsHelper.isValidRel(rel) && !keepUp.has(rel)) extra.push(uploadsHelper.absPath(accessor, rel)); }
        });
        for (let i = 0; i < extra.length; i += 200) {
          const rr = await accessor.runCommand(`rm -f -- ${extra.slice(i, i + 200).map(shq).join(' ')}`, { timeoutMs: 60000, comment: 'image restore: remove files not in the backup' });
          if (rr.code !== 0) throw new Error(`Could not remove files not in the backup: ${(rr.stderr || '').trim() || 'exit ' + rr.code}`);
        }
        removed = extra.length;
      }
      finishOp(true);
      await audit(req, 'backup.images_restore', { kind: 'backup', label: req.file.originalname,
        summary: `${nImg} website image(s) + ${nUp} upload(s) restored from ${type === 'web-app-images' ? 'an Image Backup' : 'a full bundle'}${removed ? `; ${removed} file(s) not in the backup removed` : ''}${notWritten.length ? `; NOT written: ${notWritten.join('; ')}` : ''}${ignored.length ? `; ${ignored.length} with names that aren't allowed ignored` : ''}` });
      const warns = [];
      if (removed) warns.push(`${removed} file(s) added after the backup were removed (photos the database uses are always kept).`);
      if (notWritten.length) warns.push(`Not written: ${notWritten.slice(0, 5).join('; ')}${notWritten.length > 5 ? '…' : ''}.`);
      if (ignored.length) warns.push(`${ignored.length} entr${ignored.length === 1 ? 'y' : 'ies'} with names that aren't allowed were ignored: ${ignored.slice(0, 5).join(', ')}${ignored.length > 5 ? '…' : ''}`);
      if (parsed._meta && Array.isArray(parsed._meta.warnings) && parsed._meta.warnings.length) warns.push('When this backup was made: ' + parsed._meta.warnings.join(' | '));
      res.redirect(`/backup-restore?ok=waimages&n=${nImg}&u=${nUp}` + (warns.length ? '&warn=' + encodeURIComponent(warns.join(' ')) : ''));
    } catch (err) {
      finishOp(false, err.message || String(err));
      console.error('[backup] web app images import failed:', err);
      await audit(req, 'backup.images_restore', { kind: 'backup', label: req.file.originalname,
        summary: `Image restore FAILED after ${nImg + nUp} of ${total}: ${err.message || err}` });
      back(`Image restore failed after ${nImg + nUp} of ${total} file(s): ${err.message || err}`);
    }
  });

  // ── Web App database: export / import (mmoa_web_app.db / MySQL) ──
  router.get('/backup-restore/database/export', requireAdmin, async (req, res) => {
    if (!db || !db.available) {
      return res.redirect('/backup-restore?error=' + encodeURIComponent('Database is not available (Settings → Web App).'));
    }
    try {
      try { if (webAppAccess.isConfigured(appConfig)) await sweepTempFiles(webAppAccess.createAccessorFromConfig(appConfig)); } catch (e) { /* best effort */ }
      const backup = await buildDatabaseBackup();
      res.set('Content-Type', 'application/json; charset=utf-8');
      res.set('Content-Disposition', `attachment; filename="web_app_database_${dateStamp()}.json"`);
      audit(req, 'backup.database_export', { kind: 'backup', label: 'Web App database', summary: `Database downloaded: ${backup._meta.tableCount} tables / ${backup._meta.rowCount} rows` }).catch(() => {});
      res.send(JSON.stringify(backup, null, 2));
    } catch (err) {
      console.error('[backup] database export failed:', err);
      res.redirect('/backup-restore?error=' + encodeURIComponent('Database export failed: ' + (err.message || err)));
    }
  });

  router.post('/backup-restore/database/import', requireAdmin, (req, res, next) => {
    // Same limit as bundles: a database backup outgrows 4 MB quickly
    // (org_metrics alone grows every hour).
    bundleUpload.single('backup')(req, res, (err) => {
      if (err) return res.redirect('/backup-restore?error=' + encodeURIComponent(err.code === 'LIMIT_FILE_SIZE' ? 'That file is larger than the 256 MB upload limit.' : (err.message || 'Upload failed')));
      next();
    });
  }, async (req, res) => {
    const parsed = parseUpload(req, res);
    if (!parsed) return;
    const back = (msg) => res.redirect('/backup-restore?error=' + encodeURIComponent(msg));
    if (!parsed._meta || typeof parsed._meta !== 'object' || parsed._meta.type !== 'web-app-database') return back('That file is not a Web App database backup (download one with Backup above).');
    const backupTables = (parsed.tables && typeof parsed.tables === 'object' && !Array.isArray(parsed.tables)) ? parsed.tables : null;
    if (!backupTables || !Object.keys(backupTables).length) return back('No database tables found in that file.');
    const confirm = ((req.body && req.body.confirm_text) || '').trim();
    if (confirm !== 'RESTORE') return back('Type RESTORE to confirm the database restore.');
    if (!db || !db.available) return back('Database is not available (Settings → Web App).');
    // One at a time with the Full Backup / Restore and the other restores.
    if (!startOp('database restore', req.file && req.file.originalname)) return back(`A ${opStatus.kind} is running — wait for it to finish.`);
    // What changes for people: accounts and locks before vs after.
    const count = async (sql, p) => { try { const r = await db.getAsync(sql, p || []); return r ? Number(r.c) : null; } catch (e) { return null; } };
    const now = Date.now();
    const usersBefore = await count('SELECT COUNT(*) AS c FROM users');
    let accessor = null;
    try { if (webAppAccess.isConfigured(appConfig)) accessor = webAppAccess.createAccessorFromConfig(appConfig); } catch (e) { /* DB-only setups */ }
    await sweepTempFiles(accessor);
    let tables, warnings;
    try {
      mark('Database', 'in_progress', 'replacing every table in one transaction');
      ({ tables, warnings } = await restoreDatabase(backupTables));
      mark('Database', warnings.length ? 'warn' : 'ok', `${tables} tables replaced`);
      finishOp(true);
    } catch (err) {
      finishOp(false, err.message || String(err));
      console.error('[backup] database import failed:', err);
      restoreLog(req, { kind: 'database restore', file: req.file && req.file.originalname, ok: false, error: err.message || String(err) });
      await audit(req, 'backup.database_restore', { kind: 'backup', label: req.file && req.file.originalname, summary: `FAILED (nothing was changed): ${err.message || err}` });
      return back('Database restore failed: ' + (err.message || err));
    }
    // The database IS replaced from here on — nothing below may report otherwise.
    try {
      // Rows that point at photos which aren't on the host any more (deleted
      // together with their row after the backup): the files are only in an
      // Image Backup or a Full bundle.
      if (accessor) {
        const refs = dbImagePaths(backupTables);
        if (refs.length) {
          const dirs = uploadsHelper.KINDS.map(k => waConfig.joinPath(accessor.appPath, UPLOADS_REL_DIR + '/' + k));
          const listing = await accessor.readBundle({ files: [], dirs });
          const have = new Set();
          uploadsHelper.KINDS.forEach((k, i) => { for (const n of ((listing.dirs[dirs[i]] || {}).names || [])) have.add(`${k}/${n}`); });
          const missing = refs.filter(r => !have.has(r));
          if (missing.length) warnings.push(`${missing.length} photo(s) the restored data points at are not on the Web App host (deleted after the backup?) — restore them with Image Restore or a Full Backup bundle: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? '…' : ''}`);
        }
      }
      const usersAfter = await count('SELECT COUNT(*) AS c FROM users');
      const lockedAfter = await count("SELECT COUNT(DISTINCT scope_key) AS c FROM login_lockouts WHERE scope <> 'ip' AND locked_until_ms > ?", [now]);
      const impact = `nonprofit accounts ${usersBefore ?? '?'} → ${usersAfter ?? '?'}${lockedAfter ? `; ${lockedAfter} login(s) are locked` : ''}`;
      // Written AFTER the load, so it lands in the restored admin_audit; the
      // local restore log keeps a copy the next restore can't overwrite.
      await audit(req, 'backup.database_restore', { kind: 'backup', label: req.file && req.file.originalname,
        summary: `Database replaced: ${tables} tables (${impact})${warnings.length ? '; ' + warnings.join('; ') : ''}` });
      restoreLog(req, { kind: 'database restore', file: req.file && req.file.originalname, ok: true, tables, impact, warnings });
      waConfig.markWebAppWritten(appConfig); appConfigModule.save();
      res.redirect('/backup-restore?ok=database&restored=1&n=' + tables + '&warn=' + encodeURIComponent([
        `Restart the Web App now — it still holds data from before the restore in memory. ${impact}. Passwords and sign-ins are as they were in the backup (a password changed since then is back to the old one).`, ...warnings].join(' ')));
    } catch (err) {
      console.error('[backup] database restore follow-up failed:', err);
      res.redirect('/backup-restore?ok=database&restored=1&n=' + tables + '&warn=' + encodeURIComponent(`The database WAS replaced, but a follow-up step failed (${err.message || err}). Restart the Web App.`));
    }
  });

  // The live tables and their columns, so the restore form can say BEFORE
  // the operator types RESTORE what the file would empty, skip or default.
  router.get('/backup-restore/database/schema', requireAdmin, async (req, res) => {
    try {
      const live = await dbListTables();
      const described = await dbSchema.describeTables(db, live);
      const out = {};
      for (const [t, cols] of described) out[t] = cols.map(c => c.name);
      res.json({ ok: true, tables: out });
    } catch (e) { res.json({ ok: false, error: e.message || String(e) }); }
  });

  // ── Web App rebuild: bundle endpoints (JSON, driven by rebuildCard) ──
  // What's running (or last ran). The status window polls this.
  router.get('/backup-restore/bundle/status', requireAdmin, (req, res) => {
    res.json(opStatus || { running: false, idle: true });
  });

  router.post('/backup-restore/bundle/create', requireAdmin, express.json(), async (req, res) => {
    if (!webAppAccess.isConfigured(appConfig)) {
      return res.status(400).json({ ok: false, error: 'Web App access is not configured (Settings → Web App).' });
    }
    if (!startOp('backup')) return busyError(res);
    try {
      const bundle = await buildBundle(mark, { maintenanceOnForBackup: !!(req.body && req.body.maintenanceOnForBackup === true) });
      mark('Save bundle', 'in_progress', 'writing to backups/');
      const name = uniqueBundleName(`web_app_bundle_${bundleStamp()}`);
      writeBundleFile(name, JSON.stringify(bundle));
      const st = fs.statSync(path.join(BUNDLE_DIR, name));
      const summary = summarizeBundle(bundle);
      writeBundleMeta(name, summary, st);
      mark('Save bundle', 'ok', `${name} (${fmtBytes(st.size)})`);
      opStatus.name = name;
      finishOp(true);
      console.log(`[backup] bundle created: ${name} (${fmtBytes(st.size)})`);
      await audit(req, 'backup.create', { kind: 'backup', id: name, label: name,
        summary: `Bundle created (${fmtBytes(st.size)}): ${summary.tables} tables / ${summary.rows} rows, ${summary.sections} sections, ${summary.images} images, ${summary.uploads} uploads, ${summary.templates} templates, secrets ${summary.localSecrets ? 'yes' : 'no'}${summary.warnings.length ? `, ${summary.warnings.length} warning(s)` : ''}` });
      res.json({ ok: true, name, size: st.size, summary });
    } catch (err) {
      finishOp(false, err.message || String(err));
      console.error('[backup] bundle create failed:', err);
      await audit(req, 'backup.create', { kind: 'backup', summary: `Bundle creation FAILED: ${err.message || err}` });
      res.status(500).json({ ok: false, error: err.message || String(err) });
    }
  });

  // The console settings export carried inside a bundle, as the file the
  // Console settings → Restore form takes.
  router.get('/backup-restore/bundle/console-settings/:name', requireAdmin, (req, res) => {
    try {
      const { name, bundle } = readBundleFile(req.params.name);
      const c = bundle.console;
      if (!c || typeof c !== 'object' || Array.isArray(c)) return res.status(404).send('This bundle has no console settings section');
      res.set('Content-Type', 'application/json; charset=utf-8');
      res.set('Content-Disposition', `attachment; filename="admin_console_config_from_${name}"`);
      res.send(JSON.stringify(c, null, 2));
    } catch (err) {
      res.status(400).send(err.message || String(err));
    }
  });

  router.get('/backup-restore/bundle/download/:name', requireAdmin, (req, res) => {
    const n = safeBundleName(req.params.name);
    if (!n) return res.status(400).send('Bad bundle name');
    const p = path.join(BUNDLE_DIR, n);
    if (!fs.existsSync(p)) return res.status(404).send('Bundle not found');
    res.download(p, n);
  });

  router.post('/backup-restore/bundle/delete', requireAdmin, express.json(), async (req, res) => {
    const n = safeBundleName(req.body && req.body.name);
    if (!n) return res.status(400).json({ ok: false, error: 'Bad bundle name' });
    if (!fs.existsSync(path.join(BUNDLE_DIR, n))) return res.status(404).json({ ok: false, error: `Bundle ${n} not found.` });
    try {
      fs.unlinkSync(path.join(BUNDLE_DIR, n)); removeBundleMeta(n);
      await audit(req, 'backup.delete', { kind: 'backup', id: n, label: n, summary: 'Bundle deleted' });
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ ok: false, error: 'Could not delete the bundle.' }); }
  });

  router.post('/backup-restore/bundle/upload', requireAdmin, (req, res) => {
    bundleUpload.single('bundle')(req, res, (err) => {
      if (err) return res.redirect('/backup-restore?error=' + encodeURIComponent(err.code === 'LIMIT_FILE_SIZE' ? 'That bundle is larger than the 256 MB upload limit — copy it into the console\'s backups/ folder instead.' : (err.message || 'Upload failed')));
      if (!req.file || !req.file.buffer) return res.redirect('/backup-restore?error=' + encodeURIComponent('No file received.'));
      let parsed;
      try { parsed = JSON.parse(req.file.buffer.toString('utf8')); }
      catch (e) { return res.redirect('/backup-restore?error=' + encodeURIComponent('Not valid JSON: ' + e.message)); }
      const s = summarizeBundle(parsed);
      if (!s.valid) return res.redirect('/backup-restore?error=' + encodeURIComponent('Not a usable bundle: ' + s.problems.join('; ')));
      const base = path.basename(req.file.originalname).replace(/[^A-Za-z0-9._-]/g, '_');
      const upSha = sha256(req.file.buffer);
      const same = listBundles().find(x => { try { return fs.statSync(path.join(BUNDLE_DIR, x.name)).size === req.file.buffer.length && sha256(fs.readFileSync(path.join(BUNDLE_DIR, x.name))) === upSha; } catch (e) { return false; } });
      if (same) return res.redirect('/backup-restore?ok=bundleup&warn=' + encodeURIComponent(`That file is already here as ${same.name} — nothing new was stored.`));
      let name = safeBundleName(base) || `web_app_bundle_${bundleStamp()}.json`;
      // Never overwrite a bundle already here (same name, other content).
      if (fs.existsSync(path.join(BUNDLE_DIR, name))) name = uniqueBundleName(name.replace(/\.json$/i, ''));
      try {
        writeBundleFile(name, req.file.buffer);
        const st = fs.statSync(path.join(BUNDLE_DIR, name));
        writeBundleMeta(name, s, st);
        const v = verifyBundle(parsed);
        audit(req, 'backup.upload', { kind: 'backup', id: name, label: name,
          summary: `Bundle uploaded (${fmtBytes(st.size)}, v${s.version}) — verify ${v.valid ? 'passed' : 'FAILED'}: ${v.checks.filter(c => !c.ok).map(c => c.name).join(', ') || 'all checks ok'}` })
          .finally(() => res.redirect('/backup-restore?ok=bundleup' + (v.valid ? '' : '&warn=' + encodeURIComponent('Uploaded, but Verify reports: ' + v.checks.filter(c => !c.ok && c.level === 'error').map(c => c.name + ' — ' + c.detail).join('; ')))));
      } catch (e) {
        res.redirect('/backup-restore?error=' + encodeURIComponent('Could not save the bundle: ' + (e.message || e)));
      }
    });
  });

  // The full checklist (verifyBundle). A bundle that doesn't parse gets a
  // one-line checklist too, so the page always shows the same shape.
  router.post('/backup-restore/bundle/verify', requireAdmin, express.json(), async (req, res) => {
    const name = safeBundleName(req.body && req.body.name);
    if (!name) return res.status(400).json({ ok: false, error: 'Bad bundle name.' });
    let r;
    try {
      const { bundle } = readBundleFile(name);
      r = verifyBundle(bundle);
      try {
        const sc = await schemaCheck(bundle.database && bundle.database.tables);
        r.checks.push({ name: 'Fits this database', ok: !sc.errors.length && !sc.warnings.length, level: sc.errors.length ? 'error' : 'warn',
          detail: [...sc.errors, ...sc.warnings].join('; ') || 'every table and column matches' });
        if (sc.errors.length) r.valid = false;
      } catch (e) {
        r.checks.push({ name: 'Fits this database', ok: false, level: 'warn', detail: 'could not read the live schema: ' + (e.message || e) });
      }
    } catch (err) {
      if (!fs.existsSync(path.join(BUNDLE_DIR, name))) return res.status(404).json({ ok: false, error: `Bundle ${name} not found.` });
      r = { valid: false, checks: [{ name: 'JSON parses', ok: false, level: 'error', detail: err.message || String(err) }], summary: null };
    }
    const failed = r.checks.filter(c => !c.ok);
    await audit(req, 'backup.verify', { kind: 'backup', id: name, label: name,
      summary: `Verify ${r.valid ? 'passed' : 'FAILED'} (${r.checks.length} checks${failed.length ? `; ${failed.length} not ok: ` + failed.map(c => c.name).join(', ') : ''})` });
    res.json({ ok: true, valid: r.valid, checks: r.checks, summary: r.summary });
  });

  router.post('/backup-restore/bundle/test-access', requireAdmin, express.json(), async (req, res) => {
    try { res.json(await testAccess()); }
    catch (err) { res.status(500).json({ ok: false, checks: [], error: err.message || String(err) }); }
  });

  router.post('/backup-restore/bundle/restore', requireAdmin, express.json(), async (req, res) => {
    const confirm = String((req.body && req.body.confirm) || '').trim();
    if (confirm !== RESTORE_CONFIRM) {
      return res.status(400).json({ ok: false, error: `Type ${RESTORE_CONFIRM} to confirm.` });
    }
    const name = safeBundleName(req.body && req.body.name);
    if (!name) return res.status(400).json({ ok: false, error: 'Bad bundle name.' });
    const restoreCommands = !!(req.body && req.body.restoreCommands === true);
    // pruneFiles defaults ON (a full restore puts the files back exactly as
    // they were); the older pruneUploads flag is still understood.
    const pruneFiles = !(req.body && (req.body.pruneFiles === false || req.body.pruneUploads === false));
    const keepHostSettings = !(req.body && req.body.keepHostSettings === false);
    const restoreTemplates = !(req.body && req.body.restoreTemplates === false);
    const keepMaintenanceOn = !!(req.body && req.body.keepMaintenanceOn === true);
    // Claim the one-operation slot BEFORE the awaits below (the access test
    // takes seconds) — otherwise two restores could both pass the check.
    if (!startOp('restore', name)) return busyError(res);
    let loaded;
    try {
      mark('Bundle', 'in_progress', 'reading and verifying (row counts, file hashes)');
      loaded = readBundleFile(name);
      const v = verifyBundle(loaded.bundle);
      if (!v.valid) throw new Error('Bundle failed verification: ' + v.checks.filter(c => !c.ok && c.level === 'error').map(c => `${c.name} — ${c.detail}`).join('; '));
      const warns = v.checks.filter(c => !c.ok && c.level !== 'error');
      // Fit against THIS database before anything is written.
      const sc = await schemaCheck(loaded.bundle.database && loaded.bundle.database.tables);
      if (sc.errors.length) throw new Error('The backup does not fit this database — nothing was changed: ' + sc.errors.join('; '));
      mark('Bundle', (warns.length || sc.warnings.length) ? 'warn' : 'ok', `${name} verified${warns.length ? ' — ' + warns.map(c => c.name).join(', ') : ''}${sc.warnings.length ? ' — ' + sc.warnings.join('; ') : ''}`);
    } catch (err) {
      finishOp(false, err.message || String(err));
      await audit(req, 'backup.restore', { kind: 'backup', id: name, label: name, summary: `Restore refused: ${err.message || err}` });
      return res.status(400).json({ ok: false, error: err.message || String(err) });
    }
    // Enforced here too, not just in the browser: the whole point is never
    // starting a restore the transport can't finish.
    mark('Access check', 'in_progress', 'testing read / write / command access');
    let access;
    try { access = await testAccess(); }
    catch (e) { access = { ok: false, checks: [{ name: 'Access test', ok: false, detail: e.message || String(e) }] }; }
    if (!access.ok) {
      const failed = access.checks.filter(c => !c.ok).map(c => c.name).join(', ');
      finishOp(false, 'Access check failed: ' + failed);
      return res.status(400).json({ ok: false, error: 'Access check failed: ' + failed, checks: access.checks });
    }
    mark('Access check', 'ok', 'read, write and command access OK');
    try {
      const r = await restoreBundle(loaded.bundle, mark, { restoreCommands, pruneFiles, keepHostSettings, restoreTemplates, keepMaintenanceOn });
      finishOp(true);
      console.log(`[backup] bundle restored: ${loaded.name}`);
      // Written AFTER the database step, so it lands in the restored
      // admin_audit (the dump's own rows came back with it).
      await audit(req, 'backup.restore', { kind: 'backup', id: loaded.name, label: loaded.name,
        summary: `Restored: ${r.restored.join(', ')}${r.skipped.length ? '. Skipped: ' + r.skipped.join(', ') : ''}` });
      restoreLog(req, { kind: 'full restore', bundle: loaded.name, ok: true, restored: r.restored });
      res.json({ ok: true, steps: r.steps, restored: r.restored, skipped: r.skipped, maintenanceEnabled: r.maintenanceEnabled });
    } catch (err) {
      finishOp(false, err.message || String(err));
      console.error('[backup] bundle restore failed:', err);
      await audit(req, 'backup.restore', { kind: 'backup', id: loaded.name, label: loaded.name, summary: `Restore FAILED: ${err.message || err}` });
      const steps = (opStatus && opStatus.steps) || [];
      res.status(500).json({ ok: false, error: err.message || String(err), steps: steps.map(st => ({ step: st.step, ok: st.state === 'ok' || st.state === 'warn', detail: st.detail })),
        dbCommitted: steps.some(st => st.step === 'Database' && (st.state === 'ok' || st.state === 'warn')) });
    }
  });

  return router;
};
