// middleware/pageShell.js — open slow tabs instantly with a "Loading…" line.
//
// When the Web App is on EC2 (or an SSH host) the pages that read its
// database or files wait on SSM / SSH round trips, so clicking a tab used to
// look like nothing happened for a few seconds. For those pages, a browser
// navigation first gets a tiny "shell": the sidebar, the tab's title and the
// same loading line the Dashboard uses. public/js/page-loader.js then sets a
// one-time cookie for this exact URL and reloads it with location.replace().
// The browser keeps showing the shell while the real page is built, and the
// real page arrives as an ordinary navigation, so its scripts, headers (CSP),
// status codes and redirects all behave exactly as before.
//
// Only real browser navigations get a shell (Sec-Fetch-Dest: document +
// Sec-Fetch-Mode: navigate) — fetch() calls, downloads, curl and older
// browsers go straight to the page. Local mode is fast, so it's skipped.

'use strict';

const { page } = require('../views/layout');
const { escapeHtml } = require('../views/escapeHtml');

// path pattern → [activeNav key, tab title]
const SLOW = [
  [/^\/events(\/|$)/, 'events', 'Events'],
  [/^\/raffles(\/|$)/, 'raffles', 'Raffles'],
  [/^\/nonprofits(\/|$)/, 'nonprofits', 'Nonprofits'],
  [/^\/categories-cities$/, 'categories-cities', 'Categories & Cities'],
  [/^\/board$/, 'board', 'Board'],
  [/^\/data(\/|$)/, 'data', 'Data Browser'],
  [/^\/locked-users$/, 'locked-users', 'Locked Users'],
  [/^\/audit$/, 'audit', 'Audit log'],
  [/^\/web-app-website$/, 'web-app-website', 'Web App Website'],
  [/^\/web-app-logs$/, 'web-app-logs', 'Web App Logs'],
  [/^\/web-app-settings(\/|$)/, 'web-app-settings', 'Web App Settings']
];
// Never shell these (files, JSON, pop-up helpers).
const SKIP = /\.(csv|json|png|jpe?g|gif|webp|svg)$|\/(export|download|preview|propublica)(\/|$)/i;

// Same hash as public/js/page-loader.js (djb2 → base36) of path + query.
function urlKey(u) {
  let h = 5381;
  for (let i = 0; i < u.length; i++) h = ((h * 33) ^ u.charCodeAt(i)) >>> 0;
  return 'pl_' + h.toString(36);
}

function hasCookie(req, name) {
  const raw = req.headers.cookie || '';
  return raw.split(';').some(c => c.trim().split('=')[0] === name);
}

module.exports = function pageShell(appConfig) {
  return function (req, res, next) {
    if (req.method !== 'GET') return next();
    const mode = appConfig.webApp && appConfig.webApp.mode;
    if (mode !== 'ec2' && mode !== 'ssh') return next();
    if (req.get('sec-fetch-dest') !== 'document' || req.get('sec-fetch-mode') !== 'navigate') return next();
    const user = req.session && req.session.user;
    if (!user || user.role !== 'admin') return next(); // let the route send them to /login
    if (SKIP.test(req.path)) return next();
    const hit = SLOW.find(([re]) => re.test(req.path));
    if (!hit) return next();

    const key = urlKey(req.originalUrl);
    if (hasCookie(req, key)) {
      // The shell's follow-up request: build the real page, drop the cookie.
      res.append('Set-Cookie', `${key}=; Path=/; Max-Age=0; SameSite=Strict`);
      return next();
    }

    const [, activeNav, label] = hit;
    const where = mode === 'ec2' ? 'on the EC2 instance' : 'on the SSH host';
    const body = `
      <header class="flex items-start justify-between mb-8">
        <div><h1 class="text-2xl font-bold text-slate-900 dark:text-slate-100">${escapeHtml(label)}</h1></div>
      </header>
      <div id="page-shell" data-key="${escapeHtml(key)}" class="mb-6 flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300" role="status" aria-live="polite">
        <span class="inline-block w-4 h-4 rounded-full border-2 border-brand-500 border-t-transparent animate-spin"></span>
        <span>Loading the latest data from the Web App's database ${where} — this can take a few seconds…</span>
      </div>
      <noscript><p class="text-sm"><a class="text-brand-600 underline" href="${escapeHtml(req.originalUrl)}">Continue</a></p></noscript>`;
    res.send(page({ title: label, body, appConfig, user, activeNav }));
  };
};

module.exports.urlKey = urlKey;
