// routes/webAppWebsite.js — edit the Web App's public website copy, stored as
// 5 HTML fragment files under <appPath>/HTML/ on the web app host, plus the
// images they reference (HTML/images/, served by the web app at
// /content/images), and Maintenance Mode.
//
//   GET  /web-app-website                → one collapsible editor per fragment
//   POST /web-app-website/:section       → save one fragment (JSON, live)
//   POST /web-app-website/images/upload  → upload an image (multipart)
//   POST /web-app-website/images/delete  → delete an image
//   POST /web-app-website/maintenance    → run maintenanceCommand (JSON)
//
// Files are reached through helpers/webAppAccess.js (local / SSH / EC2-SSM,
// configured under Settings → Web App). The web app reads these files on
// every /api/content request, so edits take effect on the next page load —
// NO restart needed. The fragments use {{tokens}} ({{appTitle}}, {{orgName}},
// {{year}}, …) the web app fills at serve time; leave those in place.
//
// v2 section set (contract with mmoa_web_app — keep both sides identical):
// hero, about, help, partner, footer. Events, raffles, the board and the
// Need Help directory are database-driven (their own console pages), not
// fragments. The v1 per-section "window" styling (HTML/windows.json) was
// dropped on both sides with the v2 dark site design.

const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { page, flash } = require('../views/layout');
const { escapeHtml } = require('../views/escapeHtml');
const { requireAdmin } = require('../middleware/auth');
const webAppAccess = require('../helpers/webAppAccess');
const waConfig = require('../helpers/webAppConfig');
const uploads = require('../helpers/webAppUploads');
// This router has no db of its own: the audit trail goes through the
// recorder routes/audit.js captures when app.js mounts it.
const { record: audit } = require('./audit');

// Image uploads are buffered in memory then written to the Web App via
// the transport (so the same code path works for local / SSH / EC2-SSM).
// The mimetype filter is only a first pass — the real check is sniffImage()
// on the bytes, after multer.
const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 1 },
  fileFilter(req, file, cb) {
    const ok = /^image\/(png|jpe?g|gif|webp|svg\+xml)$/.test(file.mimetype);
    if (!ok) return cb(new Error('Only PNG, JPEG, GIF, WebP, or SVG images are allowed'));
    cb(null, true);
  }
}).single('image');

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg)$/i;

// What the bytes really are, by magic bytes (JPEG / PNG / WebP via
// webAppUploads.sniffExt, GIF87a / GIF89a, and SVG — text that opens with an
// <svg> element, optionally after a BOM / XML declaration / comments).
// Returns { kind, exts, mimes } or null. SVG is kept because the site's
// fragments may embed vector art; it is admin-only (this page needs a
// console login) and the web app serves it as a static file — an SVG can
// carry script, so only operators ever upload here.
const SNIFF = {
  jpg: { exts: ['jpg', 'jpeg'], mimes: ['image/jpeg', 'image/jpg'] },
  png: { exts: ['png'], mimes: ['image/png'] },
  webp: { exts: ['webp'], mimes: ['image/webp'] },
  gif: { exts: ['gif'], mimes: ['image/gif'] },
  svg: { exts: ['svg'], mimes: ['image/svg+xml'] }
};
function sniffImage(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 6) return null;
  const ext = uploads.sniffExt(buf);
  if (ext) return Object.assign({ kind: ext }, SNIFF[ext]);
  const head6 = buf.subarray(0, 6).toString('latin1');
  if (head6 === 'GIF87a' || head6 === 'GIF89a') return Object.assign({ kind: 'gif' }, SNIFF.gif);
  const text = buf.subarray(0, 4096).toString('utf8').replace(/^\uFEFF/, '').replace(/<!--[\s\S]*?-->/g, '').trim();
  if (/^(<\?xml[^>]*\?>\s*)?(<!DOCTYPE[^>]*>\s*)?<svg[\s>]/i.test(text)) return Object.assign({ kind: 'svg' }, SNIFF.svg);
  return null;
}

// Single-quote a string for POSIX sh (for the ls / rm / mkdir calls below).
function shq(s) { return `'` + String(s).replace(/'/g, `'\\''`) + `'`; }

// appPath is operator-configured (trusted); still constrain uploaded names to
// a safe basename so an upload can't escape HTML/images/.
function sanitizeImageName(original) {
  const base = path.basename(String(original || ''));
  return base.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '');
}

function imagesDirOf(accessor) {
  return waConfig.joinPath(accessor.appPath, 'HTML/images');
}

// Fixed list of editable fragments (matches the mmoa_web_app HTML/ contract).
const SECTIONS = [
  { key: 'hero',    label: 'Home hero',          desc: 'Home page banner over the car-show photo — headline, mission line, calls to action.' },
  { key: 'about',   label: 'About — our story',  desc: 'Story intro on the About page (values, board, impact list and photos are built in / database-driven).' },
  { key: 'help',    label: 'How you can help',   desc: 'The "How you can help" list (About page and the Home partner band).' },
  { key: 'partner', label: 'Partner With Us',    desc: 'Body of the Partner With Us page (the nonprofit sign-up button is added below it).' },
  { key: 'footer',  label: 'Footer',             desc: 'Site-wide footer text. The emergency 911 / 988 / 211 box is built in.' }
];

const TEXTAREA_CLS = 'block w-full font-mono text-xs rounded-lg border border-slate-200 bg-white px-3 py-2 text-slate-900 shadow-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100';

function pageHeader(title, subtitle) {
  return `<header class="mb-6">
    <h1 class="text-2xl font-bold text-slate-900 dark:text-slate-100">${escapeHtml(title)}</h1>
    ${subtitle ? `<p class="mt-1 text-sm text-slate-500 dark:text-slate-400">${escapeHtml(subtitle)}</p>` : ''}
  </header>`;
}

// One row in the images list: filename, a copyable <img> snippet, delete.
function imageRow(name) {
  const snippet = '<img src="/content/images/' + name + '" alt="">';
  return `
    <div class="flex items-center gap-3 rounded-lg border border-slate-200 dark:border-slate-700 p-2"
         x-data="{ copied: false, copy() { navigator.clipboard.writeText(this.$refs.snip.value).then(() => { this.copied = true; setTimeout(() => this.copied = false, 1500); }).catch(() => {}); } }">
      <div class="min-w-0 flex-1">
        <div class="font-mono text-xs text-slate-700 dark:text-slate-200 truncate">${escapeHtml(name)}</div>
        <input x-ref="snip" readonly value="${escapeHtml(snippet)}"
               class="mt-1 w-full font-mono text-xs rounded border border-slate-200 bg-slate-50 px-2 py-1 text-slate-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300"
               x-on:focus="$event.target.select()">
      </div>
      <button type="button" class="btn-secondary text-xs shrink-0" x-on:click="copy()">
        <span x-show="!copied">Copy tag</span><span x-show="copied" x-cloak>Copied ✓</span>
      </button>
      <form method="POST" action="/web-app-website/images/delete" class="m-0 shrink-0"
            x-on:submit.prevent="window.uiConfirmSubmit($event.target, 'Delete this image?', { title: 'Delete image', confirmLabel: 'Delete' })">
        <input type="hidden" name="filename" value="${escapeHtml(name)}">
        <button type="submit" class="btn-danger text-xs">Delete</button>
      </form>
    </div>`;
}

// The Website card: the public address of the Web App (publicBaseUrl in
// its config.json) with a button that opens it in a new browser window.
function websiteLinkCard(publicBaseUrl) {
  const url = String(publicBaseUrl || '').trim();
  const body = url
    ? `<div class="mt-3 flex flex-wrap items-center gap-3">
        <a href="${escapeHtml(url)}" target="_blank" rel="noopener" class="font-mono text-sm font-semibold text-emerald-700 dark:text-emerald-300 hover:underline break-all">${escapeHtml(url)}</a>
        <a href="${escapeHtml(url)}" target="_blank" rel="noopener" class="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-emerald-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500">Open website <span aria-hidden="true">↗</span></a>
      </div>`
    : `<div class="mt-3 flash-error text-sm">No public address is configured yet. Set <code class="font-mono">publicBaseUrl</code> under <a class="underline" href="/web-app-settings/general">Web App Settings → General</a>.</div>`;
  return `<div class="card surface-target card-pad border-2 border-emerald-500 dark:border-emerald-600">
    <h2 class="text-base font-semibold text-emerald-800 dark:text-emerald-200">Website</h2>
    <p class="mt-0.5 text-xs text-slate-500 dark:text-slate-400">The live site as visitors see it. Opens in a new browser window.</p>
    ${body}
  </div>`;
}

// The Maintenance Mode card: Title + Message inputs and Enable / Disable /
// Status buttons that run the remote `maintenanceCommand` (configured under
// Web App Settings → General). Output is shown in a result window that
// mirrors the Start/Stop Web App window on the settings page.
function maintenanceCard(maintenanceCommand) {
  const configured = !!(maintenanceCommand && String(maintenanceCommand).trim());
  const btn = (action, label, color) => `<button type="button" class="${color} disabled:opacity-50 disabled:cursor-not-allowed"
        :disabled="!!busy || ${configured ? 'false' : 'true'}"
        ${configured ? '' : 'title="No Maintenance Command configured — set it under Web App Settings → General"'}
        x-on:click="run('${action}')">
      <span x-show="busy !== '${action}'">${escapeHtml(label)}</span>
      <span x-show="busy === '${action}'" x-cloak>Working…</span>
    </button>`;

  return `<div class="card surface-target card-pad" x-data="{
      title: '', message: '', busy: '', running: false, lastAction: '', result: null,
      async run(action) {
        if (this.busy) return;
        if (!(await window.uiConfirm('Run the maintenance ' + action + ' command on the Web App?', { title: 'Maintenance Mode', confirmLabel: 'Run' }))) return;
        this.busy = action; this.lastAction = action; this.result = null; this.running = true;
        try {
          const r = await fetch('/web-app-website/maintenance', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify({ action, title: this.title, message: this.message })
          });
          this.result = await r.json().catch(() => ({ ok: false, error: 'Bad response from server' }));
        } catch (e) {
          this.result = { ok: false, error: 'Network error: ' + (e.message || e) };
        } finally { this.busy = ''; this.running = false; }
      }
    }">
    <h2 class="text-base font-semibold text-slate-900 dark:text-slate-100">Maintenance Mode</h2>
    <p class="mt-0.5 text-xs text-slate-500 dark:text-slate-400">Runs the Maintenance Command configured under <a href="/web-app-settings/general" class="text-brand-600 hover:underline">Web App Settings → General</a>.</p>
    ${configured ? '' : `<div class="mt-3 flash-error text-sm">No Maintenance Command is configured yet. Set it under <a class="underline" href="/web-app-settings/general">Web App Settings → General</a> to enable these actions.</div>`}
    <div class="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-3">
      <div><label class="label">Title</label>
        <input class="input" type="text" x-model="title" autocomplete="off" placeholder="e.g. Scheduled maintenance"></div>
      <div><label class="label">Message</label>
        <input class="input" type="text" x-model="message" autocomplete="off" placeholder="e.g. We'll be back shortly"></div>
    </div>
    <div class="mt-4 flex items-center justify-end gap-2">
      ${btn('enable', 'Enable', 'btn-primary')}
      ${btn('disable', 'Disable', 'btn-danger')}
      ${btn('status', 'Status', 'btn-secondary')}
    </div>
    <div x-show="running" x-cloak class="mt-4 rounded-lg border border-brand-300 bg-brand-50 dark:bg-brand-900/40 dark:border-brand-800 p-3">
      <div class="text-sm font-semibold text-brand-800 dark:text-brand-200">⏳ Running the <span x-text="lastAction"></span> command on the Web App…</div>
    </div>
    <div x-show="!running && result" x-cloak class="mt-4 rounded-lg border p-3"
         :class="result && result.ok ? 'border-emerald-300 bg-emerald-50 dark:bg-emerald-950/40 dark:border-emerald-900' : 'border-red-300 bg-red-50 dark:bg-red-950/40 dark:border-red-900'">
      <div class="text-sm font-semibold"
           :class="result && result.ok ? 'text-emerald-800 dark:text-emerald-200' : 'text-red-800 dark:text-red-200'"
           x-text="result ? ((result.ok ? 'Command succeeded' : 'Command failed') + (result.code != null ? ' (exit ' + result.code + ')' : '')) : ''"></div>
      <p x-show="result && result.error" class="mt-1 text-sm text-red-700 dark:text-red-300 break-words whitespace-pre-wrap" x-text="result && result.error"></p>
      <p x-show="result && result.timedOut" class="mt-1 text-xs text-amber-600 dark:text-amber-400">Timed out waiting for the command to finish; it may still be running on the host.</p>
      <template x-if="result && result.stdout">
        <div class="mt-2"><div class="text-xs text-slate-500 dark:text-slate-400">stdout</div>
          <pre class="font-mono text-xs whitespace-pre-wrap break-all bg-white/60 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded p-2 max-h-40 overflow-auto" x-text="result.stdout"></pre></div>
      </template>
      <template x-if="result && result.stderr">
        <div class="mt-2"><div class="text-xs text-slate-500 dark:text-slate-400">stderr</div>
          <pre class="font-mono text-xs whitespace-pre-wrap break-all bg-white/60 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded p-2 max-h-40 overflow-auto" x-text="result.stderr"></pre></div>
      </template>
    </div>
  </div>`;
}

// The Images card: upload form + list of existing images.
function imagesCard(images, query) {
  let notice = '';
  if (query.imgok) notice += `<div class="flash-ok">Uploaded <code class="font-mono">${escapeHtml(query.imgok)}</code>. Reference it as <code class="font-mono">/content/images/${escapeHtml(query.imgok)}</code>.</div>`;
  if (query.imgdel) notice += `<div class="flash-ok">Deleted <code class="font-mono">${escapeHtml(query.imgdel)}</code>.</div>`;

  const list = images.length
    ? `<div class="mt-4 space-y-2">${images.map(n => imageRow(n)).join('')}</div>`
    : `<p class="mt-4 text-sm text-slate-400 italic">No images uploaded yet.</p>`;

  return `<div class="card surface-target card-pad">
    <h2 class="text-base font-semibold text-slate-900 dark:text-slate-100">Images</h2>
    <p class="mt-0.5 text-xs text-slate-500 dark:text-slate-400">Upload to <code class="font-mono">HTML/images/</code> and reference as <code class="font-mono">/content/images/&lt;file&gt;</code> in a section. Re-uploading the same filename overwrites it. Event, raffle, board and nonprofit photos are uploaded on their own pages, not here.</p>
    ${notice ? `<div class="mt-3 space-y-2">${notice}</div>` : ''}
    <form method="POST" action="/web-app-website/images/upload" enctype="multipart/form-data" class="mt-4 flex items-center gap-3 flex-wrap">
      <input type="file" name="image" required accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml"
             class="block text-sm text-slate-600 dark:text-slate-300 file:mr-3 file:rounded-lg file:border-0 file:bg-brand-600 file:px-4 file:py-2 file:text-sm file:font-semibold file:text-white hover:file:bg-brand-700">
      <button type="submit" class="btn-primary">Upload image</button>
    </form>
    ${list}
  </div>`;
}

// One collapsible card per website section: the HTML/<key>.html fragment in
// a textarea, with Preview / Revert / Save. Self-contained Alpine component;
// saves via fetch so an unsaved card elsewhere on the page is never lost.
function sectionCard(section, content, contentErr, openByDefault) {
  const contentInit = escapeHtml(JSON.stringify(content || ''));
  const contentLoadBanner = contentErr
    ? `<div class="flash-error text-sm">Could not load this file: ${escapeHtml(contentErr)}. Saving will attempt to (over)write it.</div>`
    : '';
  return `
    <div class="card surface-target overflow-hidden"
         data-content-init="${contentInit}"
         x-data="{
           open: ${openByDefault ? 'true' : 'false'},
           content: '', contentOriginal: '', savingContent: false, savedContent: false, errorContent: '',
           init() { this.content = JSON.parse(this.$el.dataset.contentInit); this.contentOriginal = this.content; },
           get dirty() { return this.content !== this.contentOriginal; },
           revertContent() { this.content = this.contentOriginal; },
           async saveContent() {
             if (this.savingContent) return;
             this.savingContent = true; this.savedContent = false; this.errorContent = '';
             try {
               const r = await fetch('/web-app-website/${section.key}', {
                 method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
                 body: JSON.stringify({ html: this.content })
               });
               const data = await r.json().catch(() => ({ ok: false, error: 'Bad response from server' }));
               if (!r.ok || !data.ok) { this.errorContent = data.error || 'Save failed'; }
               else { this.contentOriginal = this.content; this.savedContent = true; }
             } catch (e) { this.errorContent = 'Network error: ' + (e.message || e); }
             finally { this.savingContent = false; }
           }
         }">
      <button type="button" class="w-full flex items-center justify-between gap-3 px-5 py-4 text-left hover:bg-slate-50 dark:hover:bg-slate-800/40 transition-colors"
              x-on:click="open = !open" :aria-expanded="open">
        <div class="min-w-0">
          <div class="font-semibold text-slate-900 dark:text-slate-100">
            ${escapeHtml(section.label)}
            <span class="ml-2 text-xs font-mono text-slate-400">HTML/${escapeHtml(section.key)}.html</span>
          </div>
          <div class="text-xs text-slate-500 dark:text-slate-400">${escapeHtml(section.desc)}</div>
        </div>
        <div class="flex items-center gap-2 shrink-0">
          <span x-show="dirty" x-cloak class="pill-pending">unsaved</span>
          <span class="text-slate-400 text-xs transition-transform duration-150" :class="open ? 'rotate-90' : ''" aria-hidden="true">▶</span>
        </div>
      </button>

      <div x-show="open" x-transition class="border-t border-slate-200 dark:border-slate-800">
        <div class="px-5 py-4 space-y-3">
          ${contentLoadBanner}
          <p x-show="errorContent" x-cloak class="flash-error text-sm" x-text="errorContent"></p>
          <textarea x-model="content" rows="18" spellcheck="false" autocomplete="off" class="${TEXTAREA_CLS}" aria-label="${escapeHtml(section.label)} HTML"></textarea>
          <div class="flex items-center justify-between gap-3">
            <span class="text-xs text-slate-400"><span x-text="content.length"></span> characters</span>
            <div class="flex items-center gap-2">
              <span x-show="savedContent && !dirty" x-cloak class="text-xs text-emerald-600 dark:text-emerald-400">Saved ✓ — live on next page load.</span>
              <button type="button" class="btn-secondary text-sm" x-on:click="waPreview({ content, label: '${section.label}', key: '${section.key}' })">Preview</button>
              <button type="button" class="btn-secondary text-sm disabled:opacity-50 disabled:cursor-not-allowed" :disabled="!dirty || savingContent" x-on:click="revertContent()">Revert</button>
              <button type="button" class="btn-primary text-sm disabled:opacity-50 disabled:cursor-not-allowed" :disabled="!dirty || savingContent" x-on:click="saveContent()">
                <span x-show="!savingContent">Save content</span><span x-show="savingContent">Saving…</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>`;
}

// Exposed so other routes (e.g. Backup/Restore) can reuse the canonical
// list of editable website fragments.
module.exports = makeRouter;
module.exports.SECTIONS = SECTIONS;

function makeRouter(appConfig) {
  const router = express.Router();

  router.get('/web-app-website', requireAdmin, async (req, res) => {
    const user = req.session.user;

    let notConfigured = false;
    let accessDesc = '';
    let readErr = null;
    let cards = '';
    let publicBaseUrl = '';
    let maintenanceCommand = '';
    let images = [];

    if (!webAppAccess.isConfigured(appConfig)) {
      notConfigured = true;
    } else {
      const accessor = webAppAccess.createAccessorFromConfig(appConfig);
      accessDesc = accessor.describe();
      // Everything the page needs — 5 fragments, the remote config.json and
      // the images listing — in ONE batched transport round-trip (a single
      // SSM command on EC2, one SSH connection on SSH).
      const fragPaths = SECTIONS.map(s => waConfig.joinPath(accessor.appPath, 'HTML/' + s.key + '.html'));
      const cfgPath = waConfig.joinPath(accessor.appPath, 'config.json');
      const imgDir = imagesDirOf(accessor);
      // A transport failure (SSH refused, SSM credentials, …) renders the
      // page with the error on every card instead of a bare 500.
      let bundle;
      try {
        bundle = await accessor.readBundle(
          { files: [...fragPaths, cfgPath], dirs: [imgDir] },
          { encoding: 'utf8' }
        );
      } catch (e) {
        readErr = e.message || String(e);
        bundle = { files: {}, dirs: {} };
        for (const p of fragPaths) bundle.files[p] = { content: null, missing: false, err: readErr };
      }

      const results = SECTIONS.map((s, i) => {
        const f = bundle.files[fragPaths[i]] || { content: null, missing: true, err: null };
        return {
          s,
          content: f.content || '',
          err: f.err || (f.missing ? 'File not found on the Web App host' : null)
        };
      });

      // publicBaseUrl + maintenanceCommand out of the bundled config.json
      // (best-effort; blanks when unreadable).
      const cfgEntry = bundle.files[cfgPath] || {};
      try {
        const cfgJson = cfgEntry.content ? JSON.parse(cfgEntry.content) : null;
        publicBaseUrl = (cfgJson && typeof cfgJson.publicBaseUrl === 'string') ? cfgJson.publicBaseUrl : '';
        maintenanceCommand = (cfgJson && typeof cfgJson.maintenanceCommand === 'string') ? cfgJson.maintenanceCommand : '';
      } catch (e) { /* keep blanks */ }

      images = ((bundle.dirs[imgDir] || {}).names || []).filter(n => IMAGE_EXT.test(n)).sort();
      cards = results.map((r, i) => sectionCard(r.s, r.content, r.err, i === 0)).join('\n');
    }

    const previewBtn = (!notConfigured && publicBaseUrl)
      ? `<a href="${escapeHtml(publicBaseUrl)}" target="_blank" rel="noopener" class="btn-secondary inline-flex items-center gap-1.5">Preview live site <span aria-hidden="true">↗</span></a>`
      : `<span class="btn-secondary opacity-50 cursor-not-allowed inline-flex items-center gap-1.5" title="Set publicBaseUrl under Web App Settings → General to enable preview">Preview live site <span aria-hidden="true">↗</span></span>`;

    const header = `<header class="flex items-start justify-between gap-4 mb-6">
      <div>
        <h1 class="text-2xl font-bold text-slate-900 dark:text-slate-100">Web App Website</h1>
        <p class="mt-1 text-sm text-slate-500 dark:text-slate-400">Edit the website's fixed copy (home hero, our story, how to help, partner page, footer). Events, raffles, the board and the directory have their own pages.</p>
      </div>
      <div class="shrink-0">${previewBtn}</div>
    </header>`;

    const banner = notConfigured
      ? `<div class="flash-error mb-6"><strong class="font-semibold">Web App access is not configured.</strong> Set how this console reaches the Web App under <a class="underline" href="/settings/web-app">Settings → Web App</a> first.</div>`
      : readErr
      ? `<div class="flash-error mb-6"><strong class="font-semibold">Could not reach the Web App.</strong> ${escapeHtml(readErr)} (via ${escapeHtml(accessDesc)}). Check <a class="underline" href="/settings/web-app">Settings → Web App</a>.</div>`
      : `<div class="mb-6 text-xs text-slate-500 dark:text-slate-400">Editing <code class="font-mono">HTML/</code> fragments via ${escapeHtml(accessDesc)}. Saved changes go live on the next page load — no restart needed. Leave <code class="font-mono">{{tokens}}</code> in place; the Web App fills them at serve time.</div>`;

    let previewV = '';
    try { previewV = String(fs.statSync(path.join(__dirname, '..', 'public', 'js', 'wa-preview.js')).mtimeMs | 0); } catch (e) { /* ignore */ }

    const body = `
      <script defer src="/js/wa-preview.js?v=${previewV}"></script>
      ${header}
      ${flash('error', req.query.error)}
      ${banner}
      ${notConfigured ? '' : `<div class="max-w-4xl space-y-3">
        ${maintenanceCard(maintenanceCommand)}
        ${websiteLinkCard(publicBaseUrl)}
        ${imagesCard(images, req.query)}
        ${cards}
      </div>`}
    `;
    res.send(page({ title: 'Web App Website', body, appConfig, user, activeNav: 'web-app-website' }));
  });

  // ── Image upload (multipart) ──────────────────────────────────────────────
  router.post('/web-app-website/images/upload', requireAdmin, (req, res) => {
    imageUpload(req, res, async (err) => {
      if (err) return res.redirect('/web-app-website?error=' + encodeURIComponent(err.message || 'Upload failed'));
      if (!webAppAccess.isConfigured(appConfig)) {
        return res.redirect('/web-app-website?error=' + encodeURIComponent('Configure Web App access first (Settings → Web App).'));
      }
      if (!req.file) return res.redirect('/web-app-website?error=' + encodeURIComponent('No file received.'));
      const name = sanitizeImageName(req.file.originalname);
      if (!name) return res.redirect('/web-app-website?error=' + encodeURIComponent('Invalid filename.'));
      // The bytes decide. The browser's Content-Type and the filename's
      // extension must agree with them, so a renamed / mislabelled file (or
      // one that isn't an image at all) is refused rather than published.
      const sniffed = sniffImage(req.file.buffer);
      if (!sniffed) return res.redirect('/web-app-website?error=' + encodeURIComponent('That file is not a PNG, JPEG, GIF, WebP or SVG image.'));
      const extM = /\.([A-Za-z0-9]+)$/.exec(name);
      const ext = extM ? extM[1].toLowerCase() : '';
      if (!sniffed.exts.includes(ext) || !sniffed.mimes.includes(String(req.file.mimetype || '').toLowerCase())) {
        return res.redirect('/web-app-website?error=' + encodeURIComponent(`The file's contents are ${sniffed.kind.toUpperCase()}, but its name / type say otherwise — rename it with a .${sniffed.exts[0]} extension and try again.`));
      }
      try {
        const accessor = webAppAccess.createAccessorFromConfig(appConfig);
        // writeFileChunked: mkdir -p + atomic write, and on EC2 the file goes
        // over in ≤40 KB SSM pieces, so large photos work in every mode.
        await accessor.writeFileChunked(waConfig.joinPath(imagesDirOf(accessor), name), req.file.buffer);
        await audit(req, 'website.image', { kind: 'website', id: 'images', label: name, summary: `Image uploaded (${Math.ceil(req.file.buffer.length / 1024)} KB)` });
        res.redirect('/web-app-website?imgok=' + encodeURIComponent(name));
      } catch (e) {
        console.error('[web-app-website] image upload failed:', e);
        res.redirect('/web-app-website?error=' + encodeURIComponent('Upload failed: ' + (e.message || e)));
      }
    });
  });

  // ── Image delete ──────────────────────────────────────────────────────────
  router.post('/web-app-website/images/delete', requireAdmin, async (req, res) => {
    if (!webAppAccess.isConfigured(appConfig)) {
      return res.redirect('/web-app-website?error=' + encodeURIComponent('Configure Web App access first (Settings → Web App).'));
    }
    const name = path.basename(String((req.body && req.body.filename) || ''));
    if (!/^[A-Za-z0-9._-]+$/.test(name)) {
      return res.redirect('/web-app-website?error=' + encodeURIComponent('Invalid filename.'));
    }
    try {
      const accessor = webAppAccess.createAccessorFromConfig(appConfig);
      const dir = imagesDirOf(accessor);
      await accessor.runCommand(`rm -f -- ${shq(waConfig.joinPath(dir, name))}`, { timeoutMs: 20000 });
      await audit(req, 'website.image', { kind: 'website', id: 'images', label: name, summary: 'Image deleted' });
      res.redirect('/web-app-website?imgdel=' + encodeURIComponent(name));
    } catch (e) {
      console.error('[web-app-website] image delete failed:', e);
      res.redirect('/web-app-website?error=' + encodeURIComponent('Delete failed: ' + (e.message || e)));
    }
  });

  // ── Maintenance Mode (JSON) ───────────────────────────────────────────────
  // Runs the remote `maintenanceCommand` (Web App Settings → General)
  // with action-specific args appended, from the Web App install dir.
  // Registered before /:section so 'maintenance' isn't taken as a section key.
  router.post('/web-app-website/maintenance', requireAdmin, async (req, res) => {
    const action = (req.body && req.body.action) || '';
    if (!['enable', 'disable', 'status'].includes(action)) {
      return res.status(400).json({ ok: false, error: 'Invalid action' });
    }
    if (!webAppAccess.isConfigured(appConfig)) {
      return res.status(400).json({ ok: false, error: 'Web App access is not configured (Settings → Web App).' });
    }
    try {
      const accessor = webAppAccess.createAccessorFromConfig(appConfig);
      const { json } = await waConfig.readRemoteConfig(accessor);
      const base = (json && typeof json.maintenanceCommand === 'string' ? json.maintenanceCommand : '').trim();
      if (!base) {
        return res.status(400).json({ ok: false, error: 'No Maintenance Command is configured. Set it under Web App Settings → General.' });
      }

      // Build the command. Title/message are single-quoted for POSIX sh so an
      // operator-entered apostrophe or space can't break or inject into the
      // command line; the receiving program still sees them as one argv each.
      let cmd;
      if (action === 'enable') {
        const title = String((req.body && req.body.title) || '');
        const message = String((req.body && req.body.message) || '');
        cmd = `${base} --enable --title ${shq(title)} --message ${shq(message)}`;
      } else if (action === 'disable') {
        cmd = `${base} --disable`;
      } else {
        cmd = `${base} --status`;
      }

      const r = await accessor.runCommand(cmd, {
        cwd: accessor.appPath || undefined,
        timeoutMs: 120000,
        comment: `web app maintenance ${action}`
      });
      await audit(req, `maintenance.${action}`, { kind: 'website', id: 'maintenance', label: 'Maintenance mode',
        summary: `${action === 'enable' ? 'Enabled' : action === 'disable' ? 'Disabled' : 'Status checked'} — exit code ${r.code}${r.timedOut ? ' (timed out)' : ''}` });
      res.json({ ok: r.code === 0, code: r.code, stdout: r.stdout, stderr: r.stderr, timedOut: !!r.timedOut });
    } catch (err) {
      console.error('[web-app-website] maintenance failed:', err);
      res.status(500).json({ ok: false, error: err.message || 'Command failed' });
    }
  });

  router.post('/web-app-website/:section', requireAdmin, async (req, res) => {
    const section = SECTIONS.find(s => s.key === req.params.section);
    if (!section) return res.status(400).json({ ok: false, error: 'Unknown section' });
    if (!webAppAccess.isConfigured(appConfig)) {
      return res.status(400).json({ ok: false, error: 'Web App access is not configured (Settings → Web App).' });
    }
    const html = (req.body && typeof req.body.html === 'string') ? req.body.html : null;
    if (html === null) return res.status(400).json({ ok: false, error: 'Missing html content' });

    try {
      const accessor = webAppAccess.createAccessorFromConfig(appConfig);
      const p = waConfig.joinPath(accessor.appPath, 'HTML/' + section.key + '.html');
      await accessor.writeFile(p, html);
      await audit(req, 'website.section', { kind: 'website', id: section.key, label: section.label, summary: `Section saved (${html.length} characters)` });
      res.json({ ok: true });
    } catch (err) {
      console.error(`[web-app-website] save ${section.key} failed:`, err);
      res.status(500).json({ ok: false, error: err.message || 'Save failed' });
    }
  });

  return router;
};
