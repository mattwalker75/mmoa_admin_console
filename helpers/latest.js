// helpers/latest.js — "Latest": at most ONE event (and, separately, ONE
// raffle) is marked is_latest, and the website also serves it at
// /events/latest or /raffles/latest while it's published. Saving an item
// with Latest ticked clears it on every other row of that table first, so
// 'latest' is reserved as a slug.
//
// kind = { table, idCol, noun ('event' | 'raffle'), path ('/events' | '/raffles') }
//
//   field(v, holder, kind)          the checkbox + "who holds it now" note
//                                   (v.is_latest, v.item_id) — placed inside
//                                   the form's URL slug field, right under it
//   holder(db, kind, exceptId)      the row that holds it (other than exceptId)
//   take(tx, kind, id)              clear it on every OTHER row. Call it INSIDE
//                                   the same db.transaction() as the row's
//                                   INSERT / UPDATE so a failed save can't
//                                   leave no Latest and two saves can't leave
//                                   two: update → write the row, then take(id);
//                                   create → take(0), then INSERT (the new id
//                                   isn't known inside a remote transaction).
//   message(prev, kind)             " It is now the Latest … — “X” no longer is."
//   slugCheck(slug, slugIn, kind)   { slug } or { error } — 'latest' is reserved

'use strict';

const { escapeHtml } = require('../views/escapeHtml');

function field(v, holder, { noun, path }) {
  const mine = holder && v.item_id && String(holder.id) === String(v.item_id);
  const note = mine ? `This is the Latest ${noun}.`
    : holder ? `Right now the Latest ${noun} is “${escapeHtml(holder.title)}” — ticking this moves Latest here and un-selects it there.`
    : `No ${noun} is Latest right now.`;
  return `<div class="mt-3 rounded-lg border border-slate-200 dark:border-slate-700 px-3 py-2">
          <input type="hidden" name="_item_id" value="${escapeHtml(v.item_id || '')}">
          <label class="inline-flex items-center gap-2 text-sm font-medium text-slate-700 dark:text-slate-200">
            <input type="checkbox" name="is_latest" value="1" class="h-4 w-4" ${v.is_latest ? 'checked' : ''}>
            Also show this ${noun} at <code class="font-mono">${path}/latest</code>
          </label>
          <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">Only one ${noun} can be Latest. ${note} The link only works while the ${noun} is Published.</p>
        </div>`;
}

async function holder(db, { table, idCol }, exceptId) {
  return await db.getAsync(`SELECT ${idCol} AS id, title FROM ${table} WHERE is_latest = 1 AND ${idCol} <> ? ORDER BY ${idCol} DESC LIMIT 1`, [exceptId || 0]) || null;
}

async function take(db, { table, idCol }, id) {
  await db.runAsync(`UPDATE ${table} SET is_latest = 0 WHERE is_latest = 1 AND ${idCol} <> ?`, [id || 0]);
}

function message(prev, { noun, path }) {
  return prev ? ` It is now the Latest ${noun} (${path}/latest) — “${prev.title}” no longer is.` : '';
}

function slugCheck(slug, slugIn, { noun, path }) {
  if (slug !== 'latest') return { slug };
  if (slugIn) return { error: `"latest" is reserved for the Latest ${noun}'s address (${path}/latest) — pick another slug, or tick "Latest" instead.` };
  return { slug: `latest-${noun}` };
}

const EVENT = { table: 'events', idCol: 'event_id', noun: 'event', path: '/events' };
const RAFFLE = { table: 'raffles', idCol: 'raffle_id', noun: 'raffle', path: '/raffles' };

module.exports = { field, holder, take, message, slugCheck, EVENT, RAFFLE };
