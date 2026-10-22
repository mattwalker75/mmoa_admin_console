// routes/raffles.js — the website's raffles (the web app's `raffles` +
// `raffle_images` tables).
//
//   GET  /raffles?status=all|draft|published|archived → list ("Show" filter)
//   GET  /raffles/new                      → blank form
//   POST /raffles                          → create
//   GET  /raffles/:id                      → edit form, stage card, images
//   POST /raffles/:id                      → save (incl. visibility; the
//                                            Draft / Published / Archived
//                                            buttons submit it with set_status)
//   POST /raffles/:id/status               → stage: open → closed → drawn (or
//                                            one step back); drawn needs the
//                                            winning ticket number
//   POST /raffles/:id/preview              → JSON { url } (helpers/sitePreview)
//   POST /raffles/:id/delete               → delete row, prize photos, files
//   POST /raffles/:id/flyer                → upload the flyer (multipart "image")
//   POST /raffles/:id/flyer/remove
//   POST /raffles/:id/images               → add a prize photo (≤ 8), field "alt"
//   POST /raffles/:id/images/:imageId/move → dir=up|down
//   POST /raffles/:id/images/:imageId/delete
//
// Raffle tickets are sold IN PERSON only (Texas law), so there is no payment
// link — `how_to_buy` carries the standard wording. Claim requirements are a
// newline-separated list; the Firearm / Standard buttons fill the textarea
// from the presets below (still editable). `claim_preset` is derived on save:
// 'firearm' / 'standard' when the list matches that preset exactly,
// otherwise 'custom'. The web app shows winning_ticket only once status is
// 'drawn'.
//
// Two separate settings, as on the website:
//   visibility  draft | published | archived (helpers/visibility.js, same as
//               events) — only published raffles are on the website;
//               is_published is kept in step as a legacy mirror.
//   status      the STAGE: open (selling tickets) → closed (sales ended) →
//               drawn (winner announced). Stepped in ANY visibility, so a
//               draft can be previewed in each stage before publishing.
// Latest (is_latest): one raffle at a time is also served at /raffles/latest
// while published (helpers/latest.js, same as events); 'latest' is reserved
// as a slug.

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
const { markdownField, TEXTAREA_CLS } = require('./events');

// Stages (raffles.status). 'draft' is only a legacy value — the web app
// turns it into visibility draft + stage open when it starts.
const STAGES = ['open', 'closed', 'drawn'];
const STATUS_LABEL = { draft: 'Draft (old)', open: 'Open — selling tickets', closed: 'Closed — sales ended', drawn: 'Drawn — winner announced' };
const STATUS_PILL = { draft: 'pill-terminated', open: 'pill-running', closed: 'pill-pending', drawn: 'pill-failed' };
const MAX_IMAGES = 8;

const HOW_TO_BUY_DEFAULT = "Tickets are sold in person only — from any MMoA member or at our booth at upcoming events. Texas law doesn't allow raffle tickets to be sold online.";

const PRESETS = {
  firearm: [
    'Be the person named on the winning ticket and claim the prize in person',
    'Be of legal age to purchase this firearm (18+ for rifles and shotguns, 21+ for handguns)',
    'Show a valid government-issued photo ID',
    'Complete the transfer through a licensed FFL dealer and pass the federal NICS background check',
    'Not be prohibited by law from owning a firearm',
    'Claim the prize within 30 days of the drawing'
  ],
  standard: [
    'Claim within 30 days of the drawing',
    'Show a valid photo ID',
    'Need not be present to win'
  ]
};

function normLines(s) {
  return String(s || '').replace(/\r\n?/g, '\n').split('\n').map(x => x.trim()).filter(Boolean);
}
function presetOf(text) {
  const lines = normLines(text);
  for (const k of Object.keys(PRESETS)) {
    if (lines.length === PRESETS[k].length && lines.every((l, i) => l === PRESETS[k][i])) return k;
  }
  return 'custom';
}

const RAFFLE_COLS = `raffle_id, slug, title, prize_description_md, flyer_path, total_tickets, ticket_price_text,
  drawing_at, drawing_location, how_to_buy, claim_requirements, claim_preset, beneficiary_org_id,
  beneficiary_text, status, visibility, is_latest, winning_ticket, is_published, created_at, updated_at`;

function readForm(b, appConfig) {
  const values = {
    title: b.title || '', slug: b.slug || '', prize_description_md: b.prize_description_md || '',
    total_tickets: b.total_tickets || '', ticket_price_text: b.ticket_price_text || '',
    drawing_local: b.drawing_at || '', drawing_location: b.drawing_location || '',
    how_to_buy: b.how_to_buy || '', claim_requirements: b.claim_requirements || '',
    beneficiary_org_id: b.beneficiary_org_id || '', beneficiary_text: b.beneficiary_text || '',
    visibility: vis.fromForm(b, 'visibility'),
    is_latest: kit.yes(b.is_latest), item_id: b._item_id || ''
  };
  const fail = (error) => ({ values, error });
  const title = kit.str(b.title, 200);
  if (!title) return fail('Title is required.');
  const slugIn = kit.str(b.slug, 80);
  let slug = slugIn ? kit.slugify(slugIn) : kit.slugify(title);
  if (!slug || !kit.SLUG_RE.test(slug)) return fail('The URL slug may only contain lowercase letters, digits and dashes.');
  // /raffles/latest is the Latest raffle's address, so no raffle may own it.
  const lc = latest.slugCheck(slug, slugIn, latest.RAFFLE);
  if (lc.error) return fail(lc.error);
  slug = lc.slug;
  let total = null;
  if (kit.str(b.total_tickets)) {
    total = parseInt(b.total_tickets, 10);
    if (!Number.isInteger(total) || total < 1 || total > 1000000 || String(total) !== String(b.total_tickets).trim()) return fail('Total tickets must be a whole number (or blank).');
  }
  const drawing = lt.localInputToUtc(b.drawing_at, appConfig);
  if (drawing === undefined) return fail('The drawing date/time is not valid.');
  const claims = normLines(b.claim_requirements).join('\n');
  return {
    values,
    fields: {
      slug, title,
      prize_description_md: kit.str(b.prize_description_md, 20000),
      total_tickets: total,
      ticket_price_text: kit.str(b.ticket_price_text, 200),
      drawing_at: drawing || null,
      drawing_location: kit.str(b.drawing_location, 300),
      how_to_buy: kit.str(b.how_to_buy, 4000) || HOW_TO_BUY_DEFAULT,
      claim_requirements: claims || null,
      claim_preset: claims ? presetOf(claims) : null,
      beneficiary_org_id: kit.idParam(b.beneficiary_org_id),
      beneficiary_text: kit.str(b.beneficiary_text, 500),
      visibility: values.visibility,
      is_published: values.visibility === 'published' ? 1 : 0,
      is_latest: values.is_latest ? 1 : 0
    }
  };
}

function valuesFromRow(r, appConfig) {
  return {
    title: r.title || '', slug: r.slug || '', prize_description_md: r.prize_description_md || '',
    total_tickets: r.total_tickets == null ? '' : String(r.total_tickets), ticket_price_text: r.ticket_price_text || '',
    drawing_local: lt.utcToLocalInput(r.drawing_at, appConfig), drawing_location: r.drawing_location || '',
    how_to_buy: r.how_to_buy || '', claim_requirements: r.claim_requirements || '',
    beneficiary_org_id: r.beneficiary_org_id ? String(r.beneficiary_org_id) : '', beneficiary_text: r.beneficiary_text || '',
    visibility: vis.KEYS.includes(r.visibility) ? r.visibility : 'draft',
    is_latest: !!Number(r.is_latest), item_id: String(r.raffle_id)
  };
}

function raffleForm(action, v, orgs, isNew, zone, latestHolder) {
  const val = (k) => escapeHtml(v[k] || '');
  const orgOpts = orgs.map(o => `<option value="${Number(o.org_id)}" ${String(o.org_id) === String(v.beneficiary_org_id) ? 'selected' : ''}>${escapeHtml(o.name)}${o.verification_status === 'verified' ? '' : ' (' + escapeHtml(o.verification_status) + ')'}</option>`).join('');
  return `<form id="rf-form" method="POST" action="${action}" class="space-y-6" x-data x-on:input="window.mmoaFormDirty = true">
    <section class="card surface-target card-pad space-y-4">
      <h2 class="text-sm font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">Raffle</h2>
      <div class="grid sm:grid-cols-2 gap-4">
        <div class="sm:col-span-2"><label class="label" for="rf-title">Title *</label>
          <input id="rf-title" class="input" type="text" name="title" required maxlength="200" value="${val('title')}" placeholder="e.g. Browning BPS 12-gauge shotgun raffle"></div>
        <div><label class="label" for="rf-slug">URL slug</label>
          <input id="rf-slug" class="input font-mono" type="text" name="slug" maxlength="80" pattern="[a-z0-9-]*" value="${val('slug')}" placeholder="made from the title when blank">
          <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">The page address: <code>/raffles/&lt;slug&gt;</code>.</p>
          ${latest.field(v, latestHolder, latest.RAFFLE)}</div>
        <div><label class="label" for="rf-price">Ticket price</label>
          <input id="rf-price" class="input" type="text" name="ticket_price_text" maxlength="200" value="${val('ticket_price_text')}" placeholder="$20 each or 6 for $100"></div>
        <div><label class="label" for="rf-total">Total tickets <span class="text-xs font-normal text-slate-400">(optional)</span></label>
          <input id="rf-total" class="input" type="number" min="1" step="1" name="total_tickets" value="${val('total_tickets')}"></div>
        <div><label class="label" for="rf-draw">Drawing date &amp; time <span class="text-xs font-normal text-slate-400">(${escapeHtml(zone)})</span></label>
          <input id="rf-draw" class="input" type="datetime-local" name="drawing_at" value="${val('drawing_local')}"></div>
        <div class="sm:col-span-2"><label class="label" for="rf-drawloc">Drawing location</label>
          <input id="rf-drawloc" class="input" type="text" name="drawing_location" maxlength="300" value="${val('drawing_location')}" placeholder="e.g. Live at the Coyote Cruisers Car &amp; Bike Show"></div>
      </div>
      ${markdownField('prize_description_md', 'Prize description', v.prize_description_md, 8)}
    </section>

    <section class="card surface-target card-pad space-y-4">
      <h2 class="text-sm font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">Tickets &amp; claiming the prize</h2>
      <div><label class="label" for="rf-how">How to buy</label>
        <textarea id="rf-how" name="how_to_buy" rows="3" maxlength="4000" class="${TEXTAREA_CLS}">${escapeHtml(v.how_to_buy || HOW_TO_BUY_DEFAULT)}</textarea>
        <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">Texas law doesn't allow raffle tickets to be sold online — keep this to in-person sales.</p></div>
      <div data-presets="${escapeHtml(JSON.stringify({ firearm: PRESETS.firearm.join('\n'), standard: PRESETS.standard.join('\n') }))}"
           x-data="{ presets: {}, init() { this.presets = JSON.parse(this.$el.dataset.presets); },
             async fill(k) {
               const ta = this.$refs.claims;
               if (ta.value.trim() && ta.value.trim() !== this.presets[k] && !(await window.uiConfirm('Replace the current requirements with the ' + k + ' preset?', { title: 'Use preset', confirmLabel: 'Replace', danger: false }))) return;
               ta.value = this.presets[k];
             } }">
        <div class="flex items-center justify-between gap-2 flex-wrap">
          <label class="label mb-0" for="rf-claims">Claim requirements <span class="text-xs font-normal text-slate-400">(one per line)</span></label>
          <div class="flex items-center gap-2">
            <button type="button" class="btn-secondary text-xs px-3 py-1" x-on:click="fill('firearm')">Firearm preset</button>
            <button type="button" class="btn-secondary text-xs px-3 py-1" x-on:click="fill('standard')">Standard preset</button>
          </div>
        </div>
        <textarea id="rf-claims" x-ref="claims" name="claim_requirements" rows="7" maxlength="4000" class="mt-2 ${TEXTAREA_CLS}">${escapeHtml(v.claim_requirements || '')}</textarea>
      </div>
    </section>

    <section class="card surface-target card-pad space-y-4">
      <h2 class="text-sm font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">Who it benefits</h2>
      <div class="grid sm:grid-cols-2 gap-4">
        <div><label class="label" for="rf-benorg">Directory organization</label>
          <select id="rf-benorg" class="input" name="beneficiary_org_id"><option value="">— None —</option>${orgOpts}</select></div>
        <div><label class="label" for="rf-bentext">Or describe it</label>
          <input id="rf-bentext" class="input" type="text" name="beneficiary_text" maxlength="500" value="${val('beneficiary_text')}" placeholder="e.g. Proceeds support Coyote Packs"></div>
      </div>
    </section>

    <div class="flex items-center justify-between gap-4 flex-wrap">
      ${vis.switcher(v.visibility || 'draft', { formId: 'rf-form', noun: 'raffle', field: 'visibility' })}
      <div class="flex items-center gap-2">
        <a href="/raffles" class="btn-secondary">Cancel</a>
        <button type="submit" class="btn-primary">${isNew ? 'Create raffle' : 'Save changes'}</button>
      </div>
    </div>
  </form>`;
}

function statusCard(r) {
  const id = Number(r.raffle_id);
  const i = STAGES.indexOf(r.status);
  const next = STAGES[i + 1];
  const prev = STAGES[i - 1];
  const steps = STAGES.map((s, k) => `<li class="flex items-center gap-2 ${k <= i ? 'text-slate-900 dark:text-slate-100 font-semibold' : 'text-slate-400'}">
      <span class="inline-flex h-6 w-6 items-center justify-center rounded-full text-xs ${k < i ? 'bg-emerald-500 text-white' : k === i ? 'bg-brand-600 text-white' : 'bg-slate-200 dark:bg-slate-700'}">${k + 1}</span>${escapeHtml(STATUS_LABEL[s])}</li>`).join('');
  let forward = '';
  if (next === 'drawn') {
    forward = `<form method="POST" action="/raffles/${id}/status" class="m-0 flex items-end gap-2 flex-wrap">
        <input type="hidden" name="status" value="drawn">
        <div><label class="label" for="rf-win">Winning ticket number *</label>
          <input id="rf-win" class="input max-w-[12rem]" type="text" name="winning_ticket" required maxlength="100"></div>
        <button type="submit" class="btn-primary">Mark drawn</button>
      </form>`;
  } else if (next) {
    forward = `<form method="POST" action="/raffles/${id}/status" class="m-0">
        <input type="hidden" name="status" value="${next}">
        <button type="submit" class="btn-primary">${next === 'open' ? 'Open ticket sales' : 'Close ticket sales'}</button>
      </form>`;
  }
  const back = prev ? `<form method="POST" action="/raffles/${id}/status" class="m-0" x-data
        x-on:submit.prevent="window.uiConfirmSubmit($event.target, ${jsAttrStr('Move this raffle back to "' + STATUS_LABEL[prev] + '"?' + (r.status === 'drawn' ? ' The winning ticket number is cleared.' : ''))}, { title: 'Step back', confirmLabel: 'Move back', danger: false })">
        <input type="hidden" name="status" value="${prev}">
        <button type="submit" class="btn-secondary">← Back to ${escapeHtml(prev)}</button>
      </form>` : '';
  return `<section class="card surface-target card-pad">
    <h2 class="text-sm font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">Stage</h2>
    <p class="mt-0.5 mb-3 text-xs text-slate-500 dark:text-slate-400">Where the raffle is in its life. Works whatever the status (Draft / Published / Archived) — step a draft through each stage and use Preview to check how the page looks.</p>
    <ol class="flex flex-wrap gap-x-6 gap-y-2 text-sm">${steps}</ol>
    ${r.status === 'drawn' ? `<p class="mt-3 text-sm">Winning ticket: <strong class="font-mono">${escapeHtml(r.winning_ticket || '—')}</strong></p>` : ''}
    <div class="mt-4 flex items-end gap-3 flex-wrap">${forward}${back}</div>
  </section>`;
}

function imagesCard(r, images) {
  const id = Number(r.raffle_id);
  const tiles = images.map((im, k) => `
    <div class="rounded-lg border border-slate-200 dark:border-slate-700 p-2 space-y-2">
      <a href="/wa-uploads/${escapeHtml(im.path)}" target="_blank" rel="noopener">${kit.uploadImg(im.path, im.alt, 'h-32 w-full rounded object-cover')}</a>
      <div class="text-xs text-slate-500 dark:text-slate-400 truncate" title="${escapeHtml(im.alt || '')}">${escapeHtml(im.alt || '(no alt text)')}</div>
      <div class="flex items-center justify-between gap-1">
        <div class="flex gap-1">
          <form method="POST" action="/raffles/${id}/images/${Number(im.image_id)}/move" class="m-0"><input type="hidden" name="dir" value="up">
            <button type="submit" class="btn-ghost text-xs px-2 py-1" ${k === 0 ? 'disabled' : ''} aria-label="Move earlier">◀</button></form>
          <form method="POST" action="/raffles/${id}/images/${Number(im.image_id)}/move" class="m-0"><input type="hidden" name="dir" value="down">
            <button type="submit" class="btn-ghost text-xs px-2 py-1" ${k === images.length - 1 ? 'disabled' : ''} aria-label="Move later">▶</button></form>
        </div>
        <form method="POST" action="/raffles/${id}/images/${Number(im.image_id)}/delete" class="m-0" x-data
              x-on:submit.prevent="window.uiConfirmSubmit($event.target, 'Delete this prize photo? The file is deleted from the Web App.', { title: 'Delete photo', confirmLabel: 'Delete' })">
          <button type="submit" class="btn-danger text-xs px-2 py-1">Delete</button></form>
      </div>
    </div>`).join('');
  return `<div>
    <div class="flex items-center justify-between gap-2"><div class="text-sm font-semibold text-slate-900 dark:text-slate-100">Prize photos <span class="font-normal text-slate-400">(${images.length} of ${MAX_IMAGES})</span></div></div>
    <div class="mt-3 grid grid-cols-2 md:grid-cols-4 gap-3">${tiles || '<p class="col-span-full text-sm text-slate-400 italic">No prize photos yet.</p>'}</div>
    <div class="mt-3">${images.length < MAX_IMAGES ? kit.uploadForm(`/raffles/${id}/images`, 'Add photo', { alt: true }) : '<p class="text-xs text-slate-500">Maximum reached — delete one to add another.</p>'}</div>
  </div>`;
}

module.exports = function (db, appConfig) {
  const router = express.Router();

  // The raffle currently marked Latest (for the form's note), or null.
  async function currentLatest() {
    const { value } = await kit.safeGet(db, 'SELECT raffle_id AS id, title FROM raffles WHERE is_latest = 1 ORDER BY raffle_id DESC LIMIT 1', [], null);
    return value;
  }

  async function loadOrgs() {
    return kit.safeAll(db, 'SELECT org_id, name, verification_status FROM organizations ORDER BY LOWER(name)', []);
  }

  router.get('/raffles', requireAdmin, async (req, res) => {
    const user = req.session.user;
    const filter = vis.KEYS.includes(req.query.status) ? req.query.status : 'all';
    const { rows, err } = await kit.safeAll(db,
      `SELECT raffle_id, slug, title, status, visibility, is_latest, drawing_at, ticket_price_text, flyer_path, winning_ticket FROM raffles
        ${filter === 'all' ? '' : 'WHERE visibility = ?'} ORDER BY (drawing_at IS NULL), drawing_at DESC, raffle_id DESC`,
      filter === 'all' ? [] : [filter]);
    const counts = await kit.safeAll(db, 'SELECT visibility, COUNT(*) AS c FROM raffles GROUP BY visibility', []);
    const cnt = {}; let total = 0;
    for (const c of counts.rows) { cnt[c.visibility] = Number(c.c); total += Number(c.c); }
    // "Show" drop-down (same as Events): All + Draft / Published / Archived, with counts.
    const opt = (key, label, n) => `<option value="${key}" ${key === filter ? 'selected' : ''}>${label} (${n || 0})</option>`;
    const options = opt('all', 'All', total) + vis.VISIBILITY.map(v => opt(v.key, v.label, cnt[v.key])).join('');
    const tbody = rows.map(r => `
      <tr class="cursor-pointer" data-href="/raffles/${Number(r.raffle_id)}" x-on:click="window.location = $el.dataset.href">
        <td class="font-medium text-slate-900 dark:text-slate-100"><a class="hover:underline" href="/raffles/${Number(r.raffle_id)}">${escapeHtml(r.title)}</a>
          <div class="font-mono text-xs text-slate-400">/raffles/${escapeHtml(r.slug)}</div></td>
        <td>${vis.pill(r.visibility)}${Number(r.is_latest) ? ' <span class="pill-running" title="Also at /raffles/latest">Latest</span>' : ''}</td>
        <td><span class="${STATUS_PILL[r.status] || 'pill'}">${escapeHtml(r.status)}</span>${r.status === 'drawn' && r.winning_ticket ? ` <span class="text-xs text-slate-500">#${escapeHtml(r.winning_ticket)}</span>` : ''}</td>
        <td class="whitespace-nowrap text-xs text-slate-500">${escapeHtml(lt.formatLocal(r.drawing_at, appConfig) || '—')}</td>
        <td class="text-xs">${escapeHtml(r.ticket_price_text || '—')}</td>
      </tr>`).join('');
    const body = `
      ${kit.pageHeader('Raffles', 'Only Published raffles are on the website. Tickets are sold in person only.',
        `<a href="/raffles/new" class="btn-primary"><span aria-hidden="true">＋</span><span>New raffle</span></a>`)}
      ${flash('error', req.query.error)}
      ${flash('success', req.query.msg)}
      ${kit.dbBanner(err || counts.err)}
      <form method="GET" action="/raffles" class="mb-4 flex items-center gap-2" x-data>
        <label for="rf-filter" class="text-sm font-semibold text-slate-700 dark:text-slate-200">Show</label>
        <select id="rf-filter" name="status" class="input w-auto py-1.5" x-on:change="$el.form.submit()">${options}</select>
        <noscript><button type="submit" class="btn-secondary">Apply</button></noscript>
      </form>
      <div class="table-wrap surface-target" x-data>
        <table class="table-base">
          <thead><tr><th>Title</th><th>Status</th><th>Stage</th><th>Drawing</th><th>Price</th></tr></thead>
          <tbody>${tbody || `<tr><td colspan="5" class="text-center py-8 text-slate-400">${err ? 'Unavailable.' : filter === 'all' ? 'No raffles yet.' : 'No ' + filter + ' raffles.'}</td></tr>`}</tbody>
        </table>
      </div>`;
    res.send(page({ title: 'Raffles', body, appConfig, user, activeNav: 'raffles' }));
  });

  async function renderNew(req, res, values, error) {
    const orgs = await loadOrgs();
    const v = values || { how_to_buy: HOW_TO_BUY_DEFAULT, visibility: 'draft' };
    const body = `
      <div class="mb-4"><a class="text-sm text-brand-600 hover:underline" href="/raffles">← Back to raffles</a></div>
      ${kit.pageHeader('New raffle', 'Starts as a draft in the Open stage. Save it first — the flyer and prize photo uploads appear once it exists.')}
      ${flash('error', error)}
      ${kit.dbBanner(orgs.err)}
      <div class="max-w-5xl">${raffleForm('/raffles', v, orgs.rows, true, lt.zoneOf(appConfig), await currentLatest())}</div>`;
    res.status(error ? 400 : 200).send(page({ title: 'New raffle', body, appConfig, user: req.session.user, activeNav: 'raffles' }));
  }

  router.get('/raffles/new', requireAdmin, (req, res) => renderNew(req, res, null, null));

  router.post('/raffles', requireAdmin, async (req, res) => {
    const r = readForm(req.body || {}, appConfig);
    if (r.error) return renderNew(req, res, r.values, r.error);
    const f = r.fields;
    try {
      f.slug = await kit.uniqueSlug(db, 'raffles', 'raffle_id', f.slug, 0);
      const prevLatest = f.is_latest ? await latest.holder(db, latest.RAFFLE, 0) : null;
      if (f.is_latest) await latest.take(db, latest.RAFFLE, 0);
      const now = kit.sqlTime();
      const ins = await db.runAsync(`INSERT INTO raffles (slug, title, prize_description_md, total_tickets, ticket_price_text,
          drawing_at, drawing_location, how_to_buy, claim_requirements, claim_preset, beneficiary_org_id, beneficiary_text,
          status, visibility, is_published, is_latest, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?)`,
        [f.slug, f.title, f.prize_description_md, f.total_tickets, f.ticket_price_text, f.drawing_at, f.drawing_location,
         f.how_to_buy, f.claim_requirements, f.claim_preset, f.beneficiary_org_id, f.beneficiary_text, f.visibility, f.is_published, f.is_latest, now, now]);
      let id = ins && ins.lastID ? Number(ins.lastID) : null;
      if (!id) { const row = await db.getAsync('SELECT raffle_id FROM raffles WHERE slug = ?', [f.slug]); id = row && Number(row.raffle_id); }
      console.log(`[raffles] ${req.session.user.username} created raffle #${id} (${f.slug})`);
      res.redirect(`/raffles/${id}?msg=` + encodeURIComponent((f.visibility === 'published' ? 'Raffle created and published — it is on the website now (stage: open).'
        : f.visibility === 'archived' ? 'Raffle created as archived.' : 'Raffle created as a draft (stage: open).') + latest.message(prevLatest, latest.RAFFLE) + ' Add the flyer and prize photos below.'));
    } catch (err) {
      console.error('[raffles] create failed:', err);
      renderNew(req, res, r.values, 'Create failed: ' + (err.message || 'unknown error'));
    }
  });

  async function renderEdit(req, res, id, values, error) {
    const user = req.session.user;
    const { value: r, err } = await kit.safeGet(db, `SELECT ${RAFFLE_COLS} FROM raffles WHERE raffle_id = ?`, [id], null);
    if (err || !r) {
      return res.status(err ? 200 : 404).send(page({ title: 'Raffle', appConfig, user, activeNav: 'raffles',
        body: `${kit.pageHeader(err ? 'Raffle' : 'Raffle not found')}${kit.dbBanner(err)}<p><a class="text-brand-600 hover:underline" href="/raffles">← Back to raffles</a></p>` }));
    }
    const images = await kit.safeAll(db, 'SELECT image_id, path, alt, sort FROM raffle_images WHERE raffle_id = ? ORDER BY sort, image_id', [id]);
    const orgs = await loadOrgs();
    const v = values || valuesFromRow(r, appConfig);
    const base = await kit.webAppPublicUrl(appConfig);
    if (base) preview.allowFramingOf(res, base);
    const visibility = vis.KEYS.includes(r.visibility) ? r.visibility : 'draft';
    const visInfo = vis.VISIBILITY.find(x => x.key === visibility);
    const viewLink = base && visibility === 'published'
      ? `<a class="btn-secondary" href="${escapeHtml(base + '/raffles/' + r.slug)}" target="_blank" rel="noopener">View on site <span aria-hidden="true">↗</span></a>` : '';
    const actions = `${vis.buttons(visibility, { formId: 'rf-form', noun: 'raffle' })}
      ${preview.previewButton({ endpoint: `/raffles/${id}/preview`, noun: 'raffle', base })}
      ${viewLink}
      <form method="POST" action="/raffles/${id}/delete" class="m-0" x-data
            x-on:submit.prevent="window.uiConfirmSubmit($event.target, ${jsAttrStr('Delete the raffle "' + r.title + '"? Its flyer and prize photo files are deleted too. This cannot be undone.')}, { title: 'Delete raffle', confirmLabel: 'Delete' })">
        <button type="submit" class="btn-danger">Delete</button>
      </form>`;
    const body = `
      <div class="mb-4"><a class="text-sm text-brand-600 hover:underline" href="/raffles">← Back to raffles</a></div>
      ${kit.pageHeader(r.title, `${visInfo.label} — ${visInfo.hint} · Stage: ${STATUS_LABEL[r.status] || r.status}${Number(r.is_latest) ? ' · Latest raffle (/raffles/latest)' : ''}`, actions)}
      ${flash('error', error || req.query.error)}
      ${flash('success', req.query.msg)}
      ${kit.dbBanner(images.err || orgs.err)}
      <div class="max-w-5xl space-y-6">
        ${statusCard(r)}
        <section class="card surface-target card-pad space-y-6">
          <h2 class="text-sm font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">Images</h2>
          <div class="rounded-lg border border-slate-200 dark:border-slate-700 p-3 space-y-2">
            <div class="flex items-center justify-between gap-2">
              <div class="text-sm font-semibold text-slate-900 dark:text-slate-100">Flyer</div>
              ${r.flyer_path ? `<form method="POST" action="/raffles/${id}/flyer/remove" class="m-0" x-data
                  x-on:submit.prevent="window.uiConfirmSubmit($event.target, 'Remove the flyer? The file is deleted from the Web App.', { title: 'Remove flyer', confirmLabel: 'Remove' })">
                  <button type="submit" class="btn-danger text-xs px-3 py-1">Remove</button></form>` : ''}
            </div>
            ${r.flyer_path ? `<a href="/wa-uploads/${escapeHtml(r.flyer_path)}" target="_blank" rel="noopener">${kit.uploadImg(r.flyer_path, 'Flyer', 'max-h-48 w-auto rounded-lg border border-slate-200 dark:border-slate-700')}</a>` : '<p class="text-sm text-slate-400 italic">None yet.</p>'}
            ${kit.uploadForm(`/raffles/${id}/flyer`, r.flyer_path ? 'Replace' : 'Upload')}
          </div>
          ${imagesCard(r, images.rows)}
          <p class="text-xs text-slate-500 dark:text-slate-400">JPEG, PNG or WebP. Your browser shrinks photos to 1600 px before uploading.</p>
        </section>
        ${raffleForm(`/raffles/${id}`, v, orgs.rows, false, lt.zoneOf(appConfig), await currentLatest())}
      </div>`;
    res.status(error ? 400 : 200).send(page({ title: r.title, body, appConfig, user, activeNav: 'raffles' }));
  }

  router.get('/raffles/:id', requireAdmin, (req, res) => {
    const id = kit.idParam(req.params.id);
    if (!id) return res.redirect('/raffles?error=Invalid+raffle+id');
    renderEdit(req, res, id, null, null);
  });

  router.post('/raffles/:id', requireAdmin, async (req, res) => {
    const id = kit.idParam(req.params.id);
    if (!id) return res.redirect('/raffles?error=Invalid+raffle+id');
    const r = readForm(req.body || {}, appConfig);
    if (r.error) return renderEdit(req, res, id, r.values, r.error);
    const f = r.fields;
    try {
      const exists = await db.getAsync('SELECT raffle_id FROM raffles WHERE raffle_id = ?', [id]);
      if (!exists) return res.redirect('/raffles?error=Raffle+not+found');
      f.slug = await kit.uniqueSlug(db, 'raffles', 'raffle_id', f.slug, id);
      // Latest is one raffle only: clear it elsewhere before setting it here.
      const prevLatest = f.is_latest ? await latest.holder(db, latest.RAFFLE, id) : null;
      if (f.is_latest) await latest.take(db, latest.RAFFLE, id);
      await db.runAsync(`UPDATE raffles SET slug = ?, title = ?, prize_description_md = ?, total_tickets = ?, ticket_price_text = ?,
          drawing_at = ?, drawing_location = ?, how_to_buy = ?, claim_requirements = ?, claim_preset = ?,
          beneficiary_org_id = ?, beneficiary_text = ?, visibility = ?, is_published = ?, is_latest = ?, updated_at = ? WHERE raffle_id = ?`,
        [f.slug, f.title, f.prize_description_md, f.total_tickets, f.ticket_price_text, f.drawing_at, f.drawing_location,
         f.how_to_buy, f.claim_requirements, f.claim_preset, f.beneficiary_org_id, f.beneficiary_text, f.visibility, f.is_published,
         f.is_latest, kit.sqlTime(), id]);
      const msg = !req.body.set_status ? 'Raffle saved.'
        : f.visibility === 'published' ? 'Saved and published — it is on the website now.'
        : f.visibility === 'archived' ? 'Saved and archived — it is off the website, kept here for reference.'
        : 'Saved as a draft — it is not on the website.';
      res.redirect(`/raffles/${id}?msg=` + encodeURIComponent(msg + latest.message(prevLatest, latest.RAFFLE)));
    } catch (err) {
      console.error('[raffles] update failed:', err);
      renderEdit(req, res, id, r.values, 'Save failed: ' + (err.message || 'unknown error'));
    }
  });

  // Status workflow: one step forward or back at a time. The current status
  // is part of the UPDATE's WHERE clause, so a stale page (or a double
  // click) can't skip a step.
  router.post('/raffles/:id/status', requireAdmin, async (req, res) => {
    const id = kit.idParam(req.params.id);
    if (!id) return res.redirect('/raffles?error=Invalid+raffle+id');
    const to = (req.body && req.body.status) || '';
    if (!STAGES.includes(to)) return res.redirect(`/raffles/${id}?error=Unknown+stage`);
    try {
      const r = await db.getAsync('SELECT status FROM raffles WHERE raffle_id = ?', [id]);
      if (!r) return res.redirect('/raffles?error=Raffle+not+found');
      const from = r.status;
      if (Math.abs(STAGES.indexOf(to) - STAGES.indexOf(from)) !== 1) {
        return res.redirect(`/raffles/${id}?error=` + encodeURIComponent(`Can't go from ${from} to ${to} — one step at a time.`));
      }
      let winning = null;
      if (to === 'drawn') {
        winning = kit.str(req.body.winning_ticket, 100);
        if (!winning) return res.redirect(`/raffles/${id}?error=` + encodeURIComponent('Enter the winning ticket number.'));
      }
      const u = await db.runAsync('UPDATE raffles SET status = ?, winning_ticket = ?, updated_at = ? WHERE raffle_id = ? AND status = ?',
        [to, to === 'drawn' ? winning : null, kit.sqlTime(), id, from]);
      if (!u.changes) return res.redirect(`/raffles/${id}?error=` + encodeURIComponent('The raffle changed meanwhile — reload and try again.'));
      console.log(`[raffles] ${req.session.user.username} moved raffle #${id} ${from} → ${to}`);
      res.redirect(`/raffles/${id}?msg=` + encodeURIComponent(`Stage: ${STATUS_LABEL[to]}.`));
    } catch (err) {
      res.redirect(`/raffles/${id}?error=` + encodeURIComponent('Update failed: ' + (err.message || err)));
    }
  });

  // A fresh preview link (replaces any earlier one for this raffle) — shows
  // the real page even while it's a draft or hidden.
  router.post('/raffles/:id/preview', requireAdmin, async (req, res) => {
    const id = kit.idParam(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid raffle id' });
    const r = await preview.makePreviewLink(db, appConfig, { table: 'raffles', idCol: 'raffle_id', id, path: '/raffles' });
    res.status(r.status).json(r.body);
  });

  router.post('/raffles/:id/delete', requireAdmin, async (req, res) => {
    const id = kit.idParam(req.params.id);
    if (!id) return res.redirect('/raffles?error=Invalid+raffle+id');
    try {
      const r = await db.getAsync('SELECT raffle_id, title, flyer_path FROM raffles WHERE raffle_id = ?', [id]);
      if (!r) return res.redirect('/raffles?error=Raffle+not+found');
      const imgs = await db.allAsync('SELECT path FROM raffle_images WHERE raffle_id = ?', [id]);
      await db.transaction(async (tx) => {
        await tx.runAsync('DELETE FROM raffle_images WHERE raffle_id = ?', [id]);
        await tx.runAsync('DELETE FROM raffles WHERE raffle_id = ?', [id]);
      });
      await uploads.removeFiles(appConfig, [r.flyer_path, ...imgs.map(x => x.path)]);
      console.log(`[raffles] ${req.session.user.username} deleted raffle #${id} (${r.title})`);
      res.redirect('/raffles?msg=' + encodeURIComponent(`Raffle "${r.title}" deleted.`));
    } catch (err) {
      console.error('[raffles] delete failed:', err);
      res.redirect(`/raffles/${id}?error=` + encodeURIComponent('Delete failed: ' + (err.message || err)));
    }
  });

  // ── Flyer ───────────────────────────────────────────────────────────
  router.post('/raffles/:id/flyer', requireAdmin, kit.withImage((req) => `/raffles/${encodeURIComponent(req.params.id)}`, async (req, res) => {
    const id = kit.idParam(req.params.id);
    if (!id) return kit.reply(req, res, '/raffles', false, 'Invalid raffle id.');
    const back = `/raffles/${id}`;
    const r = await db.getAsync('SELECT flyer_path FROM raffles WHERE raffle_id = ?', [id]);
    if (!r) return kit.reply(req, res, '/raffles', false, 'Raffle not found.');
    let saved;
    try { saved = await uploads.saveImage(appConfig, 'raffles', req.file && req.file.buffer); }
    catch (err) { return kit.reply(req, res, back, false, err.message || 'Upload failed'); }
    try {
      await db.runAsync('UPDATE raffles SET flyer_path = ?, updated_at = ? WHERE raffle_id = ?', [saved.rel, kit.sqlTime(), id]);
    } catch (err) {
      await uploads.removeFiles(appConfig, saved.rel);
      return kit.reply(req, res, back, false, 'Saving failed: ' + (err.message || err));
    }
    if (r.flyer_path && r.flyer_path !== saved.rel) await uploads.removeFiles(appConfig, r.flyer_path);
    kit.reply(req, res, back, true, 'Flyer uploaded.');
  }));

  router.post('/raffles/:id/flyer/remove', requireAdmin, async (req, res) => {
    const id = kit.idParam(req.params.id);
    if (!id) return res.redirect('/raffles?error=Invalid+raffle+id');
    try {
      const r = await db.getAsync('SELECT flyer_path FROM raffles WHERE raffle_id = ?', [id]);
      if (!r) return res.redirect('/raffles?error=Raffle+not+found');
      await db.runAsync('UPDATE raffles SET flyer_path = NULL, updated_at = ? WHERE raffle_id = ?', [kit.sqlTime(), id]);
      await uploads.removeFiles(appConfig, r.flyer_path);
      res.redirect(`/raffles/${id}?msg=Flyer+removed.`);
    } catch (err) {
      res.redirect(`/raffles/${id}?error=` + encodeURIComponent('Remove failed: ' + (err.message || err)));
    }
  });

  // ── Prize photos ────────────────────────────────────────────────────
  router.post('/raffles/:id/images', requireAdmin, kit.withImage((req) => `/raffles/${encodeURIComponent(req.params.id)}`, async (req, res) => {
    const id = kit.idParam(req.params.id);
    if (!id) return kit.reply(req, res, '/raffles', false, 'Invalid raffle id.');
    const back = `/raffles/${id}`;
    const r = await db.getAsync('SELECT raffle_id FROM raffles WHERE raffle_id = ?', [id]);
    if (!r) return kit.reply(req, res, '/raffles', false, 'Raffle not found.');
    const c = await db.getAsync('SELECT COUNT(*) AS c FROM raffle_images WHERE raffle_id = ?', [id]);
    if (c && Number(c.c) >= MAX_IMAGES) return kit.reply(req, res, back, false, `A raffle can have at most ${MAX_IMAGES} prize photos.`);
    let saved;
    try { saved = await uploads.saveImage(appConfig, 'raffles', req.file && req.file.buffer); }
    catch (err) { return kit.reply(req, res, back, false, err.message || 'Upload failed'); }
    try {
      const sort = await kit.nextSort(db, 'raffle_images', 'raffle_id', id);
      await db.runAsync('INSERT INTO raffle_images (raffle_id, path, alt, sort) VALUES (?, ?, ?, ?)',
        [id, saved.rel, kit.str(req.body && req.body.alt, 300), sort]);
    } catch (err) {
      await uploads.removeFiles(appConfig, saved.rel);
      return kit.reply(req, res, back, false, 'Saving failed: ' + (err.message || err));
    }
    kit.reply(req, res, back, true, 'Prize photo added.');
  }));

  router.post('/raffles/:id/images/:imageId/move', requireAdmin, async (req, res) => {
    const id = kit.idParam(req.params.id), imageId = kit.idParam(req.params.imageId);
    if (!id || !imageId) return res.redirect('/raffles?error=Invalid+id');
    try {
      await kit.moveRow(db, 'raffle_images', 'image_id', imageId, req.body && req.body.dir === 'up' ? 'up' : 'down', 'raffle_id', id);
      res.redirect(`/raffles/${id}`);
    } catch (err) {
      res.redirect(`/raffles/${id}?error=` + encodeURIComponent('Reorder failed: ' + (err.message || err)));
    }
  });

  router.post('/raffles/:id/images/:imageId/delete', requireAdmin, async (req, res) => {
    const id = kit.idParam(req.params.id), imageId = kit.idParam(req.params.imageId);
    if (!id || !imageId) return res.redirect('/raffles?error=Invalid+id');
    try {
      const im = await db.getAsync('SELECT path FROM raffle_images WHERE image_id = ? AND raffle_id = ?', [imageId, id]);
      if (!im) return res.redirect(`/raffles/${id}?error=Photo+not+found`);
      await db.runAsync('DELETE FROM raffle_images WHERE image_id = ? AND raffle_id = ?', [imageId, id]);
      await uploads.removeFiles(appConfig, im.path);
      res.redirect(`/raffles/${id}?msg=Photo+deleted.`);
    } catch (err) {
      res.redirect(`/raffles/${id}?error=` + encodeURIComponent('Delete failed: ' + (err.message || err)));
    }
  });

  return router;
};

module.exports.PRESETS = PRESETS;
module.exports.presetOf = presetOf;
