// helpers/websiteCard.js — the green "Website" card: the Web App's public
// address (publicBaseUrl in its config.json) with an "Open website" button
// that opens it in a new browser window. Shown on Web App Website (above
// Images) and on Web App Settings (under Web App process) — one source so
// the two never drift.

'use strict';

const { escapeHtml } = require('../views/escapeHtml');

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

module.exports = { websiteLinkCard };
