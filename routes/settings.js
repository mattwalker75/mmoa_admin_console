// routes/settings.js — admin-facing configuration editor for THIS console.
//
// Sub-pages, organized as tab-style buttons inside the Settings section:
//   /settings/security   → login throttling + password rules
//   /settings/appearance → theme mode + login/app backgrounds + opacity
//   /settings/web-app    → Web App access mode (local/ssh/ec2) + DATABASE +
//                          lifecycle commands + Test connection. The console
//                          uses the web app's own DB, so its config + access
//                          semantics follow the Web App access mode.
//
// (No AWS tab: unlike the reference car_show_admin_console, this console
// provisions nothing in AWS. The only AWS use is SSM Run Command in the
// Web App's "Remote on EC2" access mode, configured on the Web App tab.)
//
// Database changes require a restart (the connection is wired at boot).
// Appearance changes are read on every request from appConfig.theme by
// views/layout.js so they take effect immediately with no restart.
//
// File uploads: the Appearance form is multipart/form-data because the
// background images are optional file fields. Multer parses them and
// writes images into public/images/ (gitignored). Only the relative URL
// (/images/<filename>) is persisted in config.json.

const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { page, flash } = require('../views/layout');
const { escapeHtml } = require('../views/escapeHtml');
const { requireAdmin } = require('../middleware/auth');
const awsSsm = require('../helpers/awsSsm');
const webAppAccess = require('../helpers/webAppAccess');

const imagesDir = path.join(__dirname, '..', 'public', 'images');
if (!fs.existsSync(imagesDir)) {
  try { fs.mkdirSync(imagesDir, { recursive: true }); } catch (e) { /* best effort */ }
}

const ALLOWED_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'];

const upload = multer({
  storage: multer.diskStorage({
    destination: imagesDir,
    filename(req, file, cb) {
      const ext = path.extname(file.originalname).toLowerCase();
      const safeExt = ALLOWED_EXTS.includes(ext) ? ext : '.bin';
      const base = file.fieldname.replace(/[^a-z0-9_-]/gi, '');
      cb(null, `${base}-${Date.now()}${safeExt}`);
    }
  }),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    const ok = /^image\/(png|jpe?g|gif|webp|svg\+xml)$/.test(file.mimetype);
    if (!ok) return cb(new Error('Only PNG, JPEG, GIF, WebP, or SVG images are allowed'));
    cb(null, true);
  }
});

function uploadAppearance(req, res, next) {
  const handler = upload.fields([
    { name: 'login_background_image', maxCount: 1 },
    { name: 'app_background_image', maxCount: 1 }
  ]);
  handler(req, res, (err) => {
    if (err) {
      console.error('[settings] upload error:', err.message);
      return res.redirect('/settings/appearance?error=' + encodeURIComponent(err.message));
    }
    next();
  });
}

function tabsNav(active) {
  const tab = (href, label, key) => {
    const cls = key === active ? 'btn-primary' : 'btn-secondary';
    return `<form method="GET" action="${href}" class="inline">
      <button type="submit" class="${cls} min-w-[140px]">${escapeHtml(label)}</button>
    </form>`;
  };
  return `<nav class="flex flex-wrap gap-3 mb-8">
    ${tab('/settings/security', 'Security', 'security')}
    ${tab('/settings/appearance', 'Appearance', 'appearance')}
    ${tab('/settings/web-app', 'Web App', 'web-app')}
    ${tab('/settings/templates', 'Templates', 'templates')}
  </nav>`;
}

function isSafeCssColor(v) {
  if (typeof v !== 'string') return false;
  return /^#[0-9a-fA-F]{3,8}$|^rgba?\([\d.,\s%]+\)$/.test(v.trim());
}

// Delete a stored background image from disk. Only paths under
// public/images/ with a constrained filename pattern are allowed —
// anything else (including absolute paths or paths with traversal
// segments) is refused. Errors are logged but not thrown: a save
// shouldn't fail just because the file was already gone.
function safeUnlinkUpload(relUrl) {
  if (!relUrl || typeof relUrl !== 'string') return;
  if (!/^\/images\/[A-Za-z0-9._-]+$/.test(relUrl)) {
    console.warn(`[settings] refusing to delete image at "${relUrl}" — path is not under /images/`);
    return;
  }
  const abs = path.join(imagesDir, path.basename(relUrl));
  if (!abs.startsWith(imagesDir + path.sep)) {
    console.warn(`[settings] refusing to delete image — resolved path "${abs}" escapes the images dir`);
    return;
  }
  try {
    fs.unlinkSync(abs);
    console.log(`[settings] deleted background image: ${abs}`);
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.log(`[settings] background image was already gone: ${abs}`);
    } else {
      console.warn(`[settings] failed to delete background image ${abs}: ${err.message}`);
    }
  }
}

function pageHeader(title, subtitle) {
  return `<header class="mb-6">
    <h1 class="text-2xl font-bold text-slate-900 dark:text-slate-100">${escapeHtml(title)}</h1>
    ${subtitle ? `<p class="mt-1 text-sm text-slate-500 dark:text-slate-400">${escapeHtml(subtitle)}</p>` : ''}
  </header>`;
}

module.exports = function (db, appConfig, appConfigModule) {
  const router = express.Router();

  router.get('/settings', requireAdmin, (req, res) => {
    res.redirect('/settings/security');
  });

  // ── Security settings ───────────────────────────────────────────────
  // Password complexity rules + brute-force login throttling. Password
  // rule changes take effect immediately (new/changed passwords must
  // satisfy them). Throttling changes take effect on next restart — the
  // express-rate-limit middleware is registered at boot from this config.
  router.get('/settings/security', requireAdmin, (req, res) => {
    const user = req.session.user;
    const sec = appConfig.security || {};
    const pw = sec.password || {};
    const rl = (sec.rateLimiting && sec.rateLimiting.auth) || {};
    const minLen = Number.isInteger(pw.minLength) && pw.minLength > 0 ? pw.minLength : (appConfig.passwordMinLength || 8);
    const windowSeconds = Number.isInteger(rl.windowSeconds) && rl.windowSeconds > 0 ? rl.windowSeconds : 300;
    const windowMinutes = Math.max(1, Math.round(windowSeconds / 60));
    const maxAttempts = Number.isInteger(rl.maxAttempts) && rl.maxAttempts > 0 ? rl.maxAttempts : 10;

    const toggle = (name, label, checked) => `
      <div class="flex items-center gap-3 py-2">
        <label class="toggle">
          <input type="checkbox" name="${name}" value="on" ${checked ? 'checked' : ''}>
          <span class="slider"></span>
        </label>
        <span class="text-sm text-slate-900 dark:text-slate-100">${escapeHtml(label)}</span>
      </div>
    `;

    const body = `
      ${pageHeader('Settings', 'Configure how the admin console runs.')}
      ${tabsNav('security')}

      ${flash('error', req.query.error)}
      ${flash('ok', req.query.saved && 'Settings saved.')}

      <form method="POST" action="/settings/security" class="space-y-6 max-w-3xl">

        <!-- Password complexity -->
        <section class="card surface-target card-pad space-y-4">
          <div>
            <h2 class="text-base font-semibold text-slate-900 dark:text-slate-100">Password complexity</h2>
            <p class="mt-0.5 text-xs text-slate-500 dark:text-slate-400">Applied when a console admin password is created or changed, and to nonprofit passwords set from the Nonprofits page. Existing passwords keep working until they're changed.</p>
          </div>

          <div class="grid sm:grid-cols-2 gap-4">
            <div>
              <label class="label">Minimum length</label>
              <input class="input" type="number" name="minLength" value="${minLen}" min="1" max="128">
              <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">Characters required at minimum.</p>
            </div>
          </div>

          <div class="border-t border-slate-200 dark:border-slate-800 pt-4">
            ${toggle('requireUpper', 'Require at least one uppercase letter (A–Z)', pw.requireUpper)}
            ${toggle('requireLower', 'Require at least one lowercase letter (a–z)', pw.requireLower)}
            ${toggle('requireDigit', 'Require at least one digit (0–9)', pw.requireDigit)}
            ${toggle('requireSymbol', 'Require at least one special character (e.g. ! @ # $ % …)', pw.requireSymbol)}
          </div>
        </section>

        <!-- Login throttling -->
        <section class="card surface-target card-pad space-y-4">
          <div>
            <h2 class="text-base font-semibold text-slate-900 dark:text-slate-100">Login throttling</h2>
            <p class="mt-0.5 text-xs text-slate-500 dark:text-slate-400">After too many failed attempts from a single IP, further logins from that IP are rejected for the block duration. Helps prevent bot password-spray attacks. <strong>Takes effect on next restart.</strong></p>
          </div>

          <div class="grid sm:grid-cols-2 gap-4">
            <div>
              <label class="label">Max failed attempts</label>
              <input class="input" type="number" name="maxAttempts" value="${maxAttempts}" min="1" max="1000">
              <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">Failed logins from one IP before it gets blocked.</p>
            </div>
            <div>
              <label class="label">Block duration (minutes)</label>
              <input class="input" type="number" name="windowMinutes" value="${windowMinutes}" min="1" max="1440">
              <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">How long the block stays in effect. Successful logins reset the counter for that IP.</p>
            </div>
          </div>
        </section>

        <div class="flex justify-end">
          <button type="submit" class="btn-primary">Save security settings</button>
        </div>
      </form>
    `;
    res.send(page({ title: 'Security', body, appConfig, user, activeNav: 'settings' }));
  });

  router.post('/settings/security', requireAdmin, (req, res) => {
    try {
      const b = req.body || {};
      const sec = (appConfig.security && typeof appConfig.security === 'object') ? appConfig.security : {};
      const pw = (sec.password && typeof sec.password === 'object') ? sec.password : {};
      const rl = (sec.rateLimiting && typeof sec.rateLimiting === 'object') ? sec.rateLimiting : {};
      const auth = (rl.auth && typeof rl.auth === 'object') ? rl.auth : {};

      const minLenNum = parseInt(b.minLength, 10);
      pw.minLength = Number.isInteger(minLenNum) && minLenNum > 0 && minLenNum <= 128 ? minLenNum : 8;
      pw.requireUpper = b.requireUpper === 'on';
      pw.requireLower = b.requireLower === 'on';
      pw.requireDigit = b.requireDigit === 'on';
      pw.requireSymbol = b.requireSymbol === 'on';

      const attemptsNum = parseInt(b.maxAttempts, 10);
      // Input is in minutes; internally we keep it in seconds so the
      // express-rate-limit windowMs math stays straightforward.
      const minutesNum = parseInt(b.windowMinutes, 10);
      auth.maxAttempts = Number.isInteger(attemptsNum) && attemptsNum > 0 && attemptsNum <= 1000 ? attemptsNum : 10;
      auth.windowSeconds = Number.isInteger(minutesNum) && minutesNum >= 1 && minutesNum <= 1440 ? minutesNum * 60 : 300;

      sec.password = pw;
      rl.auth = auth;
      sec.rateLimiting = rl;
      appConfig.security = sec;
      // Keep top-level passwordMinLength mirrored so any legacy code paths
      // (and the API contract documented in defaults) stay consistent.
      appConfig.passwordMinLength = pw.minLength;

      appConfigModule.save();
      res.redirect('/settings/security?saved=1');
    } catch (err) {
      console.error('[settings] security save failed:', err);
      res.redirect('/settings/security?error=Save+failed');
    }
  });

  // ── Database settings — part of the Web App tab ──────────────────────
  // The database always belongs to the web app, so its configuration lives
  // with the Web App access settings (and its semantics follow the access
  // mode). Bookmarks to the old reference URLs land on the merged tab.
  router.get(['/settings/database', '/settings/control-plane'], requireAdmin, (req, res) => {
    res.redirect('/settings/web-app');
  });

  // ── Appearance settings ─────────────────────────────────────────────
  router.get('/settings/appearance', requireAdmin, (req, res) => {
    const user = req.session.user;
    const t = appConfig.theme || {};
    const mode = t.mode === 'dark' ? 'dark' : 'light';
    const login = t.login || {};
    const appBg = t.app || {};

    const loginOpacityPct = Math.round((typeof login.cardOpacity === 'number' ? login.cardOpacity : 1) * 100);
    const appOpacityPct = Math.round((typeof appBg.surfaceOpacity === 'number' ? appBg.surfaceOpacity : 1) * 100);

    const initialState = {
      mode,
      loginColor: isSafeCssColor(login.backgroundColor) ? login.backgroundColor : '#f6f7f9',
      loginImage: login.backgroundImage || '',
      loginOpacity: loginOpacityPct,
      loginClear: false,
      appColor: isSafeCssColor(appBg.backgroundColor) ? appBg.backgroundColor : '#f6f7f9',
      appImage: appBg.backgroundImage || '',
      appOpacity: appOpacityPct,
      appClear: false,
      stagedLogin: '',
      stagedApp: ''
    };

    const body = `
      ${pageHeader('Settings', 'Configure how the admin console runs.')}
      ${tabsNav('appearance')}

      ${flash('error', req.query.error)}
      ${flash('ok', req.query.saved && 'Settings saved.')}

      <form method="POST" action="/settings/appearance" enctype="multipart/form-data"
            x-data='${JSON.stringify(initialState).replace(/'/g, "&#39;")}'
            x-init="$watch('mode', v => document.documentElement.classList.toggle('dark', v === 'dark'))"
            class="space-y-6 max-w-4xl">

        <!-- Theme -->
        <div class="card surface-target card-pad">
          <h2 class="text-base font-semibold text-slate-900 dark:text-slate-100">App theme</h2>
          <p class="mt-0.5 text-xs text-slate-500 dark:text-slate-400">Live preview — saves persist to config.json.</p>
          <div class="mt-4 flex items-center gap-4">
            <span class="text-sm" :class="mode === 'light' ? 'font-semibold' : 'text-slate-400'">Light</span>
            <label class="toggle">
              <input type="checkbox" name="mode" value="dark"
                     :checked="mode === 'dark'"
                     x-on:change="mode = $event.target.checked ? 'dark' : 'light'">
              <span class="slider"></span>
            </label>
            <span class="text-sm" :class="mode === 'dark' ? 'font-semibold' : 'text-slate-400'">Dark</span>
          </div>
        </div>

        ${appearanceBlock('Login background', 'login', login, loginOpacityPct, 'Floating login card opacity')}
        ${appearanceBlock('App background', 'app', appBg, appOpacityPct, 'Surface (card / table / tile) opacity')}

        <div class="pt-2">
          <button type="submit" class="btn-primary">Save appearance</button>
        </div>
      </form>
    `;
    res.send(page({ title: 'Appearance', body, appConfig, user, activeNav: 'settings' }));
  });

  router.post('/settings/appearance', requireAdmin, uploadAppearance, (req, res) => {
    try {
      const b = req.body || {};
      const files = req.files || {};

      const theme = (appConfig.theme && typeof appConfig.theme === 'object') ? appConfig.theme : {};
      const login = (theme.login && typeof theme.login === 'object') ? theme.login : {};
      const appBg = (theme.app && typeof theme.app === 'object') ? theme.app : {};

      theme.mode = b.mode === 'dark' ? 'dark' : 'light';

      login.backgroundColor = isSafeCssColor(b.login_background_color) ? b.login_background_color.trim() : '';
      const newLoginImg = files.login_background_image && files.login_background_image[0];
      if (newLoginImg) {
        safeUnlinkUpload(login.backgroundImage);
        login.backgroundImage = '/images/' + path.basename(newLoginImg.filename);
      } else if (b.login_background_image_clear === '1') {
        safeUnlinkUpload(login.backgroundImage);
        login.backgroundImage = '';
      }
      const loPct = parseInt(b.login_card_opacity, 10);
      login.cardOpacity = Number.isFinite(loPct) ? Math.max(0, Math.min(100, loPct)) / 100 : 1;

      appBg.backgroundColor = isSafeCssColor(b.app_background_color) ? b.app_background_color.trim() : '';
      const newAppImg = files.app_background_image && files.app_background_image[0];
      if (newAppImg) {
        safeUnlinkUpload(appBg.backgroundImage);
        appBg.backgroundImage = '/images/' + path.basename(newAppImg.filename);
      } else if (b.app_background_image_clear === '1') {
        safeUnlinkUpload(appBg.backgroundImage);
        appBg.backgroundImage = '';
      }
      const apPct = parseInt(b.app_surface_opacity, 10);
      appBg.surfaceOpacity = Number.isFinite(apPct) ? Math.max(0, Math.min(100, apPct)) / 100 : 1;

      theme.login = login;
      theme.app = appBg;
      appConfig.theme = theme;
      appConfigModule.save();

      res.redirect('/settings/appearance?saved=1');
    } catch (err) {
      console.error('[settings] appearance save failed:', err);
      res.redirect('/settings/appearance?error=Save+failed');
    }
  });

  // ── Web App settings ───────────────────────────────────────────────
  // How this console reaches the mmoa_web_app install to
  // run commands / read / write files. Three access modes (see
  // helpers/webAppAccess.js): local (same host), ssh (remote over
  // SSH/SFTP), ec2 (remote via AWS SSM). Each mode keeps its own sub-block
  // so switching modes never discards the others' values.
  router.get('/settings/web-app', requireAdmin, (req, res) => {
    const user = req.session.user;
    const wa = appConfig.webApp || {};
    const mode = ['local', 'ssh', 'ec2'].includes(wa.mode) ? wa.mode : 'local';
    const local = wa.local || {};
    const ssh = wa.ssh || {};
    const ec2 = wa.ec2 || {};
    const cmds = wa.commands || {};

    // Database settings (merged from the old Database tab) — the DB belongs
    // to the Web App, so how it's reached follows the access mode.
    const rebootNeeded = !!req.query.reboot;
    const dbCfg = appConfig.database || {};
    const dbSqlite = dbCfg.sqlite || {};
    const dbMysql = dbCfg.mysql || {};
    const initialEngine = ['sqlite', 'mysql'].includes(dbCfg.engine) ? dbCfg.engine : 'none';
    const dbStatusPill = db.available
      ? `<span class="pill-running">Connected</span>`
      : `<span class="pill-failed">Offline</span>`;

    const modeCard = (val, title, subtitle) => `
      <label class="flex items-start gap-2 rounded-lg border border-slate-200 dark:border-slate-700 p-3 cursor-pointer"
             :class="mode === '${val}' ? 'ring-2 ring-brand-500/40 border-brand-500' : ''">
        <input type="radio" name="mode" value="${val}" x-model="mode" class="mt-0.5">
        <span>
          <span class="font-medium block">${escapeHtml(title)}</span>
          <span class="text-xs text-slate-500 dark:text-slate-400">${escapeHtml(subtitle)}</span>
        </span>
      </label>`;

    const body = `
      ${pageHeader('Settings', 'Configure how the admin console runs.')}
      ${tabsNav('web-app')}

      ${flash('error', req.query.error)}
      ${flash('ok', req.query.saved && 'Settings saved.')}
      ${flash('warn', req.query.warn)}

      <!-- Restart-required popup — auto-opens when the saved database
           settings (or the access mode the database rides on) actually
           changed. The DB connection is wired once at application boot. -->
      <div x-data="{ open: ${rebootNeeded ? 'true' : 'false'} }"
           x-show="open" x-transition
           x-on:keydown.escape.window="open = false"
           class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60"
           style="display: none;">
        <div class="card surface-target card-pad w-full max-w-md" x-trap.inert.noscroll="open">
          <div class="flex items-start gap-3">
            <div class="text-2xl text-amber-500 leading-none" aria-hidden="true">⟳</div>
            <div class="flex-1 min-w-0">
              <h3 class="text-base font-semibold text-slate-900 dark:text-slate-100">Restart required</h3>
              <p class="mt-2 text-sm text-slate-700 dark:text-slate-200">
                Your settings have been saved. The database connection is
                established when the application starts, so you must
                <strong>reboot the application</strong> for the database
                changes to take effect.
              </p>
            </div>
          </div>
          <div class="mt-5 flex justify-end">
            <button type="button" class="btn-primary" x-on:click="open = false">OK</button>
          </div>
        </div>
      </div>

      <div x-data="{
             mode: '${mode}',
             engine: '${initialEngine}',
             testing: false,
             testResult: null,
             async runTest() {
               this.testing = true;
               this.testResult = null;
               try {
                 const form = this.\$refs.waForm;
                 const fd = new FormData(form);
                 const r = await fetch('/settings/web-app/test', {
                   method: 'POST',
                   body: new URLSearchParams(fd),
                   headers: { 'Accept': 'application/json' }
                 });
                 const data = await r.json().catch(() => ({ ok: false, message: 'Bad response from server' }));
                 this.testResult = data;
               } catch (e) {
                 this.testResult = { ok: false, message: 'Network error: ' + (e.message || e) };
               } finally {
                 this.testing = false;
               }
             }
           }" class="space-y-6 max-w-3xl">

        <form method="POST" action="/settings/web-app" x-ref="waForm" class="space-y-6">

          <!-- Access mode picker -->
          <section class="card surface-target card-pad space-y-4">
            <div>
              <h2 class="text-base font-semibold text-slate-900 dark:text-slate-100">Access mode</h2>
              <p class="mt-0.5 text-xs text-slate-500 dark:text-slate-400">How this console reaches the Web App to run commands, read files, and write files.</p>
            </div>
            <fieldset class="grid sm:grid-cols-3 gap-3">
              ${modeCard('local', 'Local', 'Same host as this app')}
              ${modeCard('ssh', 'Remote via SSH', 'Another server over SSH')}
              ${modeCard('ec2', 'Remote on EC2 (AWS)', 'EC2 instance via AWS SSM')}
            </fieldset>
          </section>

          <!-- Local -->
          <section x-show="mode === 'local'" x-transition class="card surface-target card-pad space-y-4">
            <div>
              <h2 class="text-base font-semibold text-slate-900 dark:text-slate-100">Local</h2>
              <p class="mt-0.5 text-xs text-slate-500 dark:text-slate-400">The Web App runs on this same machine. Commands run as the current user; files are read and written directly.</p>
            </div>
            <div>
              <label class="label">Web App directory path</label>
              <input class="input" type="text" name="local_appPath" value="${escapeHtml(local.appPath || '')}" placeholder="../mmoa_web_app" autocomplete="off">
              <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">Root of the <code class="font-mono">mmoa_web_app</code> install. Relative to this app's working directory, or an absolute path.</p>
            </div>
          </section>

          <!-- Remote via SSH -->
          <section x-show="mode === 'ssh'" x-transition class="card surface-target card-pad space-y-4">
            <div>
              <h2 class="text-base font-semibold text-slate-900 dark:text-slate-100">Remote via SSH</h2>
              <p class="mt-0.5 text-xs text-slate-500 dark:text-slate-400">Connect to a remote server over SSH/SFTP to transfer files, read files, and run commands.</p>
            </div>

            <div class="grid sm:grid-cols-3 gap-4">
              <div class="sm:col-span-2">
                <label class="label">Hostname or IP address</label>
                <input class="input" type="text" name="ssh_host" value="${escapeHtml(ssh.host || '')}" placeholder="web.example.org" autocomplete="off">
              </div>
              <div>
                <label class="label">Port</label>
                <input class="input" type="number" name="ssh_port" value="${Number.isInteger(ssh.port) && ssh.port > 0 ? ssh.port : 22}" min="1" max="65535">
              </div>
            </div>

            <div>
              <label class="label">Username</label>
              <input class="input" type="text" name="ssh_username" value="${escapeHtml(ssh.username || '')}" placeholder="ubuntu" autocomplete="off">
            </div>

            <div>
              <label class="label">SSH private key</label>
              <textarea name="sshPrivateKey" rows="8" spellcheck="false"
                        autocomplete="off"
                        class="block w-full font-mono text-xs rounded-lg border border-slate-200 bg-white px-3 py-2 text-slate-900 shadow-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
                        placeholder="-----BEGIN OPENSSH PRIVATE KEY-----&#10;…&#10;-----END OPENSSH PRIVATE KEY-----">${escapeHtml(ssh.privateKey || '')}</textarea>
              <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">Paste an <strong>unencrypted</strong> PEM private key (no passphrase). Stored in <code>config.json</code> in plain text — lock down file permissions.</p>
            </div>

            <div>
              <label class="label">Web App directory path</label>
              <input class="input" type="text" name="ssh_appPath" value="${escapeHtml(ssh.appPath || '')}" placeholder="/home/mmoa/mmoa_web_app" autocomplete="off">
              <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">Root of the <code class="font-mono">mmoa_web_app</code> install on the remote server.</p>
            </div>

            <div class="rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/40 p-3 text-xs text-slate-600 dark:text-slate-300 space-y-1">
              <div class="font-semibold text-slate-700 dark:text-slate-200">Setting up SSH (high level)</div>
              <ol class="list-decimal list-inside space-y-0.5">
                <li>On a trusted machine, generate a keypair: <code class="font-mono">ssh-keygen -t ed25519 -f web_app_key</code> (leave the passphrase empty).</li>
                <li>Add the <strong>public</strong> key (<code class="font-mono">web_app_key.pub</code>) to the remote user's <code class="font-mono">~/.ssh/authorized_keys</code>.</li>
                <li>Paste the matching <strong>private</strong> key (<code class="font-mono">web_app_key</code>) into the field above.</li>
                <li>Ensure the SSH port is reachable from this app (firewall / security group).</li>
              </ol>
            </div>
          </section>

          <!-- Remote on EC2 in AWS -->
          <section x-show="mode === 'ec2'" x-transition class="card surface-target card-pad space-y-4"
                   x-data="{ inAws: ${ec2.runningInAws ? 'true' : 'false'} }">
            <div>
              <h2 class="text-base font-semibold text-slate-900 dark:text-slate-100">Remote on EC2 in AWS</h2>
              <p class="mt-0.5 text-xs text-slate-500 dark:text-slate-400">Run all work on the Web App instance via AWS Systems Manager (SSM). The instance needs the SSM Agent running and an instance profile with <code>AmazonSSMManagedInstanceCore</code>.</p>
            </div>

            <!-- Credentials -->
            <div class="flex items-center gap-4">
              <label class="toggle">
                <input type="checkbox" name="ec2_runningInAws" value="on"
                       :checked="inAws"
                       x-on:change="inAws = \$event.target.checked">
                <span class="slider"></span>
              </label>
              <div>
                <div class="text-sm font-medium text-slate-900 dark:text-slate-100">This app is deployed in AWS</div>
                <div class="text-xs text-slate-500 dark:text-slate-400">When on, the SDK uses the attached EC2 instance profile (no access key required).</div>
              </div>
            </div>

            <div x-show="!inAws" x-transition class="space-y-3">
              <p class="text-xs text-slate-500 dark:text-slate-400">Stored in <code>config.json</code> in plain text. Lock down file permissions.</p>
              <div class="grid sm:grid-cols-2 gap-4">
                <div>
                  <label class="label">Access key ID</label>
                  <input class="input" type="text" name="ec2_accessKeyId" value="${escapeHtml(ec2.accessKeyId || '')}" autocomplete="off">
                </div>
                <div>
                  <label class="label">Secret access key</label>
                  <input class="input" type="password" name="ec2_secretAccessKey" value="${escapeHtml(ec2.secretAccessKey || '')}" autocomplete="off">
                </div>
              </div>
            </div>

            <div x-show="inAws" x-transition x-cloak class="rounded-lg border border-emerald-200 bg-emerald-50 text-emerald-800 dark:bg-emerald-950/40 dark:border-emerald-900 dark:text-emerald-200 text-xs p-3">
              Using the instance profile attached to this environment. No access key is needed.
            </div>

            <!-- Instance location -->
            <div class="grid sm:grid-cols-2 gap-4 border-t border-slate-200 dark:border-slate-800 pt-4">
              <div>
                <label class="label">Region</label>
                <input class="input" type="text" name="ec2_region" value="${escapeHtml(ec2.region || 'us-east-1')}" placeholder="us-east-1" autocomplete="off">
                <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">AWS region the Web App instance runs in.</p>
              </div>
              <div>
                <label class="label">Instance ID</label>
                <input class="input" type="text" name="ec2_instanceId" value="${escapeHtml(ec2.instanceId || '')}" placeholder="i-0123456789abcdef0" autocomplete="off"
                       pattern="^i-[0-9a-f]{8,17}$" title="EC2 instance id, e.g. i-0709475ab7ffe333e">
                <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">EC2 instance id where the Web App runs.</p>
              </div>
            </div>

            <div>
              <label class="label">Web App directory path</label>
              <input class="input" type="text" name="ec2_appPath" value="${escapeHtml(ec2.appPath || '')}" placeholder="/home/mmoa/mmoa_web_app" autocomplete="off">
              <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">Root of the <code class="font-mono">mmoa_web_app</code> install on the instance.</p>
            </div>

            <div>
              <label class="label">Run commands as user <span class="text-slate-400 text-xs font-normal">(optional)</span></label>
              <input class="input" type="text" name="ec2_runAsUser" value="${escapeHtml(ec2.runAsUser || '')}" placeholder="mmoa" autocomplete="off"
                     pattern="^[a-z_][a-z0-9_-]*\\$?$" title="A valid Linux username">
              <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">User to switch to before running commands. Leave blank to use the default SSM user.</p>
            </div>
          </section>

          <!-- Database — merged from the old Database tab. The console uses
               the SAME database as the Web App, so how it's reached
               follows the access mode above: in Local mode the SQLite file
               is opened directly; in SSH/EC2 mode queries run ON the
               Web App host through the transport (sqlite3 CLI). -->
          <section class="card surface-target card-pad space-y-4">
            <div class="flex items-start justify-between gap-3">
              <div>
                <h2 class="text-base font-semibold text-slate-900 dark:text-slate-100">Database</h2>
                <p class="mt-0.5 text-xs text-slate-500 dark:text-slate-400">The Web App's database — this console reads and writes the same data. Access follows the mode selected above. Changes take effect on the next restart.</p>
                <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">${escapeHtml(db.statusMessage || db.engine || 'not configured')}</p>
              </div>
              ${dbStatusPill}
            </div>

            <fieldset class="grid sm:grid-cols-3 gap-3">
              <label class="flex items-start gap-2 rounded-lg border border-slate-200 dark:border-slate-700 p-3 cursor-pointer"
                     :class="engine === 'none' ? 'ring-2 ring-brand-500/40 border-brand-500' : ''">
                <input type="radio" name="engine" value="none" x-model="engine" class="mt-0.5">
                <span>
                  <span class="font-medium block">None</span>
                  <span class="text-xs text-slate-500 dark:text-slate-400">Offline mode</span>
                </span>
              </label>
              <label class="flex items-start gap-2 rounded-lg border border-slate-200 dark:border-slate-700 p-3 cursor-pointer"
                     :class="engine === 'sqlite' ? 'ring-2 ring-brand-500/40 border-brand-500' : ''">
                <input type="radio" name="engine" value="sqlite" x-model="engine" class="mt-0.5">
                <span>
                  <span class="font-medium block">SQLite</span>
                  <span class="text-xs text-slate-500 dark:text-slate-400">File on the Web App host</span>
                </span>
              </label>
              <label class="flex items-start gap-2 rounded-lg border border-slate-200 dark:border-slate-700 p-3 cursor-pointer"
                     :class="engine === 'mysql' ? 'ring-2 ring-brand-500/40 border-brand-500' : ''">
                <input type="radio" name="engine" value="mysql" x-model="engine" class="mt-0.5">
                <span>
                  <span class="font-medium block">MySQL</span>
                  <span class="text-xs text-slate-500 dark:text-slate-400">Server endpoint</span>
                </span>
              </label>
            </fieldset>

            <div x-show="engine === 'sqlite'" x-transition class="space-y-3 border-t border-slate-200 dark:border-slate-800 pt-4">
              <h3 class="text-sm font-semibold">SQLite</h3>
              <div>
                <label class="label" for="sqlite_filename">SQLite file</label>
                <input id="sqlite_filename" class="input" type="text" name="sqlite_filename" value="${escapeHtml(dbSqlite.filename || '')}"
                       :placeholder="mode === 'local' ? '../mmoa_web_app/mmoa_web_app.db' : 'mmoa_web_app.db'">
                <p x-show="mode === 'local'" class="mt-1 text-xs text-slate-500 dark:text-slate-400">
                  Path on <strong>this machine</strong> — relative to this console's repo root, or absolute. The file is opened directly.
                </p>
                <p x-show="mode !== 'local'" x-cloak class="mt-1 text-xs text-slate-500 dark:text-slate-400">
                  Path on the <strong>Web App host</strong> — relative paths resolve against the Web App directory configured above.
                  Queries run on that host via the <code class="font-mono">sqlite3</code> CLI over ${mode === 'ec2' ? 'SSM' : 'the transport'}, so the CLI must be installed there.
                  Expect ~1s per query — fine for this console.
                </p>
              </div>
            </div>

            <div x-show="engine === 'mysql'" x-transition class="space-y-3 border-t border-slate-200 dark:border-slate-800 pt-4">
              <h3 class="text-sm font-semibold">MySQL</h3>
              <p x-show="mode !== 'local'" x-cloak class="text-xs text-amber-600 dark:text-amber-400">
                The endpoint must be reachable <strong>from this console</strong>. A MySQL server on a private-subnet EC2 instance needs an SSM port-forward tunnel (or a security-group path) — a bare private hostname won't connect from here.
              </p>
              <div class="grid sm:grid-cols-2 gap-3">
                <div>
                  <label class="label">Host</label>
                  <input class="input" type="text" name="mysql_host" value="${escapeHtml(dbMysql.host || 'localhost')}" maxlength="255">
                </div>
                <div>
                  <label class="label">Port</label>
                  <input class="input" type="number" name="mysql_port" value="${dbMysql.port || 3306}" min="1" max="65535">
                </div>
                <div>
                  <label class="label">Database</label>
                  <input class="input" type="text" name="mysql_database" value="${escapeHtml(dbMysql.database || '')}" maxlength="255">
                </div>
                <div>
                  <label class="label">User</label>
                  <input class="input" type="text" name="mysql_user" value="${escapeHtml(dbMysql.user || '')}" maxlength="255">
                </div>
                <div class="sm:col-span-2">
                  <label class="label">Password</label>
                  <input class="input" type="password" name="mysql_password" value="${escapeHtml(dbMysql.password || '')}" autocomplete="off" maxlength="255">
                  <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">Stored in config.json in plain text. Lock down file permissions.</p>
                </div>
                <div>
                  <label class="label">Connection limit</label>
                  <input class="input" type="number" name="mysql_connection_limit" value="${dbMysql.connectionLimit || 5}" min="1" max="200">
                </div>
              </div>
            </div>
          </section>

          <!-- Lifecycle commands — run on the Web App host (via the
               access mode above) by the Start / Stop / Restart buttons on
               the Web App Settings page. Mode-independent. -->
          <section class="card surface-target card-pad space-y-4">
            <div>
              <h2 class="text-base font-semibold text-slate-900 dark:text-slate-100">Lifecycle commands</h2>
              <p class="mt-0.5 text-xs text-slate-500 dark:text-slate-400">Shell commands run on the Web App host by the <strong>Start</strong> / <strong>Stop</strong> / <strong>Restart</strong> buttons on the <a href="/web-app-settings" class="text-brand-600 hover:underline">Web App Settings</a> page. Each command runs <strong>from the Web App directory</strong> (the path configured for the selected access mode above), so write them relative to that directory — no need to <code class="font-mono">cd</code> first. Leave a field blank to disable that button.</p>
            </div>
            <div>
              <label class="label">Start command</label>
              <textarea name="cmd_start" rows="2" spellcheck="false"
                        class="block w-full font-mono text-xs rounded-lg border border-slate-200 bg-white px-3 py-2 text-slate-900 shadow-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
                        placeholder="./START_APP.sh">${escapeHtml(cmds.start || '')}</textarea>
            </div>
            <div>
              <label class="label">Stop command</label>
              <textarea name="cmd_stop" rows="2" spellcheck="false"
                        class="block w-full font-mono text-xs rounded-lg border border-slate-200 bg-white px-3 py-2 text-slate-900 shadow-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
                        placeholder="./STOP_APP.sh">${escapeHtml(cmds.stop || '')}</textarea>
            </div>
            <div>
              <label class="label">Restart command</label>
              <textarea name="cmd_restart" rows="2" spellcheck="false"
                        class="block w-full font-mono text-xs rounded-lg border border-slate-200 bg-white px-3 py-2 text-slate-900 shadow-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
                        placeholder="./RESTART_APP.sh">${escapeHtml(cmds.restart || '')}</textarea>
            </div>
          </section>

          <div class="flex items-center justify-between gap-2">
            <button type="button" class="btn-secondary disabled:opacity-50 disabled:cursor-not-allowed"
                    :disabled="testing"
                    x-on:click="runTest()">
              <span x-show="!testing">Test connection</span>
              <span x-show="testing">Testing…</span>
            </button>
            <button type="submit" class="btn-primary">Save</button>
          </div>
        </form>

        <!-- Test result panel -->
        <div x-show="testResult" x-transition x-cloak
             class="rounded-lg border p-4"
             :class="testResult && testResult.ok
               ? 'border-emerald-300 bg-emerald-50 dark:bg-emerald-950/40 dark:border-emerald-900'
               : 'border-red-300 bg-red-50 dark:bg-red-950/40 dark:border-red-900'">
          <div class="flex items-start gap-2">
            <span class="text-lg leading-none" aria-hidden="true"
                  x-text="testResult && testResult.ok ? '✓' : '✗'"></span>
            <div class="min-w-0">
              <div class="text-sm font-semibold"
                   :class="testResult && testResult.ok ? 'text-emerald-800 dark:text-emerald-200' : 'text-red-800 dark:text-red-200'"
                   x-text="testResult && testResult.ok ? 'Connection succeeded' : 'Connection failed'"></div>
              <p class="mt-1 text-sm text-slate-700 dark:text-slate-200 break-words whitespace-pre-wrap"
                 x-text="testResult && testResult.message"></p>
            </div>
          </div>
        </div>
      </div>
    `;
    res.send(page({ title: 'Settings — Web App', body, appConfig, user, activeNav: 'settings' }));
  });

  // Build a webApp config block from posted form fields. Shared by
  // the save handler and the test endpoint. `prev` supplies the previously
  // stored values so each mode's sub-block is preserved even when another
  // mode is currently selected, and so secrets are kept when the EC2
  // credentials toggle is on.
  function webAppFromBody(b, prev) {
    const p = prev || {};
    const pLocal = p.local || {};
    const pSsh = p.ssh || {};
    const pEc2 = p.ec2 || {};
    const mode = ['local', 'ssh', 'ec2'].includes(b.mode) ? b.mode : 'local';

    const portNum = parseInt(b.ssh_port, 10);
    const runAsUser = (b.ec2_runAsUser || '').trim();

    const ec2RunningInAws = b.ec2_runningInAws === 'on';
    const ec2 = {
      runningInAws: ec2RunningInAws,
      // Preserve stored creds when the instance-profile toggle is on so
      // flipping it back off doesn't lose them (mirrors the AWS handler).
      accessKeyId: ec2RunningInAws ? (pEc2.accessKeyId || '') : (b.ec2_accessKeyId || '').trim(),
      secretAccessKey: ec2RunningInAws ? (pEc2.secretAccessKey || '') : (b.ec2_secretAccessKey || ''),
      region: (b.ec2_region || '').trim() || 'us-east-1',
      instanceId: (b.ec2_instanceId || '').trim(),
      appPath: (b.ec2_appPath || '').trim(),
      // Only accept a syntactically valid Linux username; anything else
      // (including injection attempts) collapses to "" = default user.
      runAsUser: /^[a-z_][a-z0-9_-]*\$?$/.test(runAsUser) ? runAsUser : ''
    };

    return {
      mode,
      // Bookkeeping that lives in this block but is on no form. Carry it
      // over, or a save here would silently reset it.
      restartPending: !!p.restartPending,
      local: { appPath: (b.local_appPath || '').trim() },
      ssh: {
        host: (b.ssh_host || '').trim(),
        port: Number.isInteger(portNum) && portNum >= 1 && portNum <= 65535 ? portNum : 22,
        username: (b.ssh_username || '').trim(),
        // Normalize CRLF → LF so a pasted key keeps valid PEM line endings.
        privateKey: (b.sshPrivateKey || '').replace(/\r\n/g, '\n'),
        appPath: (b.ssh_appPath || '').trim()
      },
      ec2,
      // Lifecycle commands run on the Web App host by the Start /
      // Stop / Restart buttons. CRLF→LF + trim; blank disables the button.
      commands: {
        start: (b.cmd_start || '').replace(/\r\n/g, '\n').trim(),
        stop: (b.cmd_stop || '').replace(/\r\n/g, '\n').trim(),
        restart: (b.cmd_restart || '').replace(/\r\n/g, '\n').trim()
      }
    };
  }

  // Build the database config block from posted form fields (merged from
  // the old Database tab's POST handler).
  function databaseFromBody(b, prev) {
    const p = prev || {};
    const engine = ['sqlite', 'mysql', 'none'].includes(b.engine) ? b.engine : 'none';
    const next = Object.assign({}, p);
    next.engine = engine === 'none' ? '' : engine;
    next.sqlite = Object.assign({}, p.sqlite || {}, {
      // Blank is allowed: the remote backend defaults it to mmoa_web_app.db
      // under the Web App directory; local mode keeps the old default.
      filename: (b.sqlite_filename || '').trim()
    });
    const portNum = parseInt(b.mysql_port, 10);
    const climit = parseInt(b.mysql_connection_limit, 10);
    next.mysql = Object.assign({}, p.mysql || {}, {
      host: (b.mysql_host || '').trim() || 'localhost',
      port: Number.isInteger(portNum) && portNum > 0 && portNum < 65536 ? portNum : 3306,
      database: (b.mysql_database || '').trim(),
      user: (b.mysql_user || '').trim(),
      password: b.mysql_password || '',
      connectionLimit: Number.isInteger(climit) && climit > 0 && climit <= 200 ? climit : 5
    });
    return next;
  }

  router.post('/settings/web-app', requireAdmin, async (req, res) => {
    try {
      const b = req.body || {};

      // Snapshot what the boot-time DB wiring depends on: the database block
      // itself, plus the access mode (a mode change flips a SQLite database
      // between "open the file directly" and "query via the transport").
      const prevDb = (appConfig.database && typeof appConfig.database === 'object') ? appConfig.database : {};
      const prevMode = (appConfig.webApp && appConfig.webApp.mode) || 'local';
      const dbBefore = JSON.stringify(prevDb);

      appConfig.webApp = webAppFromBody(b, appConfig.webApp || {});
      appConfig.database = databaseFromBody(b, prevDb);
      appConfigModule.save();
      // Drop any memoized SSM client so changed EC2 credentials take effect
      // without a restart.
      try { awsSsm.resetClient(); } catch (e) { /* best effort */ }

      const engineIsSqlite = (appConfig.database.engine || '') === 'sqlite';
      const localityFlipped = (prevMode === 'local') !== (appConfig.webApp.mode === 'local');
      const dbChanged = JSON.stringify(appConfig.database) !== dbBefore
        || (engineIsSqlite && localityFlipped);
      res.redirect('/settings/web-app?saved=1'
        + (dbChanged ? '&reboot=1' : '')
        );
    } catch (err) {
      console.error('[settings] web-app save failed:', err);
      res.redirect('/settings/web-app?error=Save+failed');
    }
  });

  // Test the connection using the values currently in the form (NOT the
  // saved config) so the operator can validate before committing. Returns
  // JSON { ok, message, details }.
  router.post('/settings/web-app/test', requireAdmin, async (req, res) => {
    try {
      const waBlock = webAppFromBody(req.body || {}, appConfig.webApp || {});
      const accessor = webAppAccess.createAccessor(waBlock);
      const result = await accessor.test();
      res.json(result || { ok: false, message: 'No result' });
    } catch (err) {
      console.error('[settings] web-app test failed:', err);
      res.status(500).json({ ok: false, message: err.message || 'Test failed' });
    }
  });

  return router;
};

// Renders one "background customization" block — used twice for Login and App.
// Wraps Alpine.js bindings so color, opacity, image-clear, and file-pick all
// drive the live preview without a round trip.
function appearanceBlock(title, key, cfg, opacityPct, opacityLabel) {
  const colorKey = key + 'Color';
  const imageKey = key + 'Image';
  const opacityKey = key + 'Opacity';
  const clearKey = key + 'Clear';
  const stagedKey = 'staged' + key.charAt(0).toUpperCase() + key.slice(1);
  const colorField = key + '_background_color';
  const imageField = key + '_background_image';
  const opacityField = key === 'login' ? 'login_card_opacity' : 'app_surface_opacity';

  const existingThumb = cfg.backgroundImage
    ? `<div class="mt-2 flex items-center gap-3" x-show="!${stagedKey}">
         <img src="${escapeHtml(cfg.backgroundImage)}" alt=""
              class="h-16 w-24 object-cover rounded border border-slate-200 dark:border-slate-700 transition"
              :class="${clearKey} ? 'opacity-30 grayscale' : ''">
         <label class="text-xs flex items-center gap-2 cursor-pointer">
           <input type="checkbox" name="${imageField}_clear" value="1" x-model="${clearKey}">
           <span x-text="${clearKey} ? 'Will be removed when saved' : 'Remove this image'"></span>
         </label>
       </div>`
    : '';

  return `
    <div class="card surface-target card-pad">
      <h2 class="text-base font-semibold text-slate-900 dark:text-slate-100">${escapeHtml(title)}</h2>

      <div class="mt-4 grid lg:grid-cols-2 gap-6">
        <div class="space-y-4">
          <div>
            <label class="label">Background color</label>
            <div class="flex items-center gap-3">
              <input type="color" name="${colorField}" value="${escapeHtml(cfg.backgroundColor || '#f6f7f9')}"
                     x-model="${colorKey}" class="h-10 w-16 rounded border border-slate-200 dark:border-slate-700 cursor-pointer">
              <code class="text-xs text-slate-500" x-text="${colorKey}"></code>
            </div>
            <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">Used when no background image is set.</p>
          </div>

          <div>
            <label class="label">Background image (optional)</label>
            <input type="file" name="${imageField}" accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml"
                   x-on:change="
                     if (${stagedKey}) { try { URL.revokeObjectURL(${stagedKey}) } catch(e){} }
                     ${stagedKey} = $event.target.files[0] ? URL.createObjectURL($event.target.files[0]) : ''
                   "
                   class="block w-full text-sm text-slate-600 dark:text-slate-300 file:mr-3 file:rounded-lg file:border-0 file:bg-brand-600 file:px-4 file:py-2 file:text-sm file:font-semibold file:text-white hover:file:bg-brand-700">
            <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">PNG, JPEG, GIF, WebP, or SVG — up to 8 MB. Image takes precedence over color.</p>
            ${existingThumb}
          </div>

          <div>
            <label class="label">${escapeHtml(opacityLabel)}</label>
            <div class="flex items-center gap-3">
              <input type="range" name="${opacityField}" min="0" max="100" value="${opacityPct}"
                     x-model.number="${opacityKey}" class="flex-1 accent-brand-600">
              <span class="text-sm font-semibold tabular-nums w-12 text-right"><span x-text="${opacityKey}"></span>%</span>
            </div>
            <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">0% transparent, 100% solid.</p>
          </div>
        </div>

        <div>
          <div class="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-2">Preview</div>
          <div class="relative h-48 rounded-xl overflow-hidden border border-slate-200 dark:border-slate-700 flex items-center justify-center bg-center bg-cover bg-no-repeat"
               :style="{
                 backgroundImage: (${stagedKey} || (!${clearKey} && '${escapeHtml(cfg.backgroundImage || '')}'))
                   ? ('url(\\'' + (${stagedKey} || '${escapeHtml(cfg.backgroundImage || '')}') + '\\')')
                   : '',
                 backgroundColor: (${stagedKey} || (!${clearKey} && '${escapeHtml(cfg.backgroundImage || '')}'))
                   ? ''
                   : ${colorKey}
               }">
            ${key === 'app'
              ? `<div class="absolute top-0 left-0 right-0 h-6" style="background: rgba(0,0,0,0.15)"></div>`
              : ''}
            <div class="rounded-lg shadow-lg p-4 ${key === 'app' ? 'min-w-[280px]' : 'min-w-[200px]'} flex flex-col gap-2"
                 :style="{
                   backgroundColor: 'rgba(' + (mode === 'dark' ? '15, 23, 42' : '255, 255, 255') + ', ' + (${opacityKey}/100) + ')',
                   color: mode === 'dark' ? '#f1f5f9' : '#0f172a'
                 }">
              <div class="text-xs font-bold">${key === 'app' ? 'Dashboard' : 'Login'}</div>
              <div class="h-2 rounded bg-current opacity-20"></div>
              <div class="h-2 rounded bg-current opacity-20 w-3/5"></div>
              <div class="h-3 rounded bg-brand-500 w-16 mt-1"></div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
}

// Shared with routes/templates.js (Settings → Templates).
module.exports.tabsNav = tabsNav;
