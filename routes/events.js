// routes/events.js — the website's events (the web app's `events` +
// `event_beneficiaries` tables). The website is the source of truth for
// events; Facebook only links to it, so this is where the board publishes.
//
//   GET  /events?status=all|draft|published|archived → list, filtered by the
//                                            "Show" drop-down (default all);
//                                            published = upcoming, then past
//   GET  /events/new                       → blank form
//   POST /events                           → create (then add flyer / cover)
//   GET  /events/:id                       → edit form + images + actions
//   POST /events/:id                       → save (incl. status; the header's
//                                            status buttons submit this form
//                                            too, with set_status)
//   POST /events/:id/preview               → JSON { url }: a 30-minute link to
//                                            the real page, even for a draft
//   POST /events/:id/delete                → delete row, beneficiaries, image files
//   POST /events/:id/image/:slot           → upload flyer | cover (multipart "image")
//   POST /events/:id/image/:slot/remove    → clear flyer | cover (deletes the file)
//
// Status (events.status): draft (being prepared) → published (on the
// website) → archived (taken down, kept for reference). Any state can move to
// any other. is_published is kept in step (1 only while published) for the
// web app's older readers. Needs the web app's 2026-10 migration, which adds
// the column on its next start.
//
// Preview: a random token stored on the event (preview_token /
// preview_expires_at, newest only) — the web app shows /events/<slug>
// ?preview=<token> whatever the status, with a "Preview" banner, and lets
// that one page be framed so it opens in a pop-up here.
//
// Latest (events.is_latest): at most ONE event is "Latest" and the website
// also serves it at /events/latest (while it's published). Saving an event
// with Latest ticked clears it on every other event first; 'latest' is
// therefore reserved as a slug.
//
// Times: starts_at / ends_at are stored as UTC 'YYYY-MM-DD HH:MM:SS'; the form
// works in the organization's zone (appConfig.timeZone, default
// America/Chicago) — see helpers/localTime.js. "Upcoming" uses the web app's
// rule: published and starts_at ≥ now − 12 h.
//
// The description is Markdown-lite (helpers/markdownLite.js — the console's
// copy of the web app's renderer); the preview pane renders it with the same
// rules through POST /markdown-preview.
//
// Beneficiaries: each row is either a directory organization (org_id — the
// public page links to it only while that org is verified + listed) or free
// text + optional URL. Rows are replaced wholesale on save (DELETE + INSERT in
// one transaction), so the table needs no primary key of its own. The org's
// name is copied into `name` too, so the row still reads sensibly if the
// organization is later deleted (org_id → NULL).

const express = require('express');
const { page, flash } = require('../views/layout');
const { escapeHtml, jsAttrStr } = require('../views/escapeHtml');
const { requireAdmin } = require('../middleware/auth');
const kit = require('../helpers/pageKit');
const preview = require('../helpers/sitePreview');
const vis = require('../helpers/visibility');
const latest = require('../helpers/latest');
const lt = require('../helpers/localTime');
const uploads = require('../helpers/webAppUploads');

// The list's "Show" filter. Old ?tab= links (upcoming / past / drafts /
// draft / published / archived) still work.
const FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'draft', label: 'Draft' },
  { key: 'published', label: 'Published' },
  { key: 'archived', label: 'Archived' }
];
const OLD_TABS = { upcoming: 'published', past: 'published', drafts: 'draft', draft: 'draft', published: 'published', archived: 'archived' };
// Draft / Published / Archived (shared with raffles: helpers/visibility.js).
const STATUSES = vis.VISIBILITY;
const STATUS_KEYS = vis.KEYS;
const statusPill = vis.pill;

// "no such column: status" → the web app hasn't been restarted since the
// update that adds it.
function statusColumnHint(err) {
  return err && /status|preview_/i.test(err.message || '') && /no such column|unknown column/i.test(err.message || '')
    ? `<div class="flash-error mb-6"><strong class="font-semibold">Restart the Web App to finish this update.</strong> Events now have a Draft / Published / Archived status; the Web App adds that to the database when it next starts (Web App Settings → Restart Web App).</div>`
    : '';
}

const statusButtons = (current) => vis.buttons(current, { formId: 'ev-form', noun: 'event' });
const statusSwitch = (current) => vis.switcher(current, { formId: 'ev-form', noun: 'event' });

const SLOTS = { flyer: 'flyer_path', cover: 'cover_path' };
const TEXTAREA_CLS = 'block w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100';

const EVENT_COLS = `event_id, slug, title, summary, description_md, starts_at, ends_at, venue_name,
  address, city, map_url, flyer_path, cover_path, registration_url, registration_label,
  registration_note, beneficiaries_text, is_published, status, is_latest, created_at, updated_at`;


// Read + validate the posted form. Returns { values, fields, bens, error }.
// `values` echoes the inputs back into the form on an error.
function readForm(b, appConfig) {
  const values = {
    title: b.title || '', slug: b.slug || '', summary: b.summary || '', description_md: b.description_md || '',
    starts_local: b.starts_at || '', ends_local: b.ends_at || '', venue_name: b.venue_name || '',
    address: b.address || '', city: b.city || '', map_url: b.map_url || '',
    registration_url: b.registration_url || '', registration_label: b.registration_label || '',
    registration_note: b.registration_note || '', beneficiaries_text: b.beneficiaries_text || '',
    status: STATUS_KEYS.includes(b.set_status) ? b.set_status : STATUS_KEYS.includes(b.status) ? b.status : 'draft',
    bens_json: b.beneficiaries_json || '[]',
    is_latest: kit.yes(b.is_latest), item_id: b._item_id || ''
  };
  const fail = (error) => ({ values, error });

  const title = kit.str(b.title, 200);
  if (!title) return fail('Title is required.');
  const slugIn = kit.str(b.slug, 80);
  let slug = slugIn ? kit.slugify(slugIn) : kit.slugify(title);
  if (!slug || !kit.SLUG_RE.test(slug)) return fail('The URL slug may only contain lowercase letters, digits and dashes.');
  // /events/latest is the Latest event's address, so no event may own it.
  const lc = latest.slugCheck(slug, slugIn, latest.EVENT);
  if (lc.error) return fail(lc.error);
  slug = lc.slug;
  const summary = kit.str(b.summary);
  if (summary && summary.length > 200) return fail('The summary must be 200 characters or fewer.');
  const starts = lt.localInputToUtc(b.starts_at, appConfig);
  if (!starts) return fail('Start date and time are required.');
  const ends = lt.localInputToUtc(b.ends_at, appConfig);
  if (ends === undefined) return fail('The end date/time is not valid.');
  if (ends && ends < starts) return fail('The event ends before it starts.');
  const map = kit.urlField(b.map_url, 'Map link');
  if (map.error) return fail(map.error);
  const reg = kit.urlField(b.registration_url, 'Registration link');
  if (reg.error) return fail(reg.error);

  let bensIn;
  try { bensIn = JSON.parse(b.beneficiaries_json || '[]'); } catch (e) { return fail('Beneficiaries could not be read — reload the page and try again.'); }
  if (!Array.isArray(bensIn)) bensIn = [];
  const bens = [];
  for (const x of bensIn.slice(0, 30)) {
    const orgId = kit.idParam(x && x.org_id);
    const name = kit.str(x && x.name, 200);
    const u = kit.urlField(x && x.url, 'Beneficiary link');
    if (u.error) return fail(u.error);
    if (!orgId && !name) continue; // blank row
    bens.push({ org_id: orgId, name, url: orgId ? null : u.value });
  }

  return {
    values,
    bens,
    fields: {
      slug, title, summary, description_md: kit.str(b.description_md, 20000),
      starts_at: starts, ends_at: ends || null,
      venue_name: kit.str(b.venue_name, 200), address: kit.str(b.address, 300), city: kit.str(b.city, 100),
      map_url: map.value, registration_url: reg.value,
      registration_label: kit.str(b.registration_label, 100) || 'Register & pay',
      registration_note: kit.str(b.registration_note, 255),
      beneficiaries_text: kit.str(b.beneficiaries_text, 2000),
      status: values.status,
      is_published: values.status === 'published' ? 1 : 0,
      is_latest: values.is_latest ? 1 : 0
    }
  };
}

function valuesFromRow(e, bens, appConfig) {
  return {
    title: e.title || '', slug: e.slug || '', summary: e.summary || '', description_md: e.description_md || '',
    starts_local: lt.utcToLocalInput(e.starts_at, appConfig), ends_local: lt.utcToLocalInput(e.ends_at, appConfig),
    venue_name: e.venue_name || '', address: e.address || '', city: e.city || '', map_url: e.map_url || '',
    registration_url: e.registration_url || '', registration_label: e.registration_label || 'Register & pay',
    registration_note: e.registration_note || '', beneficiaries_text: e.beneficiaries_text || '',
    status: STATUS_KEYS.includes(e.status) ? e.status : (Number(e.is_published) ? 'published' : 'draft'),
    is_latest: !!Number(e.is_latest), item_id: String(e.event_id),
    bens_json: JSON.stringify((bens || []).map(x => ({ org_id: x.org_id ? Number(x.org_id) : '', name: x.name || '', url: x.url || '' })))
  };
}

// Load the orgs a beneficiary can point at (any status; the public page only
// links verified + listed ones) and the city names for the datalist.
async function loadPickers(db) {
  const orgs = await kit.safeAll(db, 'SELECT org_id, name, verification_status, is_listed FROM organizations ORDER BY LOWER(name)', []);
  const cities = await kit.safeAll(db, 'SELECT name FROM cities WHERE is_active = 1 ORDER BY sort, name', []);
  const cur = await kit.safeGet(db, 'SELECT event_id AS id, title FROM events WHERE is_latest = 1 ORDER BY event_id DESC LIMIT 1', [], null);
  return { orgs: orgs.rows, cities: cities.rows.map(r => r.name), latest: cur.value, err: orgs.err || cities.err || cur.err };
}

function markdownHint() {
  return `<p class="mt-1 text-xs text-slate-500 dark:text-slate-400">Formatting: blank line = new paragraph · <code>**bold**</code> · <code>*italic*</code> · <code>[link text](https://…)</code> · lines starting <code>- </code> make a bullet list. No HTML.</p>`;
}

// Description textarea + live preview (same renderer as the website).
function markdownField(name, label, value, rows) {
  return `<div data-md-init="${escapeHtml(JSON.stringify(value || ''))}"
       x-data="{ text: '', html: '', timer: null, showPreview: true,
         init() { this.text = JSON.parse(this.$el.dataset.mdInit); this.render(); this.$watch('text', () => { clearTimeout(this.timer); this.timer = setTimeout(() => this.render(), 300); }); },
         async render() {
           try {
             const r = await fetch('/markdown-preview', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }, body: JSON.stringify({ text: this.text }) });
             const j = await r.json(); this.html = j.html || '';
           } catch (e) { /* keep the last preview */ }
         } }">
    <div class="flex items-center justify-between">
      <label class="label" for="md-${escapeHtml(name)}">${escapeHtml(label)}</label>
      <label class="inline-flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400"><input type="checkbox" x-model="showPreview" class="h-4 w-4"> Preview</label>
    </div>
    <div class="grid gap-3" :class="showPreview ? 'lg:grid-cols-2' : ''">
      <textarea id="md-${escapeHtml(name)}" name="${escapeHtml(name)}" rows="${rows || 10}" maxlength="20000" x-model="text" class="${TEXTAREA_CLS}"></textarea>
      <div x-show="showPreview" class="md-preview rounded-lg border border-dashed border-slate-300 dark:border-slate-700 px-4 py-3 text-sm overflow-auto" style="max-height: 24rem">
        <div x-show="!html" class="text-slate-400 italic">Preview appears here.</div>
        <div x-html="html"></div>
      </div>
    </div>
    ${markdownHint()}
  </div>`;
}

function beneficiariesEditor(benJson, orgs) {
  const orgOpts = orgs.map(o => {
    const st = o.verification_status === 'verified' ? (Number(o.is_listed) ? '' : ' (hidden)') : ` (${o.verification_status})`;
    return `<option value="${Number(o.org_id)}">${escapeHtml(o.name + st)}</option>`;
  }).join('');
  return `<div data-bens="${escapeHtml(benJson || '[]')}"
       x-data="{ rows: [],
         init() { this.rows = JSON.parse(this.$el.dataset.bens || '[]').map(r => ({ org_id: r.org_id ? String(r.org_id) : '', name: r.name || '', url: r.url || '' })); },
         add() { this.rows.push({ org_id: '', name: '', url: '' }); },
         remove(i) { this.rows.splice(i, 1); this.touched = {}; },
         touched: {},
         // Same rule as httpLinkInput / the server: blank, or http(s)://… with no spaces.
         badUrl(r) { if (r.org_id) return false; const s = (r.url || '').trim().toLowerCase();
           return s !== '' && (s.includes(' ') || !((s.startsWith('http://') && s.length > 7) || (s.startsWith('https://') && s.length > 8))); },
         move(i, d) { const j = i + d; if (j < 0 || j >= this.rows.length) return; const t = this.rows[i]; this.rows[i] = this.rows[j]; this.rows[j] = t; },
         get json() { return JSON.stringify(this.rows.map(r => ({ org_id: r.org_id, name: r.name, url: r.url }))); } }">
    <input type="hidden" name="beneficiaries_json" :value="json">
    <div class="flex items-center justify-between">
      <span class="label mb-0">Beneficiaries</span>
      <button type="button" class="btn-secondary text-xs px-3 py-1" x-on:click="add()">＋ Add beneficiary</button>
    </div>
    <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">Pick an organization from the Need Help directory (the site links to its profile while it is verified and listed) or type a name and optional link.</p>
    <div class="mt-3 space-y-2">
      <template x-for="(r, i) in rows" :key="i">
        <div class="grid grid-cols-1 md:grid-cols-12 gap-2 items-center rounded-lg border border-slate-200 dark:border-slate-700 p-2">
          <select class="input md:col-span-4" x-model="r.org_id" aria-label="Directory organization">
            <option value="">— Not in the directory —</option>
            ${orgOpts}
          </select>
          <input class="input md:col-span-3" type="text" maxlength="200" x-model="r.name" :placeholder="r.org_id ? '(uses the organization name)' : 'Name *'" :disabled="!!r.org_id" aria-label="Name">
          <div class="md:col-span-3">
            <input class="input" type="text" inputmode="url" autocomplete="off" spellcheck="false" maxlength="1000" x-model="r.url"
                   :placeholder="r.org_id ? '(links to the profile)' : 'https://… (optional)'" :disabled="!!r.org_id" aria-label="Link"
                   x-effect="$el.setCustomValidity(badUrl(r) ? 'Must start with http:// or https://' : '')"
                   x-on:blur="touched[i] = true" x-on:invalid="touched[i] = true"
                   :aria-invalid="touched[i] && badUrl(r) ? 'true' : null"
                   :class="touched[i] && badUrl(r) ? 'border-red-500 focus:border-red-500 focus:ring-red-500/30' : ''">
            <p class="mt-1 text-xs text-red-600 dark:text-red-300" x-show="touched[i] && badUrl(r)" x-cloak>Must start with <code>http://</code> or <code>https://</code></p>
          </div>
          <div class="md:col-span-2 flex items-center justify-end gap-1">
            <button type="button" class="btn-ghost text-xs px-2 py-1" x-on:click="move(i, -1)" aria-label="Move up">▲</button>
            <button type="button" class="btn-ghost text-xs px-2 py-1" x-on:click="move(i, 1)" aria-label="Move down">▼</button>
            <button type="button" class="btn-ghost text-xs px-2 py-1 text-red-600" x-on:click="remove(i)" aria-label="Remove">✕</button>
          </div>
        </div>
      </template>
      <p x-show="!rows.length" class="text-sm text-slate-400 italic">No beneficiaries listed.</p>
    </div>
  </div>`;
}

// A web-address field that must start with http:// or https:// (the server
// checks too — kit.urlField). Plain text + an inline check rather than
// type="url", whose generic browser message accepts any scheme. The error
// shows once the field is left (or a save is tried) and blocks the save.
function httpLinkInput(id, name, value, placeholder) {
  return `<div x-data="{ v: ${escapeHtml(JSON.stringify(value || ''))}, t: false,
        bad() { const s = this.v.trim().toLowerCase();
          return s !== '' && (s.includes(' ') || !((s.startsWith('http://') && s.length > 7) || (s.startsWith('https://') && s.length > 8))); } }">
      <input id="${id}" class="input" type="text" inputmode="url" autocomplete="off" spellcheck="false" name="${name}" maxlength="1000"
             placeholder="${escapeHtml(placeholder)}" x-model="v"
             x-effect="$el.setCustomValidity(bad() ? 'Must start with http:// or https://' : '')"
             x-on:blur="t = true" x-on:invalid="t = true"
             :aria-invalid="t && bad() ? 'true' : null" aria-describedby="${id}-err"
             :class="t && bad() ? 'border-red-500 focus:border-red-500 focus:ring-red-500/30' : ''">
      <p id="${id}-err" class="mt-1 text-xs text-red-600 dark:text-red-300" x-show="t && bad()" x-cloak>Must start with <code>http://</code> or <code>https://</code></p>
    </div>`;
}

function eventForm(action, v, pickers, isNew, zone) {
  const val = (k) => escapeHtml(v[k] || '');
  const cityList = pickers.cities.map(c => `<option value="${escapeHtml(c)}">`).join('');
  return `<form id="ev-form" method="POST" action="${action}" class="space-y-6" x-data x-on:input="window.mmoaFormDirty = true">
    <section class="card surface-target card-pad space-y-4">
      <h2 class="text-sm font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">Event</h2>
      <div class="grid sm:grid-cols-2 gap-4">
        <div class="sm:col-span-2">
          <label class="label" for="ev-title">Title *</label>
          <input id="ev-title" class="input" type="text" name="title" required maxlength="200" value="${val('title')}">
        </div>
        <div>
          <label class="label" for="ev-slug">URL slug</label>
          <input id="ev-slug" class="input font-mono" type="text" name="slug" maxlength="80" pattern="[a-z0-9-]*" value="${val('slug')}" placeholder="made from the title when blank">
          <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">The page address: <code>/events/&lt;slug&gt;</code>. Changing it breaks links already shared on Facebook.</p>
          ${latest.field(v, pickers.latest, latest.EVENT)}
        </div>
        <div>
          <label class="label" for="ev-summary">Summary <span class="text-xs font-normal text-slate-400">(≤ 200 characters, shown on cards)</span></label>
          <input id="ev-summary" class="input" type="text" name="summary" maxlength="200" value="${val('summary')}">
        </div>
        <div>
          <label class="label" for="ev-starts">Starts * <span class="text-xs font-normal text-slate-400">(${escapeHtml(zone)})</span></label>
          <input id="ev-starts" class="input" type="text" data-datetime name="starts_at" required value="${val('starts_local')}" placeholder="Pick a date and time" autocomplete="off">
        </div>
        <div x-data="{ hasEnd: ${v.ends_local ? 'true' : 'false'},
              toggle(on) {
                this.hasEnd = on;
                const end = window.mmoaDatePicker && window.mmoaDatePicker(this.$refs.ends);
                if (!end) return;
                if (!on) { end.clear(); return; }
                if (!end.selectedDates.length) {
                  const st = window.mmoaDatePicker(document.getElementById('ev-starts'));
                  const s = st && st.selectedDates[0];
                  if (s) end.setDate(new Date(s.getTime() + 3 * 3600 * 1000), true);
                }
              } }">
          <div class="flex items-center justify-between gap-3 flex-wrap">
            <label class="label" for="ev-ends">Ends <span class="text-xs font-normal text-slate-400">(${escapeHtml(zone)})</span></label>
            <label class="inline-flex items-center gap-2 text-xs text-slate-700 dark:text-slate-200 mb-1">
              <input type="checkbox" class="h-4 w-4" ${v.ends_local ? 'checked' : ''} x-on:change="toggle($event.target.checked)">
              Has an end time
            </label>
          </div>
          <p class="text-sm text-slate-400 italic py-2.5" x-show="!hasEnd" ${v.ends_local ? 'x-cloak' : ''}>No end time — tick "Has an end time" to add one.</p>
          <div x-show="hasEnd" ${v.ends_local ? '' : 'x-cloak'}>
            <input id="ev-ends" x-ref="ends" class="input" type="text" data-datetime data-min-from="#ev-starts" name="ends_at" value="${val('ends_local')}" placeholder="Pick an end date and time" autocomplete="off">
            <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">Can't be before the start. Untick to leave the end open.</p>
          </div>
        </div>
      </div>
      ${markdownField('description_md', 'Description', v.description_md, 10)}
    </section>

    <section class="card surface-target card-pad space-y-4">
      <h2 class="text-sm font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">Where</h2>
      <div class="grid sm:grid-cols-2 gap-4">
        <div><label class="label" for="ev-venue">Venue name</label>
          <input id="ev-venue" class="input" type="text" name="venue_name" maxlength="200" value="${val('venue_name')}"></div>
        <div><label class="label" for="ev-city">City</label>
          <input id="ev-city" class="input" type="text" name="city" maxlength="100" list="ev-cities" value="${val('city')}">
          <datalist id="ev-cities">${cityList}</datalist></div>
        <div class="sm:col-span-2"><label class="label" for="ev-address">Address</label>
          <input id="ev-address" class="input" type="text" name="address" maxlength="300" value="${val('address')}"></div>
        <div class="sm:col-span-2"><label class="label" for="ev-map">Map link <span class="text-xs font-normal text-slate-400">(optional — blank builds a Google Maps search from the address)</span></label>
          ${httpLinkInput('ev-map', 'map_url', v.map_url, 'https://maps.app.goo.gl/…')}</div>
      </div>
    </section>

    <section class="card surface-target card-pad space-y-4">
      <h2 class="text-sm font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">Registration</h2>
      <div class="grid sm:grid-cols-2 gap-4">
        <div class="sm:col-span-2"><label class="label" for="ev-reg">Registration / payment link <span class="text-xs font-normal text-slate-400">(a Stripe Payment Link or any https:// page; blank = no button)</span></label>
          ${httpLinkInput('ev-reg', 'registration_url', v.registration_url, 'https://buy.stripe.com/…')}</div>
        <div><label class="label" for="ev-reglabel">Button label</label>
          <input id="ev-reglabel" class="input" type="text" name="registration_label" maxlength="100" value="${val('registration_label') || 'Register &amp; pay'}"></div>
        <div><label class="label" for="ev-regnote">Note next to the button</label>
          <input id="ev-regnote" class="input" type="text" name="registration_note" maxlength="255" value="${val('registration_note')}" placeholder="e.g. $25 entry per vehicle"></div>
      </div>
    </section>

    <section class="card surface-target card-pad space-y-4">
      <h2 class="text-sm font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">Who it benefits</h2>
      ${beneficiariesEditor(v.bens_json, pickers.orgs)}
      <div><label class="label" for="ev-bentext">Beneficiaries note <span class="text-xs font-normal text-slate-400">(optional free text shown with the list)</span></label>
        <textarea id="ev-bentext" name="beneficiaries_text" rows="2" maxlength="2000" class="${TEXTAREA_CLS}">${escapeHtml(v.beneficiaries_text || '')}</textarea></div>
    </section>

    <div class="flex items-center justify-between gap-4 flex-wrap">
      ${statusSwitch(v.status || 'draft')}
      <div class="flex items-center gap-2">
        <a href="/events" class="btn-secondary">Cancel</a>
        <button type="submit" class="btn-primary">${isNew ? 'Create event' : 'Save changes'}</button>
      </div>
    </div>
  </form>`;
}

// "Generate flyer": draws a flyer in the browser (public/js/flyer-maker.js)
// from the form's current values + the saved cover photo, shows it in a
// pop-up, and "Use as flyer" uploads it through the normal flyer upload. If
// the form has unsaved edits, the form is then saved too (the page reloads
// either way, so edits aren't lost).
function flyerMaker(eventId, coverRel, siteUrl) {
  return `<div class="pt-1 flex items-center gap-2 flex-wrap" data-action="/events/${eventId}/image/flyer"
       data-cover="${coverRel ? '/wa-uploads/' + escapeHtml(coverRel) : ''}" data-url="${escapeHtml(siteUrl || '')}"
       x-data="{ cfg: {}, busy: false, err: '', ready: false, dirty: false,
         init() { this.cfg = Object.assign({}, this.$el.dataset); },
         async open() {
           this.err = ''; this.ready = false; this.dirty = !!window.mmoaFormDirty;
           this.$refs.dlg.showModal();
           try {
             const d = window.mmoaFlyer.collect(document.getElementById('ev-form'), { coverUrl: this.cfg.cover, url: this.cfg.url, orgName: 'Mission Men of Anna' });
             await window.mmoaFlyer.render(this.$refs.cv, d);
             this.ready = true;
           } catch (e) { this.err = 'Could not draw the flyer: ' + (e.message || e); }
         },
         use() {
           this.busy = true; this.err = '';
           this.$refs.cv.toBlob(b => {
             const file = new File([b], 'generated-flyer.jpg', { type: 'image/jpeg' });
             window.macUploadImage(this.cfg.action, file).then(r => {
               if (!r.ok) { this.err = r.error || 'Upload failed'; this.busy = false; return; }
               if (this.dirty) document.getElementById('ev-form').requestSubmit(); else window.location.reload();
             });
           }, 'image/jpeg', 0.9);
         },
         download() {
           const a = document.createElement('a');
           a.href = this.$refs.cv.toDataURL('image/jpeg', 0.92); a.download = 'event-flyer.jpg';
           document.body.appendChild(a); a.click(); a.remove();
         } }">
    <span class="text-xs text-slate-500 dark:text-slate-400">or</span>
    <button type="button" class="btn-secondary text-sm" x-on:click="open()" aria-haspopup="dialog">✨ Generate flyer</button>
    <span class="text-xs text-slate-500 dark:text-slate-400">from this event's details${coverRel ? ' and cover photo' : ' (add a cover photo for a picture)'}</span>
    <dialog x-ref="dlg" aria-labelledby="fm-title" x-on:click="if ($event.target === $refs.dlg) $refs.dlg.close()"
            class="m-auto p-0 rounded-xl bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-2xl backdrop:bg-black/70 w-[96vw] max-w-[760px] max-h-[94vh]">
      <div class="flex max-h-[94vh] flex-col">
        <div class="flex items-center justify-between gap-3 flex-wrap border-b border-slate-200 dark:border-slate-700 px-4 py-2">
          <div class="min-w-0">
            <strong id="fm-title" class="text-sm">Generated flyer</strong>
            <p class="text-xs text-slate-500 dark:text-slate-400">Made from what's in the form now${coverRel ? ' and the cover photo' : ''}. Edit the event and generate again to change it.</p>
          </div>
          <div class="flex items-center gap-2">
            <button type="button" class="btn-secondary text-xs px-3 py-1.5" x-on:click="download()" :disabled="!ready">Download</button>
            <button type="button" class="btn-primary text-xs px-3 py-1.5" x-on:click="use()" :disabled="!ready || busy">
              <span x-show="!busy">Use as flyer</span><span x-show="busy" x-cloak>Uploading…</span></button>
            <button type="button" class="btn-secondary text-xs px-3 py-1.5" x-on:click="$refs.dlg.close()" autofocus>Close</button>
          </div>
        </div>
        <p class="mx-4 mt-3 text-xs text-amber-700 dark:text-amber-300" x-show="dirty" x-cloak>You have unsaved changes — "Use as flyer" saves them too.</p>
        <div x-show="err" x-cloak class="mx-4 mt-3 flash-error text-sm" role="alert" x-text="err"></div>
        <div class="flex-1 min-h-0 overflow-auto p-4 bg-slate-100 dark:bg-black/40 flex justify-center">
          <canvas x-ref="cv" class="block h-auto max-h-[72vh] w-auto max-w-full rounded-lg shadow" role="img" aria-label="Generated event flyer"></canvas>
        </div>
      </div>
    </dialog>
  </div>`;
}

function imageSlotCard(eventId, slot, label, hint, rel, extra) {
  return `<div class="rounded-lg border border-slate-200 dark:border-slate-700 p-3 space-y-2">
    <div class="flex items-center justify-between gap-2">
      <div><div class="text-sm font-semibold text-slate-900 dark:text-slate-100">${escapeHtml(label)}</div>
        <div class="text-xs text-slate-500 dark:text-slate-400">${escapeHtml(hint)}</div></div>
      ${rel ? `<form method="POST" action="/events/${eventId}/image/${slot}/remove" class="m-0"
            x-data x-on:submit.prevent="window.uiConfirmSubmit($event.target, 'Remove the ${slot}? The file is deleted from the Web App.', { title: 'Remove image', confirmLabel: 'Remove' })">
          <button type="submit" class="btn-danger text-xs px-3 py-1">Remove</button></form>` : ''}
    </div>
    ${rel ? `<a href="/wa-uploads/${escapeHtml(rel)}" target="_blank" rel="noopener">${kit.uploadImg(rel, label, 'max-h-48 w-auto rounded-lg border border-slate-200 dark:border-slate-700')}</a>
             <div class="font-mono text-xs text-slate-400">uploads/${escapeHtml(rel)}</div>`
          : `<p class="text-sm text-slate-400 italic">None yet.</p>`}
    ${kit.uploadForm(`/events/${eventId}/image/${slot}`, rel ? 'Replace' : 'Upload')}
    ${extra || ''}
  </div>`;
}

module.exports = function (db, appConfig) {
  const router = express.Router();

  // ── List ────────────────────────────────────────────────────────────
  router.get('/events', requireAdmin, async (req, res) => {
    const user = req.session.user;
    const asked = req.query.status || OLD_TABS[req.query.tab] || 'all';
    const filter = FILTERS.some(f => f.key === asked) ? asked : 'all';
    const { rows: all, err } = await kit.safeAll(db,
      `SELECT event_id, slug, title, starts_at, venue_name, city, status, is_latest, flyer_path FROM events
        ${filter === 'all' ? '' : 'WHERE status = ?'} ORDER BY starts_at ASC, event_id ASC`, filter === 'all' ? [] : [filter]);
    const counts = { all: 0 };
    const { rows: countRows } = await kit.safeAll(db, 'SELECT status, COUNT(*) AS c FROM events GROUP BY status', []);
    for (const r of countRows) { counts[r.status] = Number(r.c); counts.all += Number(r.c); }

    // Published splits like the website: upcoming (starts no more than 12 h
    // ago) soonest first, then past newest first. Drafts soonest first,
    // archived newest first. "All" shows every group, in that working order.
    const cutMs = Date.now() - 12 * 3600 * 1000;
    const ms = (v) => v instanceof Date ? v.getTime() : Date.parse(String(v || '').replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(String(v)) ? '' : 'Z'));
    const of = (st) => all.filter(e => e.status === st);
    const pub = of('published');
    const G = {
      draft: { label: 'Drafts', note: 'not on the website yet', rows: of('draft') },
      upcoming: { label: 'Published — upcoming', note: "on the website's Events page", rows: pub.filter(e => ms(e.starts_at) >= cutMs) },
      past: { label: 'Published — past', note: 'listed under Past events on the website', rows: pub.filter(e => !(ms(e.starts_at) >= cutMs)).reverse() },
      archived: { label: 'Archived', note: 'off the website, kept for reference', rows: of('archived').reverse() }
    };
    const groups = filter === 'all' ? [G.draft, G.upcoming, G.past, G.archived]
      : filter === 'published' ? [G.upcoming, G.past]
      : [{ rows: G[filter].rows }];
    const options = FILTERS.map(f => `<option value="${f.key}" ${f.key === filter ? 'selected' : ''}>${f.label} (${counts[f.key] || 0})</option>`).join('');
    const row = (e) => `
      <tr class="cursor-pointer" data-href="/events/${Number(e.event_id)}" x-on:click="window.location = $el.dataset.href">
        <td class="whitespace-nowrap text-xs text-slate-500">${escapeHtml(lt.formatLocal(e.starts_at, appConfig))}</td>
        <td class="font-medium text-slate-900 dark:text-slate-100"><a class="hover:underline" href="/events/${Number(e.event_id)}">${escapeHtml(e.title)}</a>
          <div class="font-mono text-xs text-slate-400">/events/${escapeHtml(e.slug)}</div></td>
        <td>${escapeHtml([e.venue_name, e.city].filter(Boolean).join(' · ') || '—')}</td>
        <td>${statusPill(e.status)}
            ${Number(e.is_latest) ? ' <span class="pill-running" title="Also at /events/latest">Latest</span>' : ''}
            ${e.flyer_path ? '' : ' <span class="pill-pending" title="No flyer uploaded">no flyer</span>'}</td>
      </tr>`;
    const tbody = groups.map(g => (g.label
      ? `<tr><th colspan="4" scope="colgroup" class="px-4 py-2 bg-slate-50 dark:bg-slate-800/60 text-left text-xs font-semibold uppercase tracking-wider text-slate-600 dark:text-slate-300">${escapeHtml(g.label)} <span class="normal-case font-normal tracking-normal text-slate-500 dark:text-slate-400">— ${escapeHtml(g.note)} (${g.rows.length})</span></th></tr>`
        + (g.rows.length ? '' : `<tr><td colspan="4" class="text-center py-4 text-sm text-slate-400">None.</td></tr>`)
      : '') + g.rows.map(row).join('')).join('');
    const empty = !all.length;
    const body = `
      ${kit.pageHeader('Events', 'Only Published events are on the website. Times are shown in ' + lt.zoneOf(appConfig) + '.',
        `<a href="/events/new" class="btn-primary"><span aria-hidden="true">＋</span><span>New event</span></a>`)}
      ${flash('error', req.query.error)}
      ${flash('success', req.query.msg)}
      ${statusColumnHint(err) || kit.dbBanner(err)}
      <form method="GET" action="/events" class="mb-4 flex items-center gap-2" x-data>
        <label for="ev-filter" class="text-sm font-semibold text-slate-700 dark:text-slate-200">Show</label>
        <select id="ev-filter" name="status" class="input w-auto py-1.5" x-on:change="$el.form.submit()">${options}</select>
        <noscript><button type="submit" class="btn-secondary">Apply</button></noscript>
      </form>
      <div class="table-wrap surface-target" x-data>
        <table class="table-base">
          <thead><tr><th>When</th><th>Title</th><th>Where</th><th>Status</th></tr></thead>
          <tbody>${empty ? `<tr><td colspan="4" class="text-center py-8 text-slate-400">${err ? 'Unavailable.' : filter === 'all' ? 'No events yet.' : 'No ' + FILTERS.find(f => f.key === filter).label.toLowerCase() + ' events.'}</td></tr>` : tbody}</tbody>
        </table>
      </div>`;
    res.send(page({ title: 'Events', body, appConfig, user, activeNav: 'events' }));
  });

  // ── New ─────────────────────────────────────────────────────────────
  async function renderNew(req, res, values, error) {
    const pickers = await loadPickers(db);
    const v = values || { registration_label: 'Register & pay', bens_json: '[]', status: 'draft' };
    const body = `
      <div class="mb-4"><a class="text-sm text-brand-600 hover:underline" href="/events">← Back to events</a></div>
      ${kit.pageHeader('New event', 'Save it first — the flyer and cover image uploads appear once the event exists.')}
      ${flash('error', error)}
      ${kit.dbBanner(pickers.err)}
      <div class="max-w-5xl">${eventForm('/events', v, pickers, true, lt.zoneOf(appConfig))}</div>`;
    res.status(error ? 400 : 200).send(page({ title: 'New event', body, appConfig, user: req.session.user, activeNav: 'events' }));
  }

  router.get('/events/new', requireAdmin, (req, res) => renderNew(req, res, null, null));

  async function writeBeneficiaries(eventId, bens) {
    // Org names are looked up BEFORE the transaction (remote SQLite: no
    // reads inside one).
    const ids = [...new Set(bens.filter(x => x.org_id).map(x => x.org_id))];
    const names = new Map();
    if (ids.length) {
      const rows = await db.allAsync(`SELECT org_id, name FROM organizations WHERE org_id IN (${ids.map(() => '?').join(',')})`, ids);
      for (const r of rows) names.set(Number(r.org_id), r.name);
    }
    await db.transaction(async (tx) => {
      await tx.runAsync('DELETE FROM event_beneficiaries WHERE event_id = ?', [eventId]);
      let sort = 1;
      for (const x of bens) {
        if (x.org_id && !names.has(x.org_id)) continue; // org vanished meanwhile
        await tx.runAsync('INSERT INTO event_beneficiaries (event_id, org_id, name, url, sort) VALUES (?, ?, ?, ?, ?)',
          [eventId, x.org_id || null, x.org_id ? names.get(x.org_id) : x.name, x.org_id ? null : x.url, sort++]);
      }
    });
  }

  router.post('/events', requireAdmin, async (req, res) => {
    const r = readForm(req.body || {}, appConfig);
    if (r.error) return renderNew(req, res, r.values, r.error);
    const f = r.fields;
    try {
      f.slug = await kit.uniqueSlug(db, 'events', 'event_id', f.slug, 0);
      const prevLatest = f.is_latest ? await latest.holder(db, latest.EVENT, 0) : null;
      if (f.is_latest) await latest.take(db, latest.EVENT, 0);
      const now = kit.sqlTime();
      const ins = await db.runAsync(`INSERT INTO events (slug, title, summary, description_md, starts_at, ends_at, venue_name,
          address, city, map_url, registration_url, registration_label, registration_note, beneficiaries_text,
          is_published, status, is_latest, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [f.slug, f.title, f.summary, f.description_md, f.starts_at, f.ends_at, f.venue_name, f.address, f.city,
         f.map_url, f.registration_url, f.registration_label, f.registration_note, f.beneficiaries_text,
         f.is_published, f.status, f.is_latest, now, now]);
      let id = ins && ins.lastID ? Number(ins.lastID) : null;
      if (!id) { const row = await db.getAsync('SELECT event_id FROM events WHERE slug = ?', [f.slug]); id = row && Number(row.event_id); }
      if (r.bens.length) await writeBeneficiaries(id, r.bens);
      console.log(`[events] ${req.session.user.username} created event #${id} (${f.slug})`);
      res.redirect(`/events/${id}?msg=` + encodeURIComponent((f.status === 'published' ? 'Event created and published — it is on the website now.'
        : f.status === 'archived' ? 'Event created as archived.' : 'Event created as a draft.') + latest.message(prevLatest, latest.EVENT) + ' Add the flyer and cover image below.'));
    } catch (err) {
      console.error('[events] create failed:', err);
      renderNew(req, res, r.values, 'Create failed: ' + (err.message || 'unknown error'));
    }
  });

  // ── Edit ────────────────────────────────────────────────────────────
  async function renderEdit(req, res, id, values, error) {
    const user = req.session.user;
    const { value: e, err } = await kit.safeGet(db, `SELECT ${EVENT_COLS} FROM events WHERE event_id = ?`, [id], null);
    if (err || !e) {
      return res.status(err ? 200 : 404).send(page({ title: 'Event', appConfig, user, activeNav: 'events',
        body: `${kit.pageHeader(err ? 'Event' : 'Event not found')}${kit.dbBanner(err)}<p><a class="text-brand-600 hover:underline" href="/events">← Back to events</a></p>` }));
    }
    const bens = await kit.safeAll(db, 'SELECT org_id, name, url, sort FROM event_beneficiaries WHERE event_id = ? ORDER BY sort', [id]);
    const pickers = await loadPickers(db);
    const v = values || valuesFromRow(e, bens.rows, appConfig);
    const base = await kit.webAppPublicUrl(appConfig);
    if (base) preview.allowFramingOf(res, base);
    const status = STATUS_KEYS.includes(e.status) ? e.status : (Number(e.is_published) ? 'published' : 'draft');
    const published = status === 'published';
    const viewLink = base && published
      ? `<a class="btn-secondary" href="${escapeHtml(base + '/events/' + e.slug)}" target="_blank" rel="noopener">View on site <span aria-hidden="true">↗</span></a>`
      : '';
    const actions = `${statusButtons(status)}
      ${preview.previewButton({ endpoint: `/events/${id}/preview`, noun: 'event', base })}
      ${viewLink}
      <form method="POST" action="/events/${id}/delete" class="m-0" x-data
            x-on:submit.prevent="window.uiConfirmSubmit($event.target, ${jsAttrStr('Delete the event "' + e.title + '"? Its flyer and cover image files are deleted too. This cannot be undone.')}, { title: 'Delete event', confirmLabel: 'Delete' })">
        <button type="submit" class="btn-danger">Delete</button>
      </form>`;
    const body = `
      <div class="mb-4"><a class="text-sm text-brand-600 hover:underline" href="/events">← Back to events</a></div>
      ${kit.pageHeader(e.title, `${lt.formatLocal(e.starts_at, appConfig)} · ${STATUSES.find(s => s.key === status).label} — ${STATUSES.find(s => s.key === status).hint}${Number(e.is_latest) ? ' · Latest event (/events/latest)' : ''}`, actions)}
      ${flash('error', error || req.query.error)}
      ${flash('success', req.query.msg)}
      ${kit.dbBanner(bens.err || pickers.err)}
      <div class="max-w-5xl space-y-6">
        <section class="card surface-target card-pad">
          <h2 class="text-sm font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-3">Images</h2>
          <div class="grid md:grid-cols-2 gap-4">
            ${imageSlotCard(id, 'flyer', 'Flyer', 'The full flyer — visitors can open it full size and download it. Upload your own, or generate one.', e.flyer_path,
                flyerMaker(id, e.cover_path, base ? base.replace(/^https?:\/\//, '') + '/events/' + e.slug : ''))}
            ${imageSlotCard(id, 'cover', 'Cover photo', 'Wide photo for the event card and page header (optional).', e.cover_path)}
          </div>
          <p class="mt-3 text-xs text-slate-500 dark:text-slate-400">JPEG, PNG or WebP. Your browser shrinks photos to 1600 px before uploading.</p>
        </section>
        ${eventForm(`/events/${id}`, v, pickers, false, lt.zoneOf(appConfig))}
      </div>`;
    res.status(error ? 400 : 200).send(page({ title: e.title, body, appConfig, user, activeNav: 'events' }));
  }

  router.get('/events/:id', requireAdmin, async (req, res) => {
    const id = kit.idParam(req.params.id);
    if (!id) return res.redirect('/events?error=Invalid+event+id');
    renderEdit(req, res, id, null, null);
  });

  router.post('/events/:id', requireAdmin, async (req, res) => {
    const id = kit.idParam(req.params.id);
    if (!id) return res.redirect('/events?error=Invalid+event+id');
    const r = readForm(req.body || {}, appConfig);
    if (r.error) return renderEdit(req, res, id, r.values, r.error);
    const f = r.fields;
    try {
      const exists = await db.getAsync('SELECT event_id FROM events WHERE event_id = ?', [id]);
      if (!exists) return res.redirect('/events?error=Event+not+found');
      f.slug = await kit.uniqueSlug(db, 'events', 'event_id', f.slug, id);
      // Latest is one event only: clear it elsewhere before setting it here.
      const prevLatest = f.is_latest ? await latest.holder(db, latest.EVENT, id) : null;
      if (f.is_latest) await latest.take(db, latest.EVENT, id);
      await db.runAsync(`UPDATE events SET slug = ?, title = ?, summary = ?, description_md = ?, starts_at = ?, ends_at = ?,
          venue_name = ?, address = ?, city = ?, map_url = ?, registration_url = ?, registration_label = ?,
          registration_note = ?, beneficiaries_text = ?, is_published = ?, status = ?, is_latest = ?, updated_at = ? WHERE event_id = ?`,
        [f.slug, f.title, f.summary, f.description_md, f.starts_at, f.ends_at, f.venue_name, f.address, f.city,
         f.map_url, f.registration_url, f.registration_label, f.registration_note, f.beneficiaries_text,
         f.is_published, f.status, f.is_latest, kit.sqlTime(), id]);
      await writeBeneficiaries(id, r.bens);
      const msg = !req.body.set_status ? 'Event saved.'
        : f.status === 'published' ? 'Saved and published — it is on the website now.'
        : f.status === 'archived' ? 'Saved and archived — it is off the website, kept here for reference.'
        : 'Saved as a draft — it is not on the website.';
      res.redirect(`/events/${id}?msg=` + encodeURIComponent(msg + latest.message(prevLatest, latest.EVENT)));
    } catch (err) {
      console.error('[events] update failed:', err);
      renderEdit(req, res, id, r.values, 'Save failed: ' + (err.message || 'unknown error'));
    }
  });

  // A fresh preview link (replaces any earlier one for this event).
  router.post('/events/:id/preview', requireAdmin, async (req, res) => {
    const id = kit.idParam(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid event id' });
    const r = await preview.makePreviewLink(db, appConfig, { table: 'events', idCol: 'event_id', id, path: '/events' });
    res.status(r.status).json(r.body);
  });

  router.post('/events/:id/delete', requireAdmin, async (req, res) => {
    const id = kit.idParam(req.params.id);
    if (!id) return res.redirect('/events?error=Invalid+event+id');
    try {
      const e = await db.getAsync('SELECT event_id, title, flyer_path, cover_path FROM events WHERE event_id = ?', [id]);
      if (!e) return res.redirect('/events?error=Event+not+found');
      await db.transaction(async (tx) => {
        await tx.runAsync('DELETE FROM event_beneficiaries WHERE event_id = ?', [id]);
        await tx.runAsync('DELETE FROM events WHERE event_id = ?', [id]);
      });
      await uploads.removeFiles(appConfig, [e.flyer_path, e.cover_path]);
      console.log(`[events] ${req.session.user.username} deleted event #${id} (${e.title})`);
      res.redirect('/events?msg=' + encodeURIComponent(`Event "${e.title}" deleted.`));
    } catch (err) {
      console.error('[events] delete failed:', err);
      res.redirect(`/events/${id}?error=` + encodeURIComponent('Delete failed: ' + (err.message || err)));
    }
  });

  // ── Flyer / cover ───────────────────────────────────────────────────
  router.post('/events/:id/image/:slot', requireAdmin, kit.withImage((req) => `/events/${encodeURIComponent(req.params.id)}`, async (req, res) => {
    const id = kit.idParam(req.params.id);
    const col = SLOTS[req.params.slot];
    const back = `/events/${id}`;
    if (!id || !col) return kit.reply(req, res, '/events', false, 'Unknown image slot.');
    const e = await db.getAsync(`SELECT event_id, ${col} AS old FROM events WHERE event_id = ?`, [id]);
    if (!e) return kit.reply(req, res, '/events', false, 'Event not found.');
    let saved;
    try { saved = await uploads.saveImage(appConfig, 'events', req.file && req.file.buffer); }
    catch (err) { return kit.reply(req, res, back, false, err.message || 'Upload failed'); }
    try {
      await db.runAsync(`UPDATE events SET ${col} = ?, updated_at = ? WHERE event_id = ?`, [saved.rel, kit.sqlTime(), id]);
    } catch (err) {
      await uploads.removeFiles(appConfig, saved.rel);
      return kit.reply(req, res, back, false, 'Saving failed: ' + (err.message || err));
    }
    if (e.old && e.old !== saved.rel) await uploads.removeFiles(appConfig, e.old);
    kit.reply(req, res, back, true, `${req.params.slot === 'flyer' ? 'Flyer' : 'Cover photo'} uploaded.`);
  }));

  router.post('/events/:id/image/:slot/remove', requireAdmin, async (req, res) => {
    const id = kit.idParam(req.params.id);
    const col = SLOTS[req.params.slot];
    if (!id || !col) return res.redirect('/events?error=Unknown+image');
    try {
      const e = await db.getAsync(`SELECT ${col} AS old FROM events WHERE event_id = ?`, [id]);
      if (!e) return res.redirect('/events?error=Event+not+found');
      await db.runAsync(`UPDATE events SET ${col} = NULL, updated_at = ? WHERE event_id = ?`, [kit.sqlTime(), id]);
      await uploads.removeFiles(appConfig, e.old);
      res.redirect(`/events/${id}?msg=Image+removed.`);
    } catch (err) {
      res.redirect(`/events/${id}?error=` + encodeURIComponent('Remove failed: ' + (err.message || err)));
    }
  });

  return router;
};

module.exports.markdownField = markdownField;
module.exports.TEXTAREA_CLS = TEXTAREA_CLS;
