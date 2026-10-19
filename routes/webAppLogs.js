// routes/webAppLogs.js — view the REMOTE Web App's runtime log.
//
//   GET /web-app-logs        → tail logs/app.log and render it
//
// The log lives at logs/app.log under the Web App install directory
// (accessor.appPath) — written by its START_APP.sh (`nohup node app.js >>
// logs/app.log`). We read it through helpers/webAppAccess.js so the
// same page works whether the Web App is local, reachable over SSH, or
// an EC2 instance driven via SSM.
//
// We `tail -n N` rather than read the whole file so the output is bounded
// (a long-running app's log can be huge), shows the most recent activity,
// and stays well under the SSM output cap in ec2 mode. Line content is
// HTML-escaped before rendering — log lines are untrusted text.

const express = require('express');
const { page } = require('../views/layout');
const { escapeHtml } = require('../views/escapeHtml');
const { requireAdmin } = require('../middleware/auth');
const webAppAccess = require('../helpers/webAppAccess');

// Path is relative to the Web App install dir (we run tail with cwd set
// to appPath). It's a fixed constant — never interpolated from user input —
// so it needs no shell quoting.
const LOG_REL_PATH = 'logs/app.log';
const LINE_OPTIONS = [100, 500, 2000, 10000];
const DEFAULT_LINES = 500;

const PRE_CLS = 'font-mono text-xs leading-relaxed whitespace-pre-wrap break-all ' +
  'max-h-[70vh] overflow-auto rounded-lg border p-3 ' +
  'bg-slate-50 border-slate-200 text-slate-800 ' +
  'dark:bg-slate-950 dark:border-slate-800 dark:text-slate-200';

function pageHeader(title, subtitle) {
  return `<header class="mb-6">
    <h1 class="text-2xl font-bold text-slate-900 dark:text-slate-100">${escapeHtml(title)}</h1>
    ${subtitle ? `<p class="mt-1 text-sm text-slate-500 dark:text-slate-400">${escapeHtml(subtitle)}</p>` : ''}
  </header>`;
}

function controlsBar(lines) {
  const opts = LINE_OPTIONS.map(n =>
    `<option value="${n}" ${n === lines ? 'selected' : ''}>last ${n} lines</option>`).join('');
  return `<div class="flex items-center justify-between gap-3 flex-wrap mb-4">
    <form method="GET" action="/web-app-logs" class="flex items-center gap-2">
      <label class="text-sm text-slate-600 dark:text-slate-300" for="lines">Show</label>
      <select id="lines" name="lines" class="input max-w-[12rem]" x-data
              x-on:change="$el.form.requestSubmit ? $el.form.requestSubmit() : $el.form.submit()">${opts}</select>
      <noscript><button type="submit" class="btn-secondary">Apply</button></noscript>
    </form>
    <a href="/web-app-logs?lines=${lines}" class="btn-secondary inline-flex items-center gap-1.5">
      <span aria-hidden="true">⟳</span><span>Refresh</span>
    </a>
  </div>`;
}

function renderBody({ logText, lines, readErr, notConfigured, accessDesc }) {
  let banner;
  if (notConfigured) {
    banner = `<div class="flash-error mb-6"><strong class="font-semibold">Web App access is not configured.</strong> Set how this console reaches the Web App under <a class="underline" href="/settings/web-app">Settings → Web App</a> first.</div>`;
  } else if (readErr) {
    banner = `<div class="flash-error mb-6"><strong class="font-semibold">Could not read the log.</strong> ${escapeHtml(readErr)}</div>`;
  } else {
    banner = `<div class="mb-4 text-xs text-slate-500 dark:text-slate-400">Showing the last ${lines} lines of <code class="font-mono">${escapeHtml(LOG_REL_PATH)}</code> via ${escapeHtml(accessDesc)}.</div>`;
  }

  // The <pre> auto-scrolls to the bottom on load so the newest lines show
  // first (x-init runs once Alpine initializes the element).
  const logPane = (notConfigured || readErr) ? '' : `
    <div class="card surface-target card-pad">
      <pre x-data x-init="$el.scrollTop = $el.scrollHeight" class="${PRE_CLS}">${escapeHtml(logText && logText.length ? logText : '(log is empty)')}</pre>
    </div>`;

  return `
    ${pageHeader('Web App Logs', 'The Web App application log (logs/app.log) on the configured host.')}
    ${notConfigured ? '' : controlsBar(lines)}
    ${banner}
    ${logPane}
  `;
}

module.exports = function (appConfig) {
  const router = express.Router();

  router.get('/web-app-logs', requireAdmin, async (req, res) => {
    const user = req.session.user;

    let lines = parseInt(req.query.lines, 10);
    if (!LINE_OPTIONS.includes(lines)) lines = DEFAULT_LINES;

    let logText = '', readErr = null, notConfigured = false, accessDesc = '';

    if (!webAppAccess.isConfigured(appConfig)) {
      notConfigured = true;
    } else {
      try {
        const accessor = webAppAccess.createAccessorFromConfig(appConfig);
        accessDesc = accessor.describe();
        // Run from the install dir so the relative logs/app.log resolves the
        // same way the Web App's own scripts reference it.
        const r = await accessor.runCommand(`tail -n ${lines} ${LOG_REL_PATH}`, {
          cwd: accessor.appPath || undefined,
          timeoutMs: 30000,
          comment: 'web app logs'
        });
        if (r.timedOut) {
          readErr = 'Timed out reading the log from the Web App host.';
        } else if (r.code === 0) {
          logText = r.stdout || '';
        } else {
          readErr = (r.stderr || '').trim() ||
            `Could not read ${LOG_REL_PATH} (exit ${r.code}). Check that the file exists and the Web App directory path is correct.`;
        }
      } catch (err) {
        readErr = err.message || String(err);
      }
    }

    const body = renderBody({ logText, lines, readErr, notConfigured, accessDesc });
    res.send(page({ title: 'Web App Logs', body, appConfig, user, activeNav: 'web-app-logs' }));
  });

  return router;
};
