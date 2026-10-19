// routes/webAppWebsite.js — edit the Web App's public website, stored as
// 5 HTML fragment files under <appPath>/HTML/ on the web app host, plus the
// per-section window styling (HTML/windows.json), the images it references
// (HTML/images/, served by the web app at /content/images), and Maintenance
// Mode.
//
//   GET  /web-app-website                → one collapsible editor per fragment
//   POST /web-app-website/:section       → save one fragment (JSON, live)
//   POST /web-app-website/windows/:target→ save window styling (JSON, live)
//   POST /web-app-website/images/upload  → upload an image (multipart)
//   POST /web-app-website/images/delete  → delete an image
//   POST /web-app-website/maintenance    → run maintenanceCommand (JSON)
//
// Files are reached through helpers/webAppAccess.js (local / SSH / EC2-SSM,
// configured under Settings → Web App). The web app reads these files on
// every /api/content request, so edits take effect on the next page load —
// NO restart needed. The fragments use {{tokens}} ({{appTitle}}, {{orgName}},
// {{year}}, {{eventCount}}) the web app fills at serve time; leave those in
// place.

const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { page, flash } = require('../views/layout');
const { escapeHtml } = require('../views/escapeHtml');
const { requireAdmin } = require('../middleware/auth');
const webAppAccess = require('../helpers/webAppAccess');
const waConfig = require('../helpers/webAppConfig');

// Image uploads are buffered in memory then written to the Web App via
// the transport (so the same code path works for local / SSH / EC2-SSM).
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
  { key: 'hero',     label: 'Hero',            desc: 'Top banner — headline, mission line, primary call-to-action.' },
  { key: 'mission',  label: 'Mission',         desc: 'Who we are and the mission statement.' },
  { key: 'events',   label: 'Events heading',  desc: 'Heading only — the event cards below it are database-driven (manage them under Data Browser → events).' },
  { key: 'involved', label: 'Get involved',    desc: 'How to join / volunteer / sign up.' },
  { key: 'footer',   label: 'Footer',          desc: 'Site-wide footer.' }
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
    <p class="mt-0.5 text-xs text-slate-500 dark:text-slate-400">Upload to <code class="font-mono">HTML/images/</code> and reference as <code class="font-mono">/content/images/&lt;file&gt;</code> in a section. Re-uploading the same filename overwrites it. <span class="text-amber-600 dark:text-amber-400">On EC2 (SSM) access mode only small images transfer reliably — use SSH or Local for large files.</span></p>
    ${notice ? `<div class="mt-3 space-y-2">${notice}</div>` : ''}
    <form method="POST" action="/web-app-website/images/upload" enctype="multipart/form-data" class="mt-4 flex items-center gap-3 flex-wrap">
      <input type="file" name="image" required accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml"
             class="block text-sm text-slate-600 dark:text-slate-300 file:mr-3 file:rounded-lg file:border-0 file:bg-brand-600 file:px-4 file:py-2 file:text-sm file:font-semibold file:text-white hover:file:bg-brand-700">
      <button type="submit" class="btn-primary">Upload image</button>
    </form>
    ${list}
  </div>`;
}

// ── Window styling (HTML/windows.json) ─────────────────────────────────────
// windows.json controls each home-page section's "window" chrome (background,
// border, size, …) separately from its HTML content. Shape:
//   { _comment, defaults: {…}, windows: { hero:{…}, stats:{…}, … } }
// Each window inherits `defaults` and overrides only the keys it sets, so the
// per-window editor treats a blank field / "(inherit)" as "use the default"
// and omits that key on save. The Defaults card always writes a full set.
const WINDOWS_REL_PATH = 'HTML/windows.json';

// Sections that have a window. Matches the web app's landing page — every
// section is rendered inside a window.
const WINDOW_SECTIONS = [
  { key: 'hero',     label: 'Hero' },
  { key: 'mission',  label: 'Mission' },
  { key: 'events',   label: 'Events' },
  { key: 'involved', label: 'Get involved' },
  { key: 'footer',   label: 'Footer' }
];

const BORDER_STYLES = ['solid', 'dashed', 'dotted', 'none'];

// Field guide mirrors windows.json's own _comment block.
const WINDOW_FIELDS = [
  { key: 'background',  label: 'Background',           type: 'color',  hint: 'Any CSS color. Use "none" or "transparent" for no fill.' },
  { key: 'borderColor', label: 'Border color',         type: 'color',  hint: '"transparent" = invisible outline that still reserves space.' },
  { key: 'borderWidth', label: 'Border width (px)',    type: 'number', min: 0, max: 40 },
  { key: 'borderStyle', label: 'Border style',         type: 'select', options: BORDER_STYLES },
  { key: 'width',       label: 'Width (% of page)',    type: 'number', min: 1, max: 100 },
  { key: 'maxWidth',    label: 'Max width (px)',       type: 'number', min: 0, max: 4000 },
  { key: 'radius',      label: 'Corner radius (px)',   type: 'number', min: 0, max: 200 },
  { key: 'shadow',      label: 'Drop shadow',          type: 'bool' },
  { key: 'textColor',   label: 'Text color',           type: 'color',  hint: 'Blank = inherit (no override).' },
  { key: 'showTag',     label: 'Show corner tag',      type: 'bool' },
  { key: 'tag',         label: 'Tag label',            type: 'text' },
  { key: 'style',       label: 'Advanced CSS (style)', type: 'stylejson', hint: 'Raw CSS property → value, applied last. JSON object, e.g. {"opacity":"0.85"}.' }
];

// Seed for a freshly-created windows.json + source of fallback default values.
const WINDOWS_TEMPLATE = {
  _comment: [
    "Window (panel) styling for the marketing home page. Each home-page section",
    "is rendered inside a 'window'; this file controls that window's chrome —",
    "background, outline (border) and size — separately from its content (the",
    "matching <section>.html file). Edited by the remote admin tool, picked up",
    "live on the next page load (no rebuild needed).",
    "",
    "Each window inherits 'defaults' and overrides only what it sets. Per-window",
    "keys: hero, mission, events, involved, footer.",
    "",
    "Field guide:",
    "  background  any CSS color (#rrggbb, rgb()/rgba(), name). Use \"none\" or",
    "              \"transparent\" for no fill at all.",
    "  borderColor outline color. Use \"transparent\" for an invisible outline that",
    "              still reserves its space, or set borderWidth:0 to remove it.",
    "  borderWidth outline thickness in px (0 = no outline).",
    "  borderStyle solid | dashed | dotted | none.",
    "  width       window width as a percent of the page (1-100).",
    "  maxWidth    hard cap on width in px (the window never grows past this).",
    "  radius      corner roundness in px.",
    "  shadow      true/false — drop shadow under the window.",
    "  textColor   override text color (e.g. \"#ffffff\" on a dark window). null = inherit.",
    "  showTag     true/false — show the little corner label.",
    "  tag         the corner label text.",
    "  style       escape hatch: an object of raw CSS property -> value applied",
    "              last, so it can override any field above and reach properties",
    "              that have no named field. Use real CSS names, e.g.:",
    "              \"style\": { \"opacity\": \"0.85\", \"backdrop-filter\": \"blur(6px)\",",
    "              \"background\": \"linear-gradient(120deg,#11214d,#2c3e9e)\" }"
  ],
  defaults: {
    background: '#ffffff', borderColor: '#3b52d4', borderWidth: 2, borderStyle: 'dashed',
    width: 90, maxWidth: 1140, radius: 28, shadow: true, textColor: null, showTag: true, tag: ''
  },
  windows: {
    hero:     { background: '#dbe7ff', borderColor: '#4f6fd6', tag: 'Welcome' },
    mission:  { background: '#e3f4ea', borderColor: '#3f9d6a', tag: 'Our mission' },
    events:   { background: '#fff1d6', borderColor: '#d99a2b', tag: 'Events' },
    involved: { background: '#ece3ff', borderColor: '#8a64d6', tag: 'Get involved' },
    footer:   { background: '#1e2a4a', borderColor: '#3c4f86', textColor: '#ffffff', tag: 'Footer' }
  }
};

// Build the Alpine client state (all string-valued) for one entry. In window
// mode an absent key becomes '' (text/number/color) or '__inherit__'
// (select/bool) so the UI can represent "inherit".
function buildEntryState(entry, isDefaults) {
  entry = entry || {};
  const has = (k) => Object.prototype.hasOwnProperty.call(entry, k);
  const asStr = (v) => (v === null || v === undefined) ? '' : String(v);
  const st = {};
  for (const d of WINDOW_FIELDS) {
    if (d.type === 'bool') {
      if (isDefaults) st[d.key] = entry[d.key] ? 'true' : 'false';
      else st[d.key] = has(d.key) ? (entry[d.key] ? 'true' : 'false') : '__inherit__';
    } else if (d.type === 'select') {
      if (isDefaults) st[d.key] = asStr(entry[d.key]) || 'solid';
      else st[d.key] = has(d.key) ? asStr(entry[d.key]) : '__inherit__';
    } else if (d.type === 'stylejson') {
      const v = entry[d.key];
      st[d.key] = (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length) ? JSON.stringify(v) : '';
    } else { // color / text / number
      st[d.key] = isDefaults ? asStr(entry[d.key]) : (has(d.key) ? asStr(entry[d.key]) : '');
    }
  }
  return st;
}

// Render one field's input, bound to f.<key>. `defaults` (resolved) supplies
// placeholder/inherit hints in window mode.
function windowFieldHtml(d, isDefaults, defaults) {
  const m = 'f.' + d.key;
  const def = defaults ? defaults[d.key] : undefined;
  const defStr = (def === null || def === undefined) ? '' : String(def);
  const hint = d.hint ? `<p class="mt-1 text-xs text-slate-500 dark:text-slate-400">${escapeHtml(d.hint)}</p>` : '';
  const ph = (!isDefaults && defStr) ? `placeholder="inherit: ${escapeHtml(defStr)}"` : (!isDefaults ? 'placeholder="inherit"' : '');

  if (d.type === 'color') {
    return `<div>
      <label class="label">${escapeHtml(d.label)}</label>
      <div class="flex items-center gap-2">
        <input type="color" class="h-9 w-10 shrink-0 rounded border border-slate-200 dark:border-slate-700 bg-transparent p-0.5 cursor-pointer"
               :value="/^#[0-9a-fA-F]{6}$/.test(${m}) ? ${m} : '#ffffff'" x-on:input="${m} = $event.target.value">
        <input type="text" class="input flex-1" x-model="${m}" ${ph} autocomplete="off" spellcheck="false">
        <span class="h-7 w-7 shrink-0 rounded border border-slate-300 dark:border-slate-600" :style="'background:' + (${m} || 'transparent')"></span>
      </div>${hint}
    </div>`;
  }
  if (d.type === 'number') {
    return `<div><label class="label">${escapeHtml(d.label)}</label>
      <input type="number" class="input" x-model="${m}" ${d.min != null ? `min="${d.min}"` : ''} ${d.max != null ? `max="${d.max}"` : ''} ${ph}>${hint}</div>`;
  }
  if (d.type === 'select') {
    const opts = (!isDefaults ? `<option value="__inherit__">(inherit${defStr ? ': ' + escapeHtml(defStr) : ''})</option>` : '') +
      d.options.map(o => `<option value="${escapeHtml(o)}">${escapeHtml(o)}</option>`).join('');
    return `<div><label class="label">${escapeHtml(d.label)}</label>
      <select class="input" x-model="${m}">${opts}</select>${hint}</div>`;
  }
  if (d.type === 'bool') {
    const opts = (!isDefaults ? `<option value="__inherit__">(inherit: ${def ? 'On' : 'Off'})</option>` : '') +
      `<option value="true">On</option><option value="false">Off</option>`;
    return `<div><label class="label">${escapeHtml(d.label)}</label>
      <select class="input" x-model="${m}">${opts}</select>${hint}</div>`;
  }
  if (d.type === 'stylejson') {
    return `<div class="sm:col-span-2"><label class="label">${escapeHtml(d.label)}</label>
      <textarea x-model="${m}" rows="2" spellcheck="false" autocomplete="off" placeholder='{ "opacity": "0.85", "backdrop-filter": "blur(6px)" }'
        class="${TEXTAREA_CLS}"></textarea>${hint}</div>`;
  }
  // text (tag)
  return `<div><label class="label">${escapeHtml(d.label)}</label>
    <input type="text" class="input" x-model="${m}" ${ph} autocomplete="off">${hint}</div>`;
}

// One collapsible window-styling card (Defaults or a single window). Mirrors
// sectionCard: self-contained Alpine component, independent fetch-based save.
function windowCard(target, label, entry, resolvedDefaults, isDefaults, openByDefault) {
  const dataInit = escapeHtml(JSON.stringify(buildEntryState(entry, isDefaults)));
  const fieldsHtml = WINDOW_FIELDS.map(d => windowFieldHtml(d, isDefaults, resolvedDefaults)).join('\n');
  const sub = isDefaults
    ? 'Base styling applied to every window unless a window overrides it below.'
    : 'Overrides for this window. Blank / “(inherit)” means use the default.';
  return `
    <div class="card surface-target overflow-hidden" data-init="${dataInit}"
      x-data="{
        open: ${openByDefault ? 'true' : 'false'},
        f: {}, original: '', saving: false, saved: false, error: '',
        init() { this.f = JSON.parse(this.$el.dataset.init); this.original = JSON.stringify(this.f); },
        get dirty() { return JSON.stringify(this.f) !== this.original; },
        revert() { this.f = JSON.parse(this.original); },
        async save() {
          if (this.saving) return;
          this.saving = true; this.saved = false; this.error = '';
          try {
            const r = await fetch('/web-app-website/windows/${target}', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
              body: JSON.stringify({ fields: this.f })
            });
            const data = await r.json().catch(() => ({ ok: false, error: 'Bad response from server' }));
            if (!r.ok || !data.ok) { this.error = data.error || 'Save failed'; }
            else { this.original = JSON.stringify(this.f); this.saved = true; }
          } catch (e) { this.error = 'Network error: ' + (e.message || e); }
          finally { this.saving = false; }
        }
      }">
      <button type="button" class="w-full flex items-center justify-between gap-3 px-5 py-4 text-left hover:bg-slate-50 dark:hover:bg-slate-800/40 transition-colors"
              x-on:click="open = !open">
        <div class="min-w-0">
          <div class="font-semibold text-slate-900 dark:text-slate-100">${escapeHtml(label)}</div>
          <div class="text-xs text-slate-500 dark:text-slate-400">${escapeHtml(sub)}</div>
        </div>
        <div class="flex items-center gap-2 shrink-0">
          <span x-show="dirty" x-cloak class="pill-pending">unsaved</span>
          <span class="text-slate-400 text-xs transition-transform duration-150" :class="open ? 'rotate-90' : ''" aria-hidden="true">▶</span>
        </div>
      </button>
      <div x-show="open" x-transition class="border-t border-slate-200 dark:border-slate-800">
        <div class="px-5 py-4 space-y-3">
          <p x-show="error" x-cloak class="flash-error text-sm" x-text="error"></p>
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">${fieldsHtml}</div>
          <div class="flex items-center justify-end gap-2">
            <span x-show="saved && !dirty" x-cloak class="text-xs text-emerald-600 dark:text-emerald-400 mr-auto">Saved ✓ — live on next page load.</span>
            <button type="button" class="btn-secondary text-sm disabled:opacity-50 disabled:cursor-not-allowed" :disabled="!dirty || saving" x-on:click="revert()">Revert</button>
            <button type="button" class="btn-primary text-sm disabled:opacity-50 disabled:cursor-not-allowed" :disabled="!dirty || saving" x-on:click="save()">
              <span x-show="!saving">Save</span><span x-show="saving">Saving…</span>
            </button>
          </div>
        </div>
      </div>
    </div>`;
}

// One collapsible card per home-page section, merging BOTH editors:
//   1. Window styling (windows.json entry for this section)  — first
//   2. Content (HTML/<key>.html fragment)                    — second
// A single Alpine component tracks each half's dirty state and saves them
// independently (to different files/routes). Sections without a window
// (footer) render content-only; `hasWindow` gates the styling half.
function mergedCard(section, content, contentErr, windowEntry, resolvedDefaults, hasWindow, openByDefault) {
  const contentInit = escapeHtml(JSON.stringify(content || ''));
  const fInit = hasWindow ? escapeHtml(JSON.stringify(buildEntryState(windowEntry, false))) : '';
  const fieldsHtml = hasWindow ? WINDOW_FIELDS.map(d => windowFieldHtml(d, false, resolvedDefaults)).join('\n') : '';
  const contentLoadBanner = contentErr
    ? `<div class="flash-error text-sm">Could not load this file: ${escapeHtml(contentErr)}. Saving will attempt to (over)write it.</div>`
    : '';

  const stylePane = hasWindow ? `
        <div class="px-5 py-4 space-y-3">
          <div class="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Window styling
            <span class="ml-1 font-mono normal-case text-slate-400">windows.json → ${escapeHtml(section.key)}</span>
          </div>
          <p x-show="errorStyle" x-cloak class="flash-error text-sm" x-text="errorStyle"></p>
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">${fieldsHtml}</div>
          <div class="flex items-center justify-end gap-2">
            <span x-show="savedStyle && !styleDirty" x-cloak class="text-xs text-emerald-600 dark:text-emerald-400 mr-auto">Saved ✓ — live on next page load.</span>
            <button type="button" class="btn-secondary text-sm disabled:opacity-50 disabled:cursor-not-allowed" :disabled="!styleDirty || savingStyle" x-on:click="revertStyle()">Revert</button>
            <button type="button" class="btn-primary text-sm disabled:opacity-50 disabled:cursor-not-allowed" :disabled="!styleDirty || savingStyle" x-on:click="saveStyle()">
              <span x-show="!savingStyle">Save styling</span><span x-show="savingStyle">Saving…</span>
            </button>
          </div>
        </div>` : '';

  return `
    <div class="card surface-target overflow-hidden"
         ${hasWindow ? `data-f-init="${fInit}"` : ''}
         data-defaults="${escapeHtml(JSON.stringify(resolvedDefaults || {}))}"
         data-content-init="${contentInit}"
         x-data="{
           open: ${openByDefault ? 'true' : 'false'},
           hasWindow: ${hasWindow ? 'true' : 'false'},
           defaults: {},
           f: {}, fOriginal: '', savingStyle: false, savedStyle: false, errorStyle: '',
           content: '', contentOriginal: '', savingContent: false, savedContent: false, errorContent: '',
           init() {
             this.defaults = JSON.parse(this.$el.dataset.defaults || '{}');
             if (this.hasWindow) { this.f = JSON.parse(this.$el.dataset.fInit); this.fOriginal = JSON.stringify(this.f); }
             this.content = JSON.parse(this.$el.dataset.contentInit); this.contentOriginal = this.content;
           },
           get styleDirty() { return this.hasWindow && JSON.stringify(this.f) !== this.fOriginal; },
           get contentDirty() { return this.content !== this.contentOriginal; },
           get dirty() { return this.styleDirty || this.contentDirty; },
           revertStyle() { this.f = JSON.parse(this.fOriginal); },
           revertContent() { this.content = this.contentOriginal; },
           async saveStyle() {
             if (this.savingStyle) return;
             this.savingStyle = true; this.savedStyle = false; this.errorStyle = '';
             try {
               const r = await fetch('/web-app-website/windows/${section.key}', {
                 method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
                 body: JSON.stringify({ fields: this.f })
               });
               const data = await r.json().catch(() => ({ ok: false, error: 'Bad response from server' }));
               if (!r.ok || !data.ok) { this.errorStyle = data.error || 'Save failed'; }
               else { this.fOriginal = JSON.stringify(this.f); this.savedStyle = true; }
             } catch (e) { this.errorStyle = 'Network error: ' + (e.message || e); }
             finally { this.savingStyle = false; }
           },
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
              x-on:click="open = !open">
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

      <div x-show="open" x-transition class="border-t border-slate-200 dark:border-slate-800 divide-y divide-slate-200 dark:divide-slate-800">
        ${stylePane}
        <div class="px-5 py-4 space-y-3">
          <div class="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Content
            <span class="ml-1 font-mono normal-case text-slate-400">HTML/${escapeHtml(section.key)}.html</span>
          </div>
          ${contentLoadBanner}
          <p x-show="errorContent" x-cloak class="flash-error text-sm" x-text="errorContent"></p>
          <textarea x-model="content" rows="18" spellcheck="false" autocomplete="off" class="${TEXTAREA_CLS}"></textarea>
          <div class="flex items-center justify-between gap-3">
            <span class="text-xs text-slate-400"><span x-text="content.length"></span> characters</span>
            <div class="flex items-center gap-2">
              <span x-show="savedContent && !contentDirty" x-cloak class="text-xs text-emerald-600 dark:text-emerald-400">Saved ✓ — live on next page load.</span>
              <button type="button" class="btn-secondary text-sm" x-on:click="waPreview({ hasWindow, f, defaults, content, label: '${section.label}', key: '${section.key}' })">Preview</button>
              <button type="button" class="btn-secondary text-sm disabled:opacity-50 disabled:cursor-not-allowed" :disabled="!contentDirty || savingContent" x-on:click="revertContent()">Revert</button>
              <button type="button" class="btn-primary text-sm disabled:opacity-50 disabled:cursor-not-allowed" :disabled="!contentDirty || savingContent" x-on:click="saveContent()">
                <span x-show="!savingContent">Save content</span><span x-show="savingContent">Saving…</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>`;
}

// Coerce/validate the posted field map into the entry written to windows.json.
// In window mode, inherited fields are omitted; in defaults mode every field is
// written (with template fallbacks). Throws on invalid `style` JSON.
function coerceWindowEntry(fields, isDefaults) {
  fields = fields || {};
  const tdef = WINDOWS_TEMPLATE.defaults;
  const out = {};
  for (const d of WINDOW_FIELDS) {
    const raw = fields[d.key];
    if (d.type === 'bool') {
      if (!isDefaults && (raw === '__inherit__' || raw === undefined || raw === null || raw === '')) continue;
      out[d.key] = (raw === true || raw === 'true' || raw === 'on' || raw === '1');
    } else if (d.type === 'number') {
      const s = raw == null ? '' : String(raw).trim();
      if (s === '') { if (isDefaults && tdef[d.key] != null) out[d.key] = tdef[d.key]; continue; }
      let n = parseInt(s, 10);
      if (!Number.isFinite(n)) { if (isDefaults) out[d.key] = tdef[d.key]; continue; }
      if (d.min != null) n = Math.max(d.min, n);
      if (d.max != null) n = Math.min(d.max, n);
      out[d.key] = n;
    } else if (d.type === 'select') {
      const s = raw == null ? '' : String(raw);
      if (!isDefaults && (s === '__inherit__' || s === '')) continue;
      if (BORDER_STYLES.includes(s)) out[d.key] = s;
      else if (isDefaults) out[d.key] = tdef[d.key];
    } else if (d.type === 'stylejson') {
      const s = raw == null ? '' : String(raw).trim();
      if (s === '' || s === '{}') continue;
      let o;
      try { o = JSON.parse(s); }
      catch (e) { throw new Error('Advanced CSS (style) is not valid JSON.'); }
      if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error('Advanced CSS (style) must be a JSON object.');
      out[d.key] = o;
    } else { // color / text
      const s = raw == null ? '' : String(raw).trim();
      if (s === '') {
        // Blank "tag" → omit the key entirely (never write "tag": "") in both
        // defaults and per-window entries. Other blank text/color fields in
        // defaults fall back to the template value so a window always inherits
        // something sensible.
        if (isDefaults && d.key !== 'tag') {
          out[d.key] = (d.key === 'textColor') ? null : (tdef[d.key] != null ? tdef[d.key] : '');
        }
        continue;
      }
      out[d.key] = s;
    }
  }
  return out;
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
    let cards = '';
    let publicBaseUrl = '';
    let maintenanceCommand = '';
    let images = [];
    let windowsHtml = '';

    if (!webAppAccess.isConfigured(appConfig)) {
      notConfigured = true;
    } else {
      const accessor = webAppAccess.createAccessorFromConfig(appConfig);
      accessDesc = accessor.describe();
      // Everything the page needs — 5 fragments, the remote config.json,
      // windows.json, and the images listing — in ONE batched transport
      // round-trip (a single SSM command on EC2, one SSH connection on SSH).
      const fragPaths = SECTIONS.map(s => waConfig.joinPath(accessor.appPath, 'HTML/' + s.key + '.html'));
      const cfgPath = waConfig.joinPath(accessor.appPath, 'config.json');
      const winPath = waConfig.joinPath(accessor.appPath, WINDOWS_REL_PATH);
      const imgDir = imagesDirOf(accessor);
      const bundle = await accessor.readBundle(
        { files: [...fragPaths, cfgPath, winPath], dirs: [imgDir] },
        { encoding: 'utf8' }
      );

      const results = SECTIONS.map((s, i) => {
        const f = bundle.files[fragPaths[i]] || { content: null, missing: true, err: null };
        return {
          s,
          content: f.content || '',
          err: f.err || (f.missing ? 'File not found on the Web App host' : null)
        };
      });

      // publicBaseUrl + maintenanceCommand out of the bundled config.json
      // (best-effort; blanks when unreadable — mirrors readWebsiteConfigBits).
      const cfgEntry = bundle.files[cfgPath] || {};
      try {
        const cfgJson = cfgEntry.content ? JSON.parse(cfgEntry.content) : null;
        publicBaseUrl = (cfgJson && typeof cfgJson.publicBaseUrl === 'string') ? cfgJson.publicBaseUrl : '';
        maintenanceCommand = (cfgJson && typeof cfgJson.maintenanceCommand === 'string') ? cfgJson.maintenanceCommand : '';
      } catch (e) { /* keep blanks */ }

      images = ((bundle.dirs[imgDir] || {}).names || []).filter(n => IMAGE_EXT.test(n)).sort();

      // windows.json out of the bundle — same {json, missing, err} shape
      // readWindows() produces for the save route.
      const winEntry = bundle.files[winPath] || { content: null, missing: true, err: null };
      let win;
      if (winEntry.missing) win = { json: null, missing: true, err: null };
      else if (winEntry.err) win = { json: null, missing: false, err: winEntry.err };
      else {
        try {
          const j = JSON.parse(winEntry.content);
          win = (j && typeof j === 'object' && !Array.isArray(j))
            ? { json: j, missing: false, err: null }
            : { json: null, missing: false, err: 'did not contain a JSON object' };
        } catch (e) { win = { json: null, missing: false, err: 'not valid JSON (' + e.message + ')' }; }
      }

      // Window-styling data shared across the merged cards.
      const windowsErr = win.err || null;
      const wjson = windowsErr ? null : (win.json || WINDOWS_TEMPLATE);
      const resolvedDefaults = wjson
        ? Object.assign({}, WINDOWS_TEMPLATE.defaults, wjson.defaults || {})
        : WINDOWS_TEMPLATE.defaults;
      const windowsObj = (wjson && wjson.windows && typeof wjson.windows === 'object') ? wjson.windows : {};

      // Status banner about windows.json, shown above the editors.
      if (windowsErr) {
        windowsHtml = `<div class="flash-error">Window styling is unavailable: could not load <code class="font-mono">HTML/windows.json</code> (${escapeHtml(windowsErr)}). Fix it on the Web App host — content editing below still works.</div>`;
      } else if (win.missing) {
        windowsHtml = `<div class="flash-ok text-sm"><code class="font-mono">HTML/windows.json</code> doesn't exist yet — window styling shows the built-in defaults; saving any styling creates the file.</div>`;
      }

      // Defaults (global window styling) card first, then one merged
      // styling+content card per section.
      const defaultsCard = windowsErr ? '' : windowCard('defaults', 'Defaults (window styling)', resolvedDefaults, null, true, false);
      const sectionCards = results.map((r, i) => {
        const hasWindow = !windowsErr && WINDOW_SECTIONS.some(w => w.key === r.s.key);
        return mergedCard(r.s, r.content, r.err, windowsObj[r.s.key] || {}, resolvedDefaults, hasWindow, i === 0);
      }).join('\n');
      cards = defaultsCard + '\n' + sectionCards;
    }

    const previewBtn = (!notConfigured && publicBaseUrl)
      ? `<a href="${escapeHtml(publicBaseUrl)}" target="_blank" rel="noopener" class="btn-secondary inline-flex items-center gap-1.5">Preview live site <span aria-hidden="true">↗</span></a>`
      : `<span class="btn-secondary opacity-50 cursor-not-allowed inline-flex items-center gap-1.5" title="Set publicBaseUrl under Web App Settings → General to enable preview">Preview live site <span aria-hidden="true">↗</span></span>`;

    const header = `<header class="flex items-start justify-between gap-4 mb-6">
      <div>
        <h1 class="text-2xl font-bold text-slate-900 dark:text-slate-100">Web App Website</h1>
        <p class="mt-1 text-sm text-slate-500 dark:text-slate-400">Edit the public website sections stored on the Web App.</p>
      </div>
      <div class="shrink-0">${previewBtn}</div>
    </header>`;

    const banner = notConfigured
      ? `<div class="flash-error mb-6"><strong class="font-semibold">Web App access is not configured.</strong> Set how this console reaches the Web App under <a class="underline" href="/settings/web-app">Settings → Web App</a> first.</div>`
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
        ${imagesCard(images, req.query)}
        ${windowsHtml}
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
      try {
        const accessor = webAppAccess.createAccessorFromConfig(appConfig);
        const dir = imagesDirOf(accessor);
        await accessor.runCommand(`mkdir -p -- ${shq(dir)}`, { timeoutMs: 20000 });
        await accessor.writeFile(waConfig.joinPath(dir, name), req.file.buffer);
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
      res.redirect('/web-app-website?imgdel=' + encodeURIComponent(name));
    } catch (e) {
      console.error('[web-app-website] image delete failed:', e);
      res.redirect('/web-app-website?error=' + encodeURIComponent('Delete failed: ' + (e.message || e)));
    }
  });

  // ── Window styling save (JSON) ─────────────────────────────────────────────
  // :target is 'defaults' or a window key (hero/stats/…). Read-modify-write
  // HTML/windows.json so _comment and untouched windows are preserved.
  router.post('/web-app-website/windows/:target', requireAdmin, async (req, res) => {
    const target = req.params.target;
    const isDefaults = target === 'defaults';
    const isWindow = WINDOW_SECTIONS.some(s => s.key === target);
    if (!isDefaults && !isWindow) return res.status(400).json({ ok: false, error: 'Unknown target' });
    if (!webAppAccess.isConfigured(appConfig)) {
      return res.status(400).json({ ok: false, error: 'Web App access is not configured (Settings → Web App).' });
    }
    const fields = (req.body && req.body.fields && typeof req.body.fields === 'object') ? req.body.fields : null;
    if (!fields) return res.status(400).json({ ok: false, error: 'Missing fields' });

    let entry;
    try { entry = coerceWindowEntry(fields, isDefaults); }
    catch (e) { return res.status(400).json({ ok: false, error: e.message || 'Invalid input' }); }

    try {
      const accessor = webAppAccess.createAccessorFromConfig(appConfig);
      const p = waConfig.joinPath(accessor.appPath, WINDOWS_REL_PATH);

      // Preserve everything we don't touch. Refuse to clobber an existing but
      // malformed file; seed from the template only when it's truly absent.
      let json;
      const exists = await accessor.exists(p);
      if (exists) {
        let raw;
        try { raw = await accessor.readFile(p, { encoding: 'utf8' }); }
        catch (e) { return res.status(500).json({ ok: false, error: 'Could not read windows.json: ' + (e.message || e) }); }
        try { json = JSON.parse(raw); }
        catch (e) { return res.status(400).json({ ok: false, error: 'windows.json on the host is not valid JSON — fix it there before editing.' }); }
        if (!json || typeof json !== 'object' || Array.isArray(json)) {
          return res.status(400).json({ ok: false, error: 'windows.json did not contain a JSON object.' });
        }
      } else {
        json = JSON.parse(JSON.stringify(WINDOWS_TEMPLATE));
      }
      if (!json.defaults || typeof json.defaults !== 'object' || Array.isArray(json.defaults)) json.defaults = {};
      if (!json.windows || typeof json.windows !== 'object' || Array.isArray(json.windows)) json.windows = {};

      if (isDefaults) {
        // Re-apply the full managed field set so cleared keys (e.g. a blank
        // tag) are removed, while preserving any unmanaged extras already in
        // the file.
        const next = Object.assign({}, json.defaults);
        for (const d of WINDOW_FIELDS) delete next[d.key];
        json.defaults = Object.assign(next, entry);
      } else {
        json.windows[target] = entry; // replace wholesale so cleared keys are removed
      }

      await accessor.writeFile(p, JSON.stringify(json, null, 2) + '\n');
      res.json({ ok: true });
    } catch (err) {
      console.error('[web-app-website] save windows.' + target + ' failed:', err);
      res.status(500).json({ ok: false, error: err.message || 'Save failed' });
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
      res.json({ ok: true });
    } catch (err) {
      console.error(`[web-app-website] save ${section.key} failed:`, err);
      res.status(500).json({ ok: false, error: err.message || 'Save failed' });
    }
  });

  return router;
};
