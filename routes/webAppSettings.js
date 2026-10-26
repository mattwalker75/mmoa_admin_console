// routes/webAppSettings.js — edit the REMOTE Web App's config.json
// from this console, plus Start / Stop / Restart the Web App process.
//
//   GET  /web-app-settings            → redirect to …/general
//   GET  /web-app-settings/:tab       → read remote config.json, render
//                                             the section's form
//   POST /web-app-settings/:tab       → read → mutate only this section's
//                                             keys → write config.json back
//   POST /web-app-settings/power      → run a lifecycle command (JSON)
//
// The remote file is reached via helpers/webAppAccess.js (local / SSH /
// EC2-SSM, configured under Settings → Web App). Each save does a fresh
// read-modify-write so unexposed keys, `_comment` notes, secrets, and
// sessionKeys in the remote file are preserved (helpers/webAppConfig.js).
// A save that leaves the file byte-identical is not written at all.
//
// Ported from car_show_admin_console/routes/controlPlaneSettings.js minus
// the Payments (Stripe) and AWS-provisioning tabs and the AWS settings sync.
// The web app's only AWS use is optional SES email, so its credentials sit
// in an "AWS (SES credentials)" group on the Email tab.

const express = require('express');
const { page, flash, waRestartPrompt } = require('../views/layout');
const { escapeHtml } = require('../views/escapeHtml');
const { websiteLinkCard, resolveWebsiteAddress, prefetchWebsiteAddress } = require('../helpers/websiteCard');
const { requireAdmin } = require('../middleware/auth');
const webAppAccess = require('../helpers/webAppAccess');
const waConfig = require('../helpers/webAppConfig');
// This router has no db of its own: the audit trail goes through the
// recorder routes/audit.js captures when app.js mounts it.
const { record: audit } = require('./audit');

const WA_TABS = [
  { key: 'general',  label: 'General' },
  { key: 'email',    label: 'Email' },
  { key: 'security', label: 'Security' },
  { key: 'database', label: 'Database' },
  { key: 'server',   label: 'Server' }
];

function tabLabel(key) {
  const t = WA_TABS.find(x => x.key === key);
  return t ? t.label : key;
}

// ── Field descriptors per tab ─────────────────────────────────────────────
// path  = dotted key into the remote config.json (also the form field name,
//         unless `name` is set).
// type  = text | password | number | toggle | tristate | select | textarea | heading
//   tristate = null / true / false (rendered as a select). Used for
//              security.session.secure, where null means "follow server.ssl".
const FIELDS = {
  general: [
    { path: 'appTitle', label: 'App title', type: 'text', tokens: ['appTitle'] },
    { path: 'appSubtitle', label: 'App subtitle', type: 'text', tokens: ['appSubtitle'] },
    { path: 'orgName', label: 'Organization name', type: 'text', hint: 'Legal name shown in the footer and emails, e.g. Mission Men of Anna Inc.', tokens: ['orgName'] },
    { path: 'publicBaseUrl', label: 'Public base URL', type: 'text', hint: 'Used in verification / password-reset links, e.g. https://missionmenofanna.org' },
    { path: 'port', label: 'Port', type: 'number', min: 1, max: 65535, def: 3004 },
    { path: 'sessionKeyMode', label: 'Session key mode', type: 'select', options: [['auto-generate', 'auto-generate'], ['fixed', 'fixed']] },
    { path: 'sessionMaxAgeHours', label: 'Session max age (hours)', type: 'number', min: 1, max: 720, def: 8 },
    { path: 'passwordResetTokenTtlHours', label: 'Password reset token TTL (hours)', type: 'number', min: 1, max: 720, def: 2 },
    { path: 'allowMemberRegistration', label: 'Allow new nonprofit sign-ups', type: 'toggle', def: true, hint: 'Off hides the website\'s nonprofit sign-up; existing logins keep working.' },
    { path: 'maintenanceCommand', label: 'Maintenance Command', type: 'text', hint: 'Command run on the Web App server (from its install directory) to put it into / take it out of maintenance. Default ./scripts/maintenance.sh' },
    { type: 'heading', label: 'Public site info', hint: 'Shown in the website header / footer (GET /api/site). Each value marked with a token can also be placed in any Web App Website section as {{token}} — the website fills it in.' },
    { path: 'site.phone', label: 'Phone', type: 'text', hint: 'e.g. (972) 555-0100 — leave blank to show no phone on the site', tokens: ['phone', 'phoneTel'], tokenNote: '{{phoneTel}} is the digits-only form for tel: links.' },
    { path: 'site.email', label: 'Public email', type: 'text', hint: 'A contact address for the public, e.g. info@missionmenofanna.org', tokens: ['email'] },
    { path: 'site.ein', label: 'EIN', type: 'text', hint: 'e.g. 33-4035685', tokens: ['ein'] },
    { path: 'site.tagline', label: 'Tagline', type: 'text', hint: 'A short motto, e.g. Men in service of the people of Anna', tokens: ['tagline'] },
    { path: 'site.foundedYear', label: 'Founded (year)', type: 'text', hint: 'e.g. 2024', tokens: ['foundedYear'] },
    { path: 'site.meetingInfo', label: 'Meeting info', type: 'text', hint: 'When and where MMoA meets, e.g. 2nd Tuesday of the month, 7 PM, Anna Community Center', tokens: ['meetingInfo'] },
    { type: 'heading', label: 'Mailing address', hint: 'Optional. Each part is its own token; {{address}} is the whole thing on one line.' },
    { path: 'site.addressLine1', label: 'Address line 1', type: 'text', hint: 'e.g. PO Box 123', tokens: ['addressLine1', 'address'] },
    { path: 'site.addressLine2', label: 'Address line 2', type: 'text', tokens: ['addressLine2'] },
    { path: 'site.city', label: 'City', type: 'text', hint: 'e.g. Anna', tokens: ['city'] },
    { path: 'site.state', label: 'State', type: 'text', hint: 'e.g. TX', tokens: ['state'] },
    { path: 'site.zip', label: 'ZIP', type: 'text', hint: 'e.g. 75409', tokens: ['zip'] },
    { type: 'heading', label: 'Social links', hint: 'Optional. Only http(s) links are used; a bad value leaves the token empty.' },
    { path: 'site.facebookUrl', label: 'Facebook page URL', type: 'text', hint: 'e.g. https://www.facebook.com/missionmenofanna', tokens: ['facebookUrl'] },
    { path: 'site.instagramUrl', label: 'Instagram URL', type: 'text', hint: 'e.g. https://www.instagram.com/missionmenofanna', tokens: ['instagramUrl'] },
    { path: 'site.youtubeUrl', label: 'YouTube URL', type: 'text', tokens: ['youtubeUrl'] },
    { path: 'site.xUrl', label: 'X (Twitter) URL', type: 'text', tokens: ['xUrl'] },
    { path: 'site.nextdoorUrl', label: 'Nextdoor URL', type: 'text', tokens: ['nextdoorUrl'] },
    { type: 'heading', label: 'Header buttons' },
    { path: 'site.needHelpEnabled', label: 'Show the "Need Help?" button', type: 'toggle', def: true,
      hint: 'The green "Need Help?" button in the website header, plus the "Find help" links on the home page and the not-found page. Off hides them; the Need Help directory pages still work for anyone with a link (nonprofit profiles, previews).' },
    { type: 'heading', label: 'Donations' },
    { path: 'site.donationEnabled', label: 'Show the "Donate" button', type: 'toggle', def: false, controller: true,
      hint: 'Adds a "Donate" button to the website header that opens the donation link below in a new tab. Needs a valid link to turn on.',
      guard: { js: () => donationUrlErrorJs("c['site.donationUrl']"), server: json => donationUrlError(waConfig.getPath(json, 'site.donationUrl')) } },
    { path: 'site.donationUrl', label: 'Donation link', type: 'text', controller: true, hint: 'A payment link for donations, e.g. a Stripe Payment Link (https://donate.stripe.com/…).', tokens: ['donationUrl'], tokenNote: 'Empty on the website while the Donate button is off.' },
    { path: 'uploads.maxMb', label: 'Max image upload (MB)', type: 'number', min: 1, max: 8, def: 8, hint: 'Server-side cap for nonprofit portal photo uploads (browsers shrink photos before sending). The console always allows up to 8 MB.' }
  ],
  email: [
    { path: 'email.transport', label: 'Transport', type: 'select', controller: true, options: [['console', 'console (dev → log)'], ['smtp', 'SMTP'], ['ses', 'AWS SES']] },
    { path: 'email.from', label: 'From (no-reply sender)', type: 'text' },
    { path: 'email.replyTo', label: 'Reply-To', type: 'text' },
    { path: 'email.showLinksInBrowser', label: 'Show email links in the browser (TESTING / TEMPORARY)', type: 'toggle', def: false, hint: 'TESTING / TEMPORARY — while email isn\'t set up, the sign-up, resend-verification and forgot-password responses ALSO return the link and the site shows it on screen, so anyone can complete those flows without the mailbox. The email is still sent. Turn OFF once email delivery works.' },
    { type: 'heading', label: 'Console transport', hint: 'Emails are written to the Web App log (logs/app.log). No extra configuration needed.', showWhen: "c['email.transport'] === 'console'" },
    { type: 'heading', label: 'AWS SES', hint: 'SES sends using the AWS credentials & region in the "AWS (SES credentials)" group below.', showWhen: "c['email.transport'] === 'ses'" },
    { type: 'heading', label: 'SMTP', showWhen: "c['email.transport'] === 'smtp'" },
    { path: 'email.smtp.host', label: 'Host', type: 'text', showWhen: "c['email.transport'] === 'smtp'" },
    { path: 'email.smtp.port', label: 'Port', type: 'number', min: 1, max: 65535, def: 587, showWhen: "c['email.transport'] === 'smtp'" },
    { path: 'email.smtp.secure', label: 'Use TLS (secure)', type: 'toggle', def: false, showWhen: "c['email.transport'] === 'smtp'" },
    { path: 'email.smtp.user', label: 'User', type: 'text', showWhen: "c['email.transport'] === 'smtp'" },
    { path: 'email.smtp.password', label: 'Password', type: 'password', showWhen: "c['email.transport'] === 'smtp'" },
    { type: 'heading', label: 'AWS (SES credentials)', hint: 'Only used when Transport is AWS SES. The web app never creates or modifies AWS resources — SES sending is its only AWS use.' },
    { path: 'aws.runningInAws', label: 'Deployed in AWS (use instance profile)', type: 'toggle', def: false, controller: true },
    { path: 'aws.accessKeyId', label: 'Access key ID', type: 'text', showWhen: "!c['aws.runningInAws']" },
    { path: 'aws.secretAccessKey', label: 'Secret access key', type: 'password', showWhen: "!c['aws.runningInAws']" },
    { path: 'aws.region', label: 'SES region', type: 'text', hint: 'e.g. us-east-1' }
  ],
  security: [
    { path: 'passwordMinLength', label: 'Minimum password length', type: 'number', min: 6, max: 128, def: 8 },
    { path: 'security.verificationLinkExpiresMinutes', label: 'Verification link expiry (minutes)', type: 'number', min: 1, max: 10080, def: 60 },
    { type: 'heading', label: 'Login throttling (per IP)' },
    { path: 'security.rateLimiting.auth.maxAttempts', label: 'Max failed attempts', type: 'number', min: 1, max: 1000, def: 10 },
    { path: 'security.rateLimiting.auth.windowSeconds', label: 'Window (seconds)', type: 'number', min: 30, max: 86400, def: 300 },
    { type: 'heading', label: 'Login lockout', hint: 'Locks a nonprofit login / IP after repeated failures. Current locks are listed under Locked Users.' },
    { path: 'security.loginLockout.enabled', label: 'Enabled', type: 'toggle', def: true, controller: true },
    { path: 'security.loginLockout.maxFailures', label: 'Failures before lockout', type: 'number', min: 1, max: 1000, def: 10, showWhen: "c['security.loginLockout.enabled']" },
    { path: 'security.loginLockout.lockoutSeconds', label: 'Lockout duration (seconds)', type: 'number', min: 10, max: 86400, def: 300, showWhen: "c['security.loginLockout.enabled']" },
    { type: 'heading', label: 'Session cookie' },
    { path: 'security.session.secure', label: 'Secure (HTTPS only)', type: 'tristate', def: null, options: [['auto', 'Auto (follow Server → SSL)'], ['true', 'On'], ['false', 'Off']] },
    { path: 'security.session.httpOnly', label: 'HTTP-only', type: 'toggle', def: true },
    { path: 'security.session.sameSite', label: 'SameSite', type: 'select', options: [['strict', 'strict'], ['lax', 'lax'], ['none', 'none']] },
    { type: 'heading', label: 'HTTP headers' },
    { path: 'security.headers.enabled', label: 'Security headers (helmet)', type: 'toggle', def: true, controller: true },
    { path: 'security.headers.contentSecurityPolicy', label: 'Content Security Policy', type: 'toggle', def: true, showWhen: "c['security.headers.enabled']" }
  ],
  database: [
    { path: 'database.engine', label: 'Engine', type: 'select', controller: true, options: [['sqlite', 'SQLite'], ['mysql', 'MySQL']], hint: 'Takes effect after a Web App restart. This is the WEB APP\'s own setting — this console\'s connection is under Settings → Web App.' },
    { type: 'heading', label: 'SQLite', showWhen: "c['database.engine'] === 'sqlite'" },
    { path: 'database.sqlite.filename', label: 'Filename', type: 'text', hint: 'Relative to the web app directory. Default mmoa_web_app.db', showWhen: "c['database.engine'] === 'sqlite'" },
    { type: 'heading', label: 'MySQL', showWhen: "c['database.engine'] === 'mysql'" },
    { path: 'database.mysql.host', label: 'Host', type: 'text', showWhen: "c['database.engine'] === 'mysql'" },
    { path: 'database.mysql.port', label: 'Port', type: 'number', min: 1, max: 65535, def: 3306, showWhen: "c['database.engine'] === 'mysql'" },
    { path: 'database.mysql.database', label: 'Database', type: 'text', showWhen: "c['database.engine'] === 'mysql'" },
    { path: 'database.mysql.user', label: 'User', type: 'text', showWhen: "c['database.engine'] === 'mysql'" },
    { path: 'database.mysql.password', label: 'Password', type: 'password', showWhen: "c['database.engine'] === 'mysql'" },
    { path: 'database.mysql.connectionLimit', label: 'Connection limit', type: 'number', min: 1, max: 200, def: 10, showWhen: "c['database.engine'] === 'mysql'" }
  ],
  server: [
    { path: 'server.ssl', label: 'Enable SSL/TLS', type: 'toggle', def: false, controller: true, hint: 'Takes effect after a Web App restart. Leave off behind a TLS-terminating load balancer.' },
    { path: 'server.keyPath', label: 'TLS key path', type: 'text', showWhen: "c['server.ssl']" },
    { path: 'server.certPath', label: 'TLS cert path', type: 'text', showWhen: "c['server.ssl']" },
    { path: 'server.trustProxy', label: 'Trust proxy (hops)', type: 'number', min: 0, max: 10, def: 1, hint: 'Number of reverse proxies / load balancers in front of the web app (Express "trust proxy"). 0 = off. 1 = one ALB / nginx.' }
  ]
};

const TEXTAREA_CLS = 'block w-full font-mono text-xs rounded-lg border border-slate-200 bg-white px-3 py-2 text-slate-900 shadow-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100';

// ── Render one field from its descriptor + the current remote JSON ─────────
// Donation link check (server side of a toggle `guard`; the browser copy is
// donationUrlErrorJs below). Same rule as the web app's
// safeHttpUrl: an http(s) URL with a dotted host name. '' = OK.
const DONATION_URL_MSG = 'Enter a valid donation link (starting with https://) before turning on the Donate button.';
function donationUrlError(v) {
  try {
    const u = new URL(String(v || '').trim());
    return /^https?:$/.test(u.protocol) && /\.[a-z]{2,}$/i.test(u.hostname) ? '' : DONATION_URL_MSG;
  } catch (e) { return DONATION_URL_MSG; }
}

// Browser copy of donationUrlError as an Alpine expression (the console's
// CSP allows no inline <script>, but Alpine expressions run via eval).
function donationUrlErrorJs(arg) {
  const m = JSON.stringify(DONATION_URL_MSG);
  return `(function (v) { try { var u = new URL(String(v || '').trim()); `
    + `return /^https?:$/.test(u.protocol) && /\\.[a-z]{2,}$/i.test(u.hostname) ? '' : ${m}; } catch (e) { return ${m}; } })(${arg})`;
}

// "Website token" line under a field whose value the website also exposes
// as a {{token}} in the Web App Website sections (routes/public.js
// contentTokens on the web app side — keep the two in step).
function tokenHtml(d) {
  if (!d.tokens || !d.tokens.length) return '';
  const codes = d.tokens.map(t => `<code class="font-mono rounded bg-emerald-50 dark:bg-emerald-950/50 border border-emerald-200 dark:border-emerald-900 px-1.5 py-0.5 text-emerald-800 dark:text-emerald-200 select-all">{{${escapeHtml(t)}}}</code>`).join(' ');
  return `<p class="mt-1.5 text-xs text-slate-600 dark:text-slate-300"><span class="font-semibold text-emerald-700 dark:text-emerald-300">Website token:</span> ${codes}
    <span class="text-slate-500 dark:text-slate-400">— paste it into any <a class="text-brand-600 hover:underline" href="/web-app-website">Web App Website</a> section.${d.tokenNote ? ' ' + escapeHtml(d.tokenNote) : ''}</span></p>`;
}

function fieldHtml(d, json) {
  if (d.type === 'heading') {
    return `<div class="pt-2 border-t border-slate-200 dark:border-slate-800 first:border-0 first:pt-0">
      <h3 class="text-sm font-semibold text-slate-900 dark:text-slate-100">${escapeHtml(d.label)}</h3>
      ${d.hint ? `<p class="mt-0.5 text-xs text-slate-500 dark:text-slate-400">${escapeHtml(d.hint)}</p>` : ''}
    </div>`;
  }

  const name = d.name || d.path;
  const raw = waConfig.getPath(json, d.path);
  const hintHtml = (d.hint ? `<p class="mt-1 text-xs text-slate-500 dark:text-slate-400">${escapeHtml(d.hint)}</p>` : '') + tokenHtml(d);
  // A "controller" field binds its live value into the form's Alpine `c` map
  // (keyed by path) so dependent groups can x-show off it as the operator edits.
  const model = d.controller ? `x-model="c['${d.path}']"` : '';

  let val = (raw === undefined || raw === null) ? (d.def !== undefined ? d.def : '') : raw;
  // A boolean stored where we now render a number (e.g. a legacy
  // `trustProxy: true`) shows as 1 / 0 so the input stays valid.
  if (d.type === 'number' && typeof val === 'boolean') val = val ? 1 : 0;

  if (d.type === 'tristate') {
    const cur = raw === true ? 'true' : raw === false ? 'false' : 'auto';
    const opts = d.options.map(([v, lab]) =>
      `<option value="${escapeHtml(v)}" ${cur === v ? 'selected' : ''}>${escapeHtml(lab)}</option>`).join('');
    return `<div><label class="label">${escapeHtml(d.label)}</label><select class="input" name="${name}">${opts}</select>${hintHtml}</div>`;
  }

  if (d.type === 'toggle') {
    const checked = (raw === undefined ? !!d.def : !!raw);
    // A `guard` refuses to switch the toggle ON while its expression returns
    // an error message: the switch flips back off and the message shows
    // under it. The form re-checks on submit; the server re-checks on save.
    const guard = d.guard
      ? `data-guard="${escapeHtml(d.guard.js())}" x-on:change="guardToggle($event.target, '${d.path}')"`
      : '';
    return `<div class="py-1">
      <div class="flex items-center gap-3">
        <label class="toggle"><input type="checkbox" name="${name}" value="on" ${checked ? 'checked' : ''} ${model} ${guard}><span class="slider"></span></label>
        <div>
          <div class="text-sm text-slate-900 dark:text-slate-100">${escapeHtml(d.label)}</div>
          ${d.hint ? `<div class="text-xs text-slate-500 dark:text-slate-400">${escapeHtml(d.hint)}</div>` : ''}
          ${tokenHtml(d)}
        </div>
      </div>
      ${d.guard ? `<p class="mt-2 flash-error text-sm" role="alert" x-show="errs['${d.path}']" x-text="errs['${d.path}']" x-cloak></p>` : ''}
    </div>`;
  }

  if (d.type === 'select') {
    const opts = d.options.map(([v, lab]) =>
      `<option value="${escapeHtml(v)}" ${String(val) === String(v) ? 'selected' : ''}>${escapeHtml(lab)}</option>`).join('');
    return `<div><label class="label">${escapeHtml(d.label)}</label><select class="input" name="${name}" ${model}>${opts}</select>${hintHtml}</div>`;
  }

  if (d.type === 'textarea') {
    return `<div><label class="label">${escapeHtml(d.label)}</label>
      <textarea name="${name}" rows="${d.rows || 4}" spellcheck="false" class="${TEXTAREA_CLS}">${escapeHtml(String(val))}</textarea>${hintHtml}</div>`;
  }

  const inputType = d.type === 'password' ? 'password' : (d.type === 'number' ? 'number' : 'text');
  const numAttrs = d.type === 'number'
    ? `${d.min !== undefined ? `min="${d.min}"` : ''} ${d.max !== undefined ? `max="${d.max}"` : ''}`
    : '';
  const ac = d.type === 'password' ? 'autocomplete="off"' : '';
  return `<div><label class="label">${escapeHtml(d.label)}</label>
    <input class="input" type="${inputType}" name="${name}" value="${escapeHtml(String(val))}" ${numAttrs} ${ac} ${model}>${hintHtml}</div>`;
}

// ── Apply one field from the POST body onto the remote JSON (mutates) ───────
function applyField(d, json, b) {
  if (d.type === 'heading') return;
  const name = d.name || d.path;

  if (d.type === 'toggle') {
    waConfig.setPath(json, d.path, b[name] === 'on');
    return;
  }
  if (d.type === 'tristate') {
    const v = b[name];
    if (v === 'true') waConfig.setPath(json, d.path, true);
    else if (v === 'false') waConfig.setPath(json, d.path, false);
    else if (v === 'auto') waConfig.setPath(json, d.path, null);
    // anything else (absent / tampered) → leave the stored value alone
    return;
  }
  if (d.type === 'number') {
    const n = parseInt(b[name], 10);
    const cur = waConfig.getPath(json, d.path);
    const ok = Number.isInteger(n) && (d.min === undefined || n >= d.min) && (d.max === undefined || n <= d.max);
    waConfig.setPath(json, d.path, ok ? n : (Number.isInteger(cur) ? cur : (d.def !== undefined ? d.def : 0)));
    return;
  }
  if (d.type === 'select') {
    const allowed = d.options.map(o => o[0]);
    const v = b[name];
    const cur = waConfig.getPath(json, d.path);
    waConfig.setPath(json, d.path, allowed.includes(v) ? v : (allowed.includes(cur) ? cur : (d.def !== undefined ? d.def : allowed[0])));
    return;
  }
  if (d.type === 'textarea') {
    waConfig.setPath(json, d.path, String(b[name] || '').replace(/\r\n/g, '\n'));
    return;
  }
  if (d.type === 'password') {
    // Pre-filled in the form, so an unchanged submit round-trips the value.
    waConfig.setPath(json, d.path, b[name] !== undefined ? String(b[name]) : (waConfig.getPath(json, d.path) || ''));
    return;
  }
  // text
  waConfig.setPath(json, d.path, String(b[name] || '').trim());
}

// ── UI building blocks ─────────────────────────────────────────────────────
function pageHeader(title, subtitle) {
  return `<header class="mb-6">
    <h1 class="text-2xl font-bold text-slate-900 dark:text-slate-100">${escapeHtml(title)}</h1>
    ${subtitle ? `<p class="mt-1 text-sm text-slate-500 dark:text-slate-400">${escapeHtml(subtitle)}</p>` : ''}
  </header>`;
}

function waTabsNav(active) {
  const tab = (key, label) => {
    const cls = key === active ? 'btn-primary' : 'btn-secondary';
    return `<form method="GET" action="/web-app-settings/${key}" class="inline">
      <button type="submit" class="${cls} min-w-[120px]">${escapeHtml(label)}</button>
    </form>`;
  };
  return `<nav class="flex flex-wrap gap-3 mb-8">${WA_TABS.map(t => tab(t.key, t.label)).join('')}</nav>`;
}

function powerBar(cmds, restartPending) {
  const c = cmds || {};
  const btn = (action, label, color) => {
    const has = !!(c[action] && String(c[action]).trim());
    return `<button type="button" class="${color} disabled:opacity-50 disabled:cursor-not-allowed"
            :disabled="!!busy || ${has ? 'false' : 'true'}"
            ${has ? '' : 'title="No command configured — set it under Settings → Web App"'}
            x-on:click="run('${action}')">
        <span x-show="busy !== '${action}'">${escapeHtml(label)}</span>
        <span x-show="busy === '${action}'">Working…</span>
      </button>`;
  };
  return `<div class="card surface-target card-pad mb-6" x-data="{
      busy: '', running: false, lastAction: '', result: null,
      async run(action) {
        if (this.busy) return;
        if (!(await window.uiConfirm('Run the ' + action + ' command on the Web App?', { title: 'Web App power', confirmLabel: 'Run' }))) return;
        this.busy = action; this.lastAction = action; this.result = null; this.running = true;
        try {
          const r = await fetch('/web-app-settings/power', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify({ action })
          });
          this.result = await r.json().catch(() => ({ ok: false, error: 'Bad response from server' }));
        } catch (e) {
          this.result = { ok: false, error: 'Network error: ' + (e.message || e) };
        } finally { this.busy = ''; this.running = false; }
      }
    }">
    <div class="flex items-center justify-between gap-4 flex-wrap">
      <div>
        <h2 class="text-base font-semibold text-slate-900 dark:text-slate-100">Web App process</h2>
        ${restartPending ? `<span class="inline-flex items-center gap-1 mt-1 text-xs font-medium px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300"
              x-show="!(result && result.ok && (lastAction === 'restart' || lastAction === 'start'))">⟳ Restart pending — config changed since the last restart</span>` : ''}
        <p class="mt-0.5 text-xs text-slate-500 dark:text-slate-400">Runs the lifecycle commands configured under <a href="/settings/web-app" class="text-brand-600 hover:underline">Settings → Web App</a>.</p>
      </div>
      <div class="flex items-center gap-2">
        ${btn('start', 'Start Web App', 'btn-primary')}
        ${btn('stop', 'Stop Web App', 'btn-danger')}
        ${btn('restart', 'Restart Web App', 'btn-secondary')}
      </div>
    </div>
    <div x-show="running" x-cloak class="mt-4 rounded-lg border border-brand-300 bg-brand-50 dark:bg-brand-900/40 dark:border-brand-800 p-3">
      <div class="text-sm font-semibold text-brand-800 dark:text-brand-200">⏳ Running the <span x-text="lastAction"></span> command on the Web App…</div>
    </div>
    <div x-show="!running && result" x-cloak class="mt-4 rounded-lg border p-3"
         :class="result && result.ok ? 'border-emerald-300 bg-emerald-50 dark:bg-emerald-950/40 dark:border-emerald-900' : 'border-red-300 bg-red-50 dark:bg-red-950/40 dark:border-red-900'">
      <div class="text-sm font-semibold"
           :class="result && result.ok ? 'text-emerald-800 dark:text-emerald-200' : 'text-red-800 dark:text-red-200'"
           x-text="result ? ((result.ok ? 'Command succeeded' : 'Command failed') + (result.code != null ? ' (exit ' + result.code + ')' : '')) : ''"></div>
      <p x-show="result && result.error" class="mt-1 text-sm text-red-700 dark:text-red-300 break-words whitespace-pre-wrap" x-text="result && result.error"></p>
      <p x-show="result && result.timedOut" class="mt-1 text-xs text-amber-600 dark:text-amber-400">Timed out waiting for the command to finish; it may still be running on the host.</p>
      <template x-if="result && result.stdout">
        <div class="mt-2"><div class="text-xs text-slate-500 dark:text-slate-400">stdout</div>
          <pre class="font-mono text-xs whitespace-pre-wrap break-all bg-white/60 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded p-2 max-h-40 overflow-auto" x-text="result.stdout"></pre></div>
      </template>
      <template x-if="result && result.stderr">
        <div class="mt-2"><div class="text-xs text-slate-500 dark:text-slate-400">stderr</div>
          <pre class="font-mono text-xs whitespace-pre-wrap break-all bg-white/60 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded p-2 max-h-40 overflow-auto" x-text="result.stderr"></pre></div>
      </template>
    </div>
  </div>`;
}

function renderBody({ tab, json, readErr, notConfigured, accessDesc, query, cmds, restartPending, siteAddr }) {
  // ?wa=1 means the Web App's config.json actually changed (and so a
  // restart is now pending); ?saved=1 alone means the form was saved but
  // the remote file came out identical — nothing was edited.
  const saved = !query.saved ? ''
    : query.wa
      ? `<div class="flash-ok mb-4">Saved to the Web App's <code class="font-mono">config.json</code>.</div>`
      : `<div class="flash-ok mb-4">Saved. The Web App's <code class="font-mono">config.json</code> is unchanged — no restart needed.</div>`;

  let banner;
  if (notConfigured) {
    banner = `<div class="flash-error mb-6"><strong class="font-semibold">Web App access is not configured.</strong> Set how this console reaches the Web App under <a class="underline" href="/settings/web-app">Settings → Web App</a> first.</div>`;
  } else if (readErr) {
    banner = `<div class="flash-error mb-6"><strong class="font-semibold">Could not load the Web App config.</strong> ${escapeHtml(readErr)}</div>`;
  } else {
    banner = `<div class="mb-6 text-xs text-slate-500 dark:text-slate-400">Editing <code class="font-mono">config.json</code> via ${escapeHtml(accessDesc)}.</div>`;
  }

  // Seed the Alpine `c` map with each controller's current value so dependent
  // groups (x-show) render correctly on first paint and react to edits.
  const cInit = {};
  if (json) {
    for (const d of FIELDS[tab]) {
      if (!d.controller) continue;
      const raw = waConfig.getPath(json, d.path);
      if (d.type === 'toggle') {
        cInit[d.path] = (raw === undefined ? !!d.def : !!raw);
      } else if (d.type === 'select') {
        const allowed = d.options.map(o => o[0]);
        const v = (raw === undefined || raw === null) ? (d.def !== undefined ? d.def : allowed[0]) : raw;
        cInit[d.path] = allowed.includes(String(v)) ? String(v) : (d.def !== undefined ? d.def : allowed[0]);
      } else {
        cInit[d.path] = (raw === undefined || raw === null) ? '' : String(raw);
      }
    }
  }

  const form = json ? `
    ${waTabsNav(tab)}
    <form method="POST" action="/web-app-settings/${tab}" class="space-y-6 max-w-3xl"
          data-cinit="${escapeHtml(JSON.stringify(cInit))}"
          x-data="{ c: {}, errs: {}, init() { this.c = JSON.parse(this.$el.dataset.cinit); },
            guardMsg(el) { return el.checked ? (new Function('c', 'return ' + el.dataset.guard))(this.c) : ''; },
            guardToggle(el, path) { const e = this.guardMsg(el); this.errs[path] = e; if (e) { el.checked = false; this.c[path] = false; } },
            checkGuards(ev) { let bad = null;
              this.$el.querySelectorAll('input[data-guard]').forEach(el => { const e = this.guardMsg(el); this.errs[el.name] = e; if (e && !bad) bad = el; });
              if (bad) { ev.preventDefault(); bad.focus(); } } }"
          x-on:submit="checkGuards($event)">
      <section class="card surface-target card-pad space-y-4">
        ${FIELDS[tab].map(d => {
          const h = fieldHtml(d, json);
          return d.showWhen ? `<div x-show="${d.showWhen}" x-transition x-cloak>${h}</div>` : h;
        }).join('\n')}
      </section>
      <div class="flex justify-end">
        <button type="submit" class="btn-primary">Save ${escapeHtml(tabLabel(tab))} settings</button>
      </div>
    </form>` : '';

  return `
    ${pageHeader('Web App Settings', 'Configure the Web App application by editing its config.json — no need to log into it.')}
    ${powerBar(cmds, restartPending)}
    ${json ? `<div class="mb-6 max-w-3xl">${websiteLinkCard(siteAddr || json.publicBaseUrl)}</div>` : ''}
    ${flash('error', query.error)}
    ${saved}
    ${waRestartPrompt(!!query.wa)}
    ${banner}
    ${form}
  `;
}

module.exports = function (appConfig, appConfigModule) {
  const router = express.Router();

  router.get('/web-app-settings', requireAdmin, (req, res) => {
    res.redirect('/web-app-settings/general');
  });

  // POST power must be registered before POST /:tab so 'power' isn't matched
  // as a tab.
  router.post('/web-app-settings/power', requireAdmin, express.json(), async (req, res) => {
    const action = (req.body && req.body.action) || '';
    if (!['start', 'stop', 'restart'].includes(action)) {
      return res.status(400).json({ ok: false, error: 'Invalid action' });
    }
    const cmds = (appConfig.webApp && appConfig.webApp.commands) || {};
    const cmd = (cmds[action] || '').trim();
    if (!cmd) {
      return res.status(400).json({ ok: false, error: `No ${action} command is configured. Set it under Settings → Web App.` });
    }
    if (!webAppAccess.isConfigured(appConfig)) {
      return res.status(400).json({ ok: false, error: 'Web App access is not configured (Settings → Web App).' });
    }
    try {
      const accessor = webAppAccess.createAccessorFromConfig(appConfig);
      // Lifecycle commands run FROM the Web App install directory
      // (appPath), so commands like `nohup ./START_APP.sh &` resolve.
      const r = await accessor.runCommand(cmd, {
        cwd: accessor.appPath || undefined,
        timeoutMs: 120000,
        comment: `web app ${action}`
      });
      // A successful restart (or start) means the web app booted on the current
      // config.json — nothing written is pending any more.
      if (r.code === 0 && (action === 'restart' || action === 'start') && waConfig.isRestartPending(appConfig)) {
        appConfig.webApp.restartPending = false;
        appConfigModule.save();
      }
      await audit(req, 'webapp.power', { kind: 'webapp', id: action, label: `Web App ${action}`,
        summary: `${action} — exit code ${r.code}${r.timedOut ? ' (timed out)' : ''}` });
      res.json({ ok: r.code === 0, code: r.code, stdout: r.stdout, stderr: r.stderr, timedOut: !!r.timedOut });
    } catch (err) {
      console.error('[web-app-settings] power failed:', err);
      await audit(req, 'webapp.power', { kind: 'webapp', id: action, label: `Web App ${action}`, summary: `${action} — could not run the command` });
      res.status(500).json({ ok: false, error: err.message || 'Command failed' });
    }
  });

  router.get('/web-app-settings/:tab', requireAdmin, async (req, res) => {
    const user = req.session.user;
    const tab = WA_TABS.find(t => t.key === req.params.tab) ? req.params.tab : 'general';
    const cmds = (appConfig.webApp && appConfig.webApp.commands) || {};

    let json = null, readErr = null, notConfigured = false, accessDesc = '';
    if (!webAppAccess.isConfigured(appConfig)) {
      notConfigured = true;
    } else {
      prefetchWebsiteAddress(appConfig); // EC2: load balancer lookup alongside the config read
      try {
        const accessor = webAppAccess.createAccessorFromConfig(appConfig);
        accessDesc = accessor.describe();
        const r = await waConfig.readRemoteConfig(accessor);
        json = r.json;
        accessDesc += ' · ' + r.path;
      } catch (err) {
        readErr = err.message || String(err);
      }
    }

    const siteAddr = json ? await resolveWebsiteAddress(appConfig, json) : null;
    const body = renderBody({
      tab, json, readErr, notConfigured, accessDesc, query: req.query, cmds,
      restartPending: waConfig.isRestartPending(appConfig), siteAddr
    });
    res.send(page({ title: 'Web App Settings', body, appConfig, user, activeNav: 'web-app-settings' }));
  });

  router.post('/web-app-settings/:tab', requireAdmin, async (req, res) => {
    const tab = WA_TABS.find(t => t.key === req.params.tab) ? req.params.tab : null;
    if (!tab) return res.redirect('/web-app-settings/general');
    if (!webAppAccess.isConfigured(appConfig)) {
      return res.redirect(`/web-app-settings/${tab}?error=` + encodeURIComponent('Configure Web App access first (Settings → Web App).'));
    }
    try {
      const b = req.body || {};
      const accessor = webAppAccess.createAccessorFromConfig(appConfig);
      const { json } = await waConfig.readRemoteConfig(accessor);
      const before = JSON.stringify(json);
      for (const d of FIELDS[tab]) applyField(d, json, b);
      // Guarded toggles may only be ON when their check passes (e.g. the
      // Donate button needs a valid link). Nothing is written on failure.
      for (const d of FIELDS[tab]) {
        if (!d.guard || !waConfig.getPath(json, d.path)) continue;
        const msg = d.guard.server(json);
        if (msg) return res.redirect(`/web-app-settings/${tab}?error=` + encodeURIComponent(msg));
      }
      // Only touch the Web App when the form actually changed its
      // config.json. A Save with nothing edited must not rewrite the remote
      // file — and must not ask for a restart the web app doesn't need.
      const changed = JSON.stringify(json) !== before;
      if (changed) {
        await waConfig.writeRemoteConfig(accessor, json);
        // The web app won't see this until it restarts (config is read at
        // boot): flag it so the power bar shows "Restart pending" and the
        // reloaded page prompts.
        waConfig.markWebAppWritten(appConfig);
        appConfigModule.save();
      }
      // Audit: which of this tab's keys changed — names only, never values
      // (the Email and AWS tabs hold passwords / secret keys).
      const beforeJson = JSON.parse(before);
      const keys = FIELDS[tab].filter(d => d.type !== 'heading' && d.path)
        .map(d => d.path)
        .filter(p => JSON.stringify(waConfig.getPath(beforeJson, p) ?? null) !== JSON.stringify(waConfig.getPath(json, p) ?? null));
      await audit(req, 'webapp_settings.save', { kind: 'webapp_settings', id: tab, label: `Web App Settings → ${(WA_TABS.find(t => t.key === tab) || {}).label || tab}`,
        summary: changed ? `Changed: ${[...new Set(keys)].join(', ') || '(keys outside the form)'} — written to the Web App's config.json, restart pending` : 'Saved, nothing changed' });
      res.redirect(`/web-app-settings/${tab}?saved=1` + (changed ? '&wa=1' : ''));
    } catch (err) {
      console.error('[web-app-settings] save failed:', err);
      res.redirect(`/web-app-settings/${tab}?error=` + encodeURIComponent(err.message || 'Save failed'));
    }
  });

  return router;
};

// Check values from somewhere other than this form (a restored backup)
// against the same limits the form enforces: number ranges, select
// options and guarded toggles (e.g. the Donate button needs a valid link).
// Only the given top-level keys are checked. Returns [error, …].
module.exports.validateConfigValues = function validateConfigValues(json, keys) {
  const errs = [];
  const want = new Set(keys || []);
  for (const tab of Object.keys(FIELDS)) {
    for (const d of FIELDS[tab]) {
      if (!d.path || d.type === 'heading' || !want.has(d.path.split('.')[0])) continue;
      const v = waConfig.getPath(json, d.path);
      if (v === undefined || v === null || v === '') continue;
      if (d.type === 'number' && (!Number.isInteger(v) || (d.min !== undefined && v < d.min) || (d.max !== undefined && v > d.max))) {
        errs.push(`${d.path}: ${JSON.stringify(v)} is outside ${d.min ?? '…'}–${d.max ?? '…'}`);
      } else if (d.type === 'select' && !d.options.map(o => o[0]).includes(v)) {
        errs.push(`${d.path}: ${JSON.stringify(v)} is not one of ${d.options.map(o => o[0]).join(', ')}`);
      } else if (d.type === 'toggle' && typeof v !== 'boolean') {
        errs.push(`${d.path}: must be true or false`);
      } else if (d.guard && v === true) {
        const m = d.guard.server(json);
        if (m) errs.push(`${d.path}: ${m}`);
      }
    }
  }
  return errs;
};
