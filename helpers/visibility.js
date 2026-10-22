// helpers/visibility.js — Draft / Published / Archived, shared by Events and
// Raffles: whether an item is on the website.
//
//   draft      being prepared — only in the console (Preview can show it)
//   published  on the website
//   archived   taken off the website, kept for reference
//
// buttons(current, opts) — the 3-position switch. Each button submits the
// item's form (form="<formId>") with set_status=<key>, so a click SAVES the
// item — edits included — with that visibility; the current one is shown
// selected. Used in the page header and at the bottom of the form.
// switcher(current, opts) — the bottom-of-form version: label, the buttons,
// what the current one means, and a hidden <field> so a plain Save keeps it.
// opts: { formId, noun ('event' | 'raffle'), field (default 'status') }.
// Route code reads the choice as set_status || <field>.

'use strict';

const { escapeHtml } = require('../views/escapeHtml');

const VISIBILITY = [
  { key: 'draft', label: 'Draft', hint: 'Being prepared — not on the website yet.' },
  { key: 'published', label: 'Published', hint: 'On the website now.' },
  { key: 'archived', label: 'Archived', hint: 'Taken off the website; kept here for reference.' }
];
const KEYS = VISIBILITY.map(v => v.key);

function pill(v) {
  if (v === 'published') return '<span class="pill-running">Published</span>';
  if (v === 'archived') return '<span class="pill-terminated">Archived</span>';
  return '<span class="pill-pending">Draft</span>';
}

function buttons(current, { formId, noun }) {
  return `<div class="inline-flex rounded-lg border border-slate-300 dark:border-slate-600 overflow-hidden divide-x divide-slate-300 dark:divide-slate-600" role="group" aria-label="Status — clicking one saves the ${escapeHtml(noun)}">
      ${VISIBILITY.map(s => s.key === current
        ? `<span class="px-3 py-2 text-sm font-semibold bg-brand-600 text-white" aria-current="true" title="${escapeHtml(s.hint)}">${s.label}</span>`
        : `<button type="submit" form="${escapeHtml(formId)}" name="set_status" value="${s.key}" class="px-3 py-2 text-sm font-semibold text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800" title="${escapeHtml(s.hint)} Saves your changes too.">${s.label}</button>`).join('')}
    </div>`;
}

function switcher(current, { formId, noun, field = 'status' }) {
  const s = VISIBILITY.find(x => x.key === current) || VISIBILITY[0];
  return `<div>
      <input type="hidden" name="${escapeHtml(field)}" value="${s.key}">
      <div class="label">Status</div>
      ${buttons(s.key, { formId, noun })}
      <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">${escapeHtml(s.hint)} Click another status to switch — that saves the ${escapeHtml(noun)}.</p>
    </div>`;
}

// The value a form asked for: the clicked button, else the hidden field, else draft.
function fromForm(b, field = 'status') {
  return KEYS.includes(b.set_status) ? b.set_status : KEYS.includes(b[field]) ? b[field] : 'draft';
}

module.exports = { VISIBILITY, KEYS, pill, buttons, switcher, fromForm };
