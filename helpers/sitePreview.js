// helpers/sitePreview.js — the "Preview" button + pop-up shared by Events
// and Raffles: it shows the REAL website page for an item (even a draft)
// through a short-lived preview link the Web App honours
// (/<kind>/<slug>?preview=<token>; token stored on the row as preview_token /
// preview_expires_at, newest only). Nonprofits use it too, by id instead of
// slug (/need-help/preview/<org_id>?preview=<token>).
//
//   previewButton({ endpoint, noun, base })  → the button + <dialog> HTML
//   allowFramingOf(res, base)                → let THIS page frame the Web App
//   makePreviewLink(db, appConfig, opts)     → { status, body } for the
//                                              POST …/preview route
//
// Page code: the item's form sets window.mmoaFormDirty = true on input so the
// pop-up can say "You have unsaved changes".

'use strict';

const crypto = require('crypto');
const kit = require('./pageKit');

const PREVIEW_MINUTES = 30;

// The console's CSP only lets it frame itself; the Preview pop-up frames the
// Web App's page, so the edit page (only) also allows the Web App's origin.
// URL.origin is just scheme://host:port, so nothing can be smuggled into the
// header.
function allowFramingOf(res, base) {
  let origin;
  try { origin = new URL(base).origin; } catch (e) { return; }
  if (!origin || origin === 'null') return;
  const csp = res.getHeader('Content-Security-Policy');
  if (csp) res.setHeader('Content-Security-Policy', `${csp};frame-src 'self' ${origin}`);
}

// "Preview" → a pop-up (native <dialog>) showing the REAL website page via a
// fresh preview link, at desktop or phone width. Shows the last SAVED version.
function previewButton({ endpoint, noun, base }) {
  if (!base) return `<span class="btn-secondary opacity-50 cursor-not-allowed" title="Set the Public base URL under Web App Settings → General">Preview</span>`;
  return `<div x-data="{ url: '', err: '', reason: '', loading: false, phone: false, dirty: false,
        async open() {
          this.dirty = !!window.mmoaFormDirty;
          if (!this.$refs.dlg.open) this.$refs.dlg.showModal();
          await this.load();
        },
        async load() {
          this.err = ''; this.reason = ''; this.url = ''; this.loading = true;
          try {
            const r = await fetch('${endpoint}', { method: 'POST', headers: { 'Accept': 'application/json' } });
            const j = await r.json().catch(() => ({}));
            if (!r.ok || !j.url) { this.reason = j.reason || ''; throw new Error(j.error || 'Could not make a preview link.'); }
            this.url = j.url;
          } catch (e) { this.err = e.message || String(e); }
          finally { this.loading = false; }
        } }">
      <button type="button" class="btn-secondary" x-on:click="open()" aria-haspopup="dialog">Preview</button>
      <dialog x-ref="dlg" aria-labelledby="pv-title" x-on:close="url = ''"
              x-on:click="if ($event.target === $refs.dlg) $refs.dlg.close()"
              class="m-auto p-0 rounded-xl bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-2xl backdrop:bg-black/70 w-[96vw] max-w-[1400px] h-[92vh] max-h-[92vh]">
        <div class="flex h-full flex-col">
          <div class="flex items-center justify-between gap-3 flex-wrap border-b border-slate-200 dark:border-slate-700 px-4 py-2">
            <div class="min-w-0">
              <strong id="pv-title" class="text-sm">Preview — how this ${noun} looks on the website</strong>
              <p class="text-xs text-slate-500 dark:text-slate-400">Shows the last <b>saved</b> version. The link works for ${PREVIEW_MINUTES} minutes and isn't public.</p>
              <p class="text-xs text-amber-700 dark:text-amber-300" x-show="dirty" x-cloak>You have unsaved changes — save first to see them here.</p>
            </div>
            <div class="flex items-center gap-2">
              <div class="inline-flex rounded-lg border border-slate-300 dark:border-slate-600 overflow-hidden divide-x divide-slate-300 dark:divide-slate-600" role="group" aria-label="Preview width">
                <button type="button" class="px-3 py-1.5 text-xs font-semibold" :class="!phone ? 'bg-brand-600 text-white' : 'text-slate-600 dark:text-slate-300'" :aria-pressed="!phone" x-on:click="phone = false">Desktop</button>
                <button type="button" class="px-3 py-1.5 text-xs font-semibold" :class="phone ? 'bg-brand-600 text-white' : 'text-slate-600 dark:text-slate-300'" :aria-pressed="phone" x-on:click="phone = true">Phone</button>
              </div>
              <a class="btn-secondary text-xs px-3 py-1.5" :href="url || null" target="_blank" rel="noopener" x-show="url" x-cloak>Open in new tab <span aria-hidden="true">↗</span></a>
              <button type="button" class="btn-primary text-xs px-3 py-1.5" x-on:click="$refs.dlg.close()" autofocus>Close</button>
            </div>
          </div>
          <div class="flex-1 min-h-0 bg-slate-200 dark:bg-black overflow-auto">
            <div x-show="loading" class="p-10 text-center text-sm text-slate-500">Checking the Web App and making a preview link…</div>
            <div x-show="err && (reason === 'offline' || reason === 'maintenance' || reason === 'error')" x-cloak role="alert"
                 class="m-6 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950/50 dark:text-amber-100">
              <div class="font-semibold" x-text="reason === 'maintenance' ? '⚠ The Web App is in maintenance mode' : '⚠ The Web App is offline'"></div>
              <p class="mt-1" x-text="err"></p>
              <p class="mt-1" x-show="reason !== 'maintenance'">The preview shows the real website page, so the Web App has to be running. Start it from
                <a class="underline" href="/web-app-settings/general">Web App Settings</a> (Start Web App), then try again.</p>
              <p class="mt-1" x-show="reason === 'maintenance'">Turn maintenance mode off under <a class="underline" href="/web-app-website">Web App Website → Maintenance Mode</a>, then try again.</p>
              <button type="button" class="btn-secondary text-xs px-3 py-1.5 mt-3" x-on:click="load()">Try again</button>
            </div>
            <div x-show="err && !(reason === 'offline' || reason === 'maintenance' || reason === 'error')" x-cloak class="m-6 flash-error text-sm" role="alert" x-text="err"></div>
            <template x-if="url">
              <iframe :src="url" title="${noun[0].toUpperCase() + noun.slice(1)} preview" class="block mx-auto h-full bg-white border-0" :class="phone ? 'w-[390px] border-x border-slate-400' : 'w-full'"></iframe>
            </template>
          </div>
        </div>
      </dialog>
    </div>`;
}

// Make a fresh preview link for one row (replacing any earlier one), after
// checking the Web App is up (the pop-up frames its page). opts: { table,
// idCol, id, path, byId } — path is the public page prefix, e.g. '/raffles';
// the URL ends in the row's slug, or in its id when byId is set (a table
// with no slug column, e.g. organizations → /need-help/preview/<org_id>).
async function makePreviewLink(db, appConfig, { table, idCol, id, path, byId }) {
  const base = await kit.webAppPublicUrl(appConfig);
  if (!base) return { status: 400, body: { error: "The Web App's public URL isn't set (Web App Settings → General → Public base URL)." } };
  const up = await kit.webAppReachable(base);
  if (!up.ok) return { status: 503, body: { error: up.message, reason: up.reason } };
  try {
    const row = await db.getAsync(`SELECT ${byId ? idCol + ' AS slug' : 'slug'} FROM ${table} WHERE ${idCol} = ?`, [id]);
    if (!row) return { status: 404, body: { error: 'Not found' } };
    const token = crypto.randomBytes(24).toString('hex');
    await db.runAsync(`UPDATE ${table} SET preview_token = ?, preview_expires_at = ? WHERE ${idCol} = ?`,
      [token, kit.sqlTime(PREVIEW_MINUTES * 60 * 1000), id]);
    return { status: 200, body: { url: `${base}${path}/${encodeURIComponent(row.slug)}?preview=${token}` } };
  } catch (err) {
    console.error(`[preview] ${table} #${id} failed:`, err);
    return { status: 500, body: { error: /no such column|unknown column/i.test(err.message || '')
      ? 'Restart the Web App first — it adds what previews need to the database when it starts.'
      : 'Could not make a preview link: ' + (err.message || err) } };
  }
}

module.exports = { PREVIEW_MINUTES, previewButton, allowFramingOf, makePreviewLink };
