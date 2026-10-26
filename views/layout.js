// views/layout.js — shared HTML wrappers for the admin console.
//
// Two layout shapes:
//   * Authenticated pages → sidebar + main content area (modern admin look)
//   * Unauthenticated pages (login / setup) → bare body, content centers itself
//
// Theme/appearance settings stored under appConfig.theme are read here on
// every request and injected as inline CSS so background image, color, and
// surface opacity all apply without a restart. Dark mode is class-based:
// we put `dark` on <html> and Tailwind's dark: variant takes over.

const fs = require('fs');
const path = require('path');
const { escapeHtml } = require('./escapeHtml');
const { currentToken: currentCsrfToken } = require('../middleware/csrf');

// Cache-bust /css/tailwind.css and /js/alpine.min.js using the file mtime
// so the browser always picks up freshly-built assets without needing a
// hard-refresh. statSync is a single local fs call per request — cheap.
function assetVer(relPath) {
  try {
    return String(fs.statSync(path.join(__dirname, '..', 'public', relPath)).mtimeMs | 0);
  } catch (e) { return ''; }
}

function isSafeCssColor(v) {
  if (typeof v !== 'string') return false;
  return /^#[0-9a-fA-F]{3,8}$|^rgba?\([\d.,\s%]+\)$/.test(v.trim());
}
function cssUrlSafe(v) {
  if (typeof v !== 'string') return '';
  if (!/^\/images\/[A-Za-z0-9._-]+$/.test(v)) return '';
  return v;
}

function themeCss(appConfig, isLoginPage) {
  const t = (appConfig && appConfig.theme) || {};
  const cfg = isLoginPage ? (t.login || {}) : (t.app || {});
  const opacity = isLoginPage
    ? (typeof cfg.cardOpacity === 'number' ? cfg.cardOpacity : 1)
    : (typeof cfg.surfaceOpacity === 'number' ? cfg.surfaceOpacity : 1);
  const a = Math.max(0, Math.min(1, opacity));

  let bg = '';
  const img = cssUrlSafe(cfg.backgroundImage);
  if (img) {
    // The colour stays underneath, so a missing image still shows the chosen colour.
    bg = `body { ${isSafeCssColor(cfg.backgroundColor) ? `background-color: ${cfg.backgroundColor}; ` : ''}background-image: url('${img}'); background-size: cover; background-position: center; background-attachment: fixed; background-repeat: no-repeat; }`;
  } else if (isSafeCssColor(cfg.backgroundColor)) {
    bg = `body { background-color: ${cfg.backgroundColor}; }`;
  }

  // Apply translucency to whatever container surfaces are on this view.
  // We target the .card class (added by tailwind.input.css @layer components)
  // plus headers/tables. Text stays fully opaque because we only change the
  // background-color via rgba.
  let op = '';
  if (a < 1) {
    if (isLoginPage) {
      op = `.surface-target { background-color: rgba(255,255,255,${a}) !important; backdrop-filter: blur(2px); }
            .dark .surface-target { background-color: rgba(15,23,42,${a}) !important; }`;
    } else {
      op = `.surface-target, .card, .table-wrap, .stat-card, aside.app-sidebar { background-color: rgba(255,255,255,${a}) !important; backdrop-filter: blur(2px); }
            .dark .surface-target, .dark .card, .dark .table-wrap, .dark .stat-card, .dark aside.app-sidebar { background-color: rgba(15,23,42,${a}) !important; }`;
    }
  }

  return `<style>${bg}${op}</style>`;
}

// ── CSRF token plumbing (see middleware/csrf.js) ─────────────────────────
// The token reaches the browser two ways, both done here so no route has to
// think about it: a <meta name="csrf-token"> in <head> (public/js/csrf.js
// turns it into an X-CSRF-Token header on every state-changing fetch) and a
// hidden _csrf input added to every <form method="POST"> in the finished
// page. Forms without a method (GET) are left alone.
function csrfHead(token) {
  return `<meta name="csrf-token" content="${escapeHtml(token)}">
  <script src="/js/csrf.js?v=${assetVer('js/csrf.js')}"></script>`;
}

// Read a <form …> tag's attributes. Values may hold anything — an Alpine
// x-on:submit expression with "=>" for instance — so this walks quoted
// values rather than stopping at the first ">".
const ATTR_RE = /([^\s"'>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
function formTagEnd(html, start) {
  let quote = null;
  for (let i = start; i < html.length; i++) {
    const ch = html[i];
    if (quote) { if (ch === quote) quote = null; }
    else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '>') return i;
  }
  return -1;
}
function formMethod(tagInner) {
  ATTR_RE.lastIndex = 0;
  let m;
  while ((m = ATTR_RE.exec(tagInner))) {
    if (m[1].toLowerCase() === 'method') return (m[2] ?? m[3] ?? m[4] ?? '').trim().toLowerCase();
  }
  return 'get';
}
function injectCsrfInputs(html, token) {
  if (!token) return html;
  const input = `<input type="hidden" name="_csrf" value="${escapeHtml(token)}">`;
  let out = '';
  let pos = 0;
  const re = /<form(?=[\s>\/])/gi;
  let m;
  while ((m = re.exec(html))) {
    const end = formTagEnd(html, m.index + 5);
    if (end < 0) break;
    out += html.slice(pos, end + 1);
    if (formMethod(html.slice(m.index + 5, end)) === 'post') out += input;
    pos = end + 1;
    re.lastIndex = pos;
  }
  return out + html.slice(pos);
}

function navItem(href, label, icon, isActive) {
  const cls = isActive ? 'nav-item active' : 'nav-item';
  return `<a class="${cls}" href="${href}">
    <span class="opacity-80" aria-hidden="true">${icon}</span>
    <span>${escapeHtml(label)}</span>
  </a>`;
}

function sidebar(appConfig, user, activeNav) {
  const title = escapeHtml(appConfig.appTitle || 'MMoA Admin Console');
  // `fixed inset-y-0 left-0 w-64` removes the sidebar from normal flow so
  // it can never stretch with the main content. Its internal nav scrolls
  // independently if it ever exceeds the viewport.
  return `<aside class="app-sidebar fixed inset-y-0 left-0 z-30 flex flex-col w-64 bg-slate-900 text-slate-100 border-r border-slate-800">
    <div class="px-6 py-5 border-b-2 border-slate-600">
      <div class="text-lg font-bold tracking-tight">${title}</div>
      <div class="text-xs text-slate-400 mt-0.5">Admin console</div>
    </div>
    <nav class="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
      ${navItem('/profile', 'Profile', '◉', activeNav === 'profile')}
      ${navItem('/', 'Dashboard', '⌂', activeNav === 'home')}
      ${navItem('/admins', 'Admins', '★', activeNav === 'admins')}
      <hr class="my-2 border-t-2 border-slate-600">
      ${navItem('/events', 'Events', '📅', activeNav === 'events')}
      ${navItem('/raffles', 'Raffles', '🎟', activeNav === 'raffles')}
      ${navItem('/nonprofits', 'Nonprofits', '☺', activeNav === 'nonprofits')}
      ${navItem('/categories-cities', 'Categories & Cities', '⌖', activeNav === 'categories-cities')}
      ${navItem('/board', 'Board', '♜', activeNav === 'board')}
      ${navItem('/data', 'Data Browser', '▦', activeNav === 'data')}
      ${navItem('/locked-users', 'Locked Users', '🔒', activeNav === 'locked-users')}
      ${navItem('/reports', 'Reports', '▤', activeNav === 'reports')}
      ${navItem('/audit', 'Audit log', '≡', activeNav === 'audit')}
      <hr class="my-2 border-t-2 border-slate-600">
      ${navItem('/web-app-website', 'Web App Website', '🖥', activeNav === 'web-app-website')}
      ${navItem('/web-app-logs', 'Web App Logs', '📄', activeNav === 'web-app-logs')}
      ${navItem('/backup-restore', 'Backup/Restore', '⇅', activeNav === 'backup')}
      ${navItem('/web-app-settings', 'Web App Settings', '🛠', activeNav === 'web-app-settings')}
      <hr class="my-2 border-t-2 border-slate-600">
      ${navItem('/settings', 'Settings', '⚒', activeNav === 'settings')}
    </nav>
    <div class="border-t-2 border-slate-600 px-4 py-4 space-y-3">
      <div class="text-xs text-slate-400 leading-tight">
        Signed in as<br><span class="font-semibold text-slate-100">${escapeHtml(user.name || user.username)}</span>
      </div>
      <form method="POST" action="/logout" class="m-0">
        <button type="submit" class="w-full inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold border border-slate-700 bg-slate-800 text-slate-100 hover:bg-slate-700 transition">
          <span aria-hidden="true">⎋</span>
          <span>Sign out</span>
        </button>
      </form>
    </div>
  </aside>`;
}

function page({ title, body, appConfig, user, activeNav }) {
  const fullTitle = title
    ? `${escapeHtml(title)} — ${escapeHtml(appConfig.appTitle || 'MMoA Admin Console')}`
    : escapeHtml(appConfig.appTitle || 'MMoA Admin Console');
  const isLoginPage = !user;
  const themeMode = (appConfig.theme && appConfig.theme.mode) === 'dark' ? 'dark' : '';
  // Per-session CSRF token for this request ('' outside a request).
  const csrf = currentCsrfToken();

  if (isLoginPage) {
    return injectCsrfInputs(`<!DOCTYPE html>
<html lang="en" class="${themeMode}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${fullTitle}</title>
  ${csrfHead(csrf)}
  <link rel="stylesheet" href="/css/tailwind.css?v=${assetVer('css/tailwind.css')}">
  ${themeCss(appConfig, true)}
  <script defer src="/js/alpine.min.js?v=${assetVer('js/alpine.min.js')}"></script>
</head>
<body class="min-h-screen flex items-center justify-center px-4 py-12">
  <div class="w-full max-w-md">
${body}
  </div>
</body>
</html>`, csrf);
  }

  return injectCsrfInputs(`<!DOCTYPE html>
<html lang="en" class="${themeMode}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${fullTitle}</title>
  ${csrfHead(csrf)}
  <link rel="stylesheet" href="/css/tailwind.css?v=${assetVer('css/tailwind.css')}">
  ${themeCss(appConfig, false)}
  <link rel="stylesheet" href="/css/flatpickr.min.css?v=${assetVer('css/flatpickr.min.css')}">
  <!-- csrf.js above is loaded first (not deferred) so the fetch wrapper is in place for everything below. -->
  <script defer src="/js/image-upload.js?v=${assetVer('js/image-upload.js')}"></script>
  <!-- Date pickers run before Alpine (deferred scripts run in order). -->
  <script defer src="/js/flatpickr.min.js?v=${assetVer('js/flatpickr.min.js')}"></script>
  <script defer src="/js/date-picker.js?v=${assetVer('js/date-picker.js')}"></script>
  <script defer src="/js/flyer-maker.js?v=${assetVer('js/flyer-maker.js')}"></script>
  <script defer src="/js/input-masks.js?v=${assetVer('js/input-masks.js')}"></script>
  <script defer src="/js/validate-restore.js?v=${assetVer('js/validate-restore.js')}"></script>
  <script defer src="/js/dashboard.js?v=${assetVer('js/dashboard.js')}"></script>
  <script defer src="/js/nav-progress.js?v=${assetVer('js/nav-progress.js')}"></script>
  <script defer src="/js/alpine.min.js?v=${assetVer('js/alpine.min.js')}"></script>
</head>
<body>
  ${sidebar(appConfig, user, activeNav)}
  <script src="/js/sidebar-scroll.js?v=${assetVer('js/sidebar-scroll.js')}"></script>
  <main class="ml-64 min-h-screen px-8 py-8">
${body}
    <footer class="mt-12 pt-6 border-t border-slate-200 dark:border-slate-800 text-xs text-slate-500 dark:text-slate-400">
      © ${new Date().getFullYear()} ${escapeHtml(appConfig.appTitle || 'MMoA Admin Console')}
    </footer>
  </main>
  ${confirmDialog()}
</body>
</html>`, csrf);
}

// Prompt to restart the Web App after its config.json was written — by any
// Web App Settings tab or a config / bundle restore. The web app reads its
// config once at boot, so nothing written is live until it restarts.
// `prompt` opens the dialog on load; the block also shows the outcome of
// "Restart now" (same power endpoint as the power bar) and the "Not now"
// reminder. Distinct on purpose from the console's own "Restart required"
// popup on Settings → Web App, which is about restarting THIS app.
function waRestartPrompt(prompt) {
  if (!prompt) return '';
  return `<div x-data="{ busy: false, result: null, declined: false,
      async init() {
        const yes = await window.uiConfirm(
          'Changes to the Web App config take effect after a restart. The site is unavailable for a few seconds while it restarts. Restart it now?',
          { title: 'Restart the Web App?', confirmLabel: 'Restart now', cancelLabel: 'Not now', danger: false });
        if (!yes) { this.declined = true; return; }
        this.busy = true;
        try {
          const r = await fetch('/web-app-settings/power', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify({ action: 'restart' })
          });
          this.result = await r.json().catch(() => ({ ok: false, error: 'Bad response from server' }));
        } catch (e) {
          this.result = { ok: false, error: 'Network error: ' + (e.message || e) };
        } finally { this.busy = false; }
      } }">
    <div x-show="busy" x-cloak class="flash-info mb-4">⏳ Restarting the Web App…</div>
    <div x-show="declined" x-cloak class="flash-warn mb-4"><strong class="font-semibold">Restart pending.</strong> The Web App is still running its previous config. <a href="/web-app-settings/general" class="underline">Web App Settings</a> shows a notice until you restart it.</div>
    <div x-show="result && result.ok" x-cloak class="flash-ok mb-4">Web App restarted — your changes are live.</div>
    <div x-show="result && !result.ok" x-cloak class="flash-error mb-4"><strong class="font-semibold">Restart failed.</strong> <span x-text="result && result.error"></span> Use the power bar on <a href="/web-app-settings/general" class="underline">Web App Settings</a>.</div>
  </div>`;
}

function flash(type, msg) {
  if (!msg) return '';
  const cls = type === 'error' ? 'flash-error'
            : type === 'warn'  ? 'flash-warn'
            : (type === 'ok' || type === 'success') ? 'flash-ok'
            : type === 'info'  ? 'flash-info'
            : 'flash';
  return `<div class="${cls} mb-4">${escapeHtml(msg)}</div>`;
}

// Shared, deterministic replacement for window.confirm(), injected once per
// authenticated page. Native confirm() is unreliable on Safari — after a few
// JS dialogs it offers "Don't allow this page to prompt you again" and then
// silently returns false, which made destructive buttons (Delete, Unlock,
// …) appear to "do nothing". window.uiConfirm() renders this in-app modal and
// resolves a Promise instead, so it behaves identically across browsers.
//
// The behaviour lives in the EXTERNAL file /js/ui-confirm.js, not an inline
// <script>: the app's CSP is `script-src 'self' 'unsafe-eval'` (no
// 'unsafe-inline'), so an inline script here would be blocked and uiConfirm
// would never be defined. Only the markup is inline (CSP doesn't gate HTML).
function confirmDialog() {
  return `
  <div id="ui-confirm-overlay" class="fixed inset-0 hidden items-center justify-center p-4 bg-black/60" style="z-index:1000">
    <div class="card surface-target card-pad w-full max-w-md" role="alertdialog" aria-modal="true" aria-labelledby="ui-confirm-title">
      <div class="flex items-start gap-3">
        <div class="text-2xl text-red-500 leading-none" aria-hidden="true">&#9888;</div>
        <div class="flex-1 min-w-0">
          <h3 id="ui-confirm-title" class="text-base font-semibold text-slate-900 dark:text-slate-100">Please confirm</h3>
          <p id="ui-confirm-message" class="mt-2 text-sm text-slate-700 dark:text-slate-200 break-words whitespace-pre-wrap"></p>
        </div>
      </div>
      <div class="mt-5 flex justify-end gap-2">
        <button type="button" id="ui-confirm-cancel" class="btn-secondary">Cancel</button>
        <button type="button" id="ui-confirm-ok" class="btn-danger">Confirm</button>
      </div>
    </div>
  </div>
  <script src="/js/ui-confirm.js?v=${assetVer('js/ui-confirm.js')}"></script>`;
}

// "Restart the MMoA Admin Console" — a popup for the few console settings
// that only take effect when the console process starts (its port, TLS,
// session cookie, login throttling). `what` names them. Opens on load.
function consoleRestartPopup(what) {
  if (!what) return '';
  return `<div x-data="{ open: true }" x-show="open" x-on:keydown.escape.window="open = false"
       class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60" role="dialog" aria-modal="true" aria-labelledby="crp-title">
    <div class="card surface-target card-pad w-full max-w-md">
      <div class="flex items-start gap-3">
        <div class="text-2xl text-amber-500 leading-none" aria-hidden="true">⟳</div>
        <div class="flex-1 min-w-0">
          <h3 id="crp-title" class="text-base font-semibold text-slate-900 dark:text-slate-100">Restart the MMoA Admin Console</h3>
          <p class="mt-2 text-sm text-slate-700 dark:text-slate-200">Your changes are saved, but <strong>${escapeHtml(what)}</strong> only take${/,| and /.test(what) ? '' : 's'} effect when the <strong>MMoA Admin Console</strong> starts.</p>
          <p class="mt-2 text-sm text-slate-700 dark:text-slate-200">Stop the MMoA Admin Console and start it again (on this computer: Ctrl-C in its terminal, then <code class="font-mono">npm start</code>). The Web App does <strong>not</strong> need restarting for this.</p>
        </div>
      </div>
      <div class="mt-5 flex justify-end"><button type="button" class="btn-primary" x-on:click="open = false">OK</button></div>
    </div>
  </div>`;
}

module.exports = { page, flash, waRestartPrompt, consoleRestartPopup };
