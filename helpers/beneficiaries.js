// helpers/beneficiaries.js — "Who it benefits" for events and raffles: a
// list of rows, each a directory organization (org_id — the website links to
// its profile only while it's verified + listed) or a free name + optional
// link. Stored in event_beneficiaries / raffle_beneficiaries and replaced
// wholesale on save (DELETE + INSERT in one transaction). The org's name is
// copied into `name` so the row still reads sensibly if the organization is
// later deleted (org_id → NULL).
//
//   editor(benJson, orgs)        the Alpine list editor (posts beneficiaries_json)
//   parse(body)                  → { bens, json } or { error, json } (json = what
//                                  to echo back into the editor on an error)
//   write(db, kind, id, bens)    replace the rows
//   toJson(rows)                 stored rows → the editor's JSON
//   KIND.event / KIND.raffle     { table, idCol }
//
// orgs for the editor: [{ org_id, name, verification_status, is_listed }].

'use strict';

const { escapeHtml } = require('../views/escapeHtml');
const kit = require('./pageKit');

const KIND = {
  event: { table: 'event_beneficiaries', idCol: 'event_id' },
  raffle: { table: 'raffle_beneficiaries', idCol: 'raffle_id' }
};

function editor(benJson, orgs) {
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

// → { bens, json } or { error, json }. `json` is what the form should echo
// back into the editor on a re-render: the rows as posted (normalized) when
// they could be read, '[]' when the posted JSON was malformed. Re-rendering
// the malformed string itself would show "No beneficiaries" and a follow-up
// Save would then wipe the stored rows.
function parse(b) {
  let bensIn;
  try { bensIn = JSON.parse(b.beneficiaries_json || '[]'); }
  catch (e) { return { error: 'Beneficiaries could not be read — reload the page and try again.', json: '[]' }; }
  if (!Array.isArray(bensIn)) bensIn = [];
  bensIn = bensIn.slice(0, 30);
  const json = JSON.stringify(bensIn.map(x => ({
    org_id: x && x.org_id != null ? String(x.org_id) : '', name: x && x.name != null ? String(x.name) : '', url: x && x.url != null ? String(x.url) : ''
  })));
  const bens = [];
  for (const x of bensIn) {
    const orgId = kit.idParam(x && x.org_id);
    const name = kit.str(x && x.name, 200);
    const u = kit.urlField(x && x.url, 'Beneficiary link');
    if (u.error) return { error: u.error, json };
    if (!orgId && !name) continue; // blank row
    bens.push({ org_id: orgId, name, url: orgId ? null : u.value });
  }
  return { bens, json };
}

async function write(db, { table, idCol }, id, bens) {
  // Org names are looked up BEFORE the transaction (remote SQLite: no reads
  // inside one).
  const ids = [...new Set(bens.filter(x => x.org_id).map(x => x.org_id))];
  const names = new Map();
  if (ids.length) {
    const rows = await db.allAsync(`SELECT org_id, name FROM organizations WHERE org_id IN (${ids.map(() => '?').join(',')})`, ids);
    for (const r of rows) names.set(Number(r.org_id), r.name);
  }
  await db.transaction(async (tx) => {
    await tx.runAsync(`DELETE FROM ${table} WHERE ${idCol} = ?`, [id]);
    let sort = 1;
    for (const x of bens) {
      if (x.org_id && !names.has(x.org_id)) continue; // org vanished meanwhile
      await tx.runAsync(`INSERT INTO ${table} (${idCol}, org_id, name, url, sort) VALUES (?, ?, ?, ?, ?)`,
        [id, x.org_id || null, x.org_id ? names.get(x.org_id) : x.name, x.org_id ? null : x.url, sort++]);
    }
  });
}

function toJson(rows) {
  return JSON.stringify((rows || []).map(x => ({ org_id: x.org_id ? Number(x.org_id) : '', name: x.name || '', url: x.url || '' })));
}

module.exports = { KIND, editor, parse, write, toJson };
