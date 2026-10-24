// app.js — entry point for the mmoa_admin_console.
//
// Ported from car_show_admin_console/app.js: only /login (and the first-run
// /setup gate) is public; everything else requires admin auth. The console
// manages the separate mmoa_web_app — its database, config.json, website
// fragments, logs, and process — locally, over SSH, or via AWS SSM.
// The cookie name is intentionally different ('mac_session' vs the web
// app's 'mw_session') so a browser can be logged into both apps
// simultaneously without one clobbering the other.

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');

const express = require('express');
const compression = require('compression');
const helmet = require('helmet');
const morgan = require('morgan');
const cookieSession = require('cookie-session');
const rateLimit = require('express-rate-limit');

const appConfigModule = require('./config/appConfig');
const { appConfig } = appConfigModule;
const { init: initDb } = require('./db/database');
const { enforceInputLimits } = require('./middleware/inputLimits');
const { csrfProtection } = require('./middleware/csrf');
const localAdmins = require('./helpers/localAdmins');
const { escapeHtml } = require('./views/escapeHtml');

const db = initDb(appConfig);

const app = express();

if (appConfig.server && appConfig.server.trustProxy) {
  app.set('trust proxy', appConfig.server.trustProxy === true ? 1 : appConfig.server.trustProxy);
}

// Helmet's defaults add HSTS and the CSP `upgrade-insecure-requests`
// directive, which make the browser rewrite every request — the stylesheet,
// Alpine, even the post-login redirect — to https://. When the console is
// served over plain HTTP (server.ssl false) nothing answers there: the pages
// render unstyled and the login redirect "can't connect". Send both only
// when the console really serves HTTPS.
const servesHttps = !!(appConfig.server && appConfig.server.ssl) ||
  /^https:\/\//i.test(appConfig.publicBaseUrl || '');
if (appConfig.security && appConfig.security.headers && appConfig.security.headers.enabled !== false) {
  app.use(helmet({
    strictTransportSecurity: servesHttps,
    // Helmet's default is `no-referrer`, under which browsers serialise the
    // Origin header of a same-origin form POST (navigation, not fetch) as
    // the literal `null` — which the cross-site check below would refuse,
    // login form included. `same-origin` keeps the Referer inside the
    // console (nothing is sent to other sites) and keeps Origin intact.
    referrerPolicy: { policy: 'same-origin' },
    contentSecurityPolicy: appConfig.security.headers.contentSecurityPolicy === false ? false : {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        // Alpine.js compiles its inline directive expressions through
        // `new Function(...)`, which requires 'unsafe-eval'. Without it,
        // x-text / :style / x-show all silently fail (no percentages on
        // the opacity sliders, no live preview update, etc.). 'blob:' is
        // permitted for object-URLs created from staged image uploads
        // so the Appearance preview can show them before save.
        scriptSrc: ["'self'", "'unsafe-eval'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        connectSrc: ["'self'"],
        formAction: ["'self'"],
        // null removes helmet's default directive (see servesHttps above).
        upgradeInsecureRequests: servesHttps ? [] : null
      }
    },
    crossOriginEmbedderPolicy: false
  }));
}

app.use(compression());

morgan.token('ts', () => {
  const d = new Date();
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
         `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
});
// Morgan's tokens resolve AFTER the response has finished. Reading
// req.session at that point trips a side effect inside cookie-session
// (Cookies.get refreshes the expiry cookie via res.setHeader), which
// throws ERR_HTTP_HEADERS_SENT because headers are already flushed. We
// stash the username on req while the request is still in-flight (see
// the middleware just after cookieSession below) and the token reads
// that snapshot instead.
morgan.token('user', (req) => req._loggedUser || 'anon');
app.use(morgan('[:ts] :remote-addr - :user - :method :url HTTP/:http-version :status - - :response-time ms'));

let sessionKeys = appConfig.sessionKeys || [];
if (appConfig.sessionKeyMode !== 'fixed' || !sessionKeys[0] || !sessionKeys[1] ||
    sessionKeys[0].startsWith('change-this') || sessionKeys[1].startsWith('change-this')) {
  if (appConfig.sessionKeyMode === 'fixed') {
    console.warn('[session] sessionKeyMode=fixed but keys are missing or placeholders — falling back to auto-generated');
  }
  sessionKeys = [crypto.randomBytes(32).toString('hex'), crypto.randomBytes(32).toString('hex')];
}

const sessionSecCfg = (appConfig.security && appConfig.security.session) || {};
// `secure` follows servesHttps unless config.json says true / false
// explicitly (null / missing = auto). The cookie's maxAge is what the browser
// enforces; middleware/auth.js sessionProblem enforces the same
// sessionMaxAgeHours server-side from the iat stamped at login.
const cookieSecure = (sessionSecCfg.secure === undefined || sessionSecCfg.secure === null)
  ? servesHttps : !!sessionSecCfg.secure;
app.use(cookieSession({
  name: 'mac_session',
  keys: sessionKeys,
  maxAge: (appConfig.sessionMaxAgeHours || 8) * 60 * 60 * 1000,
  httpOnly: sessionSecCfg.httpOnly !== false,
  secure: cookieSecure,
  sameSite: sessionSecCfg.sameSite || 'strict'
}));

// ── Cross-site request check (CSRF defence in depth) ──────────────────────
// First of the CSRF layers (the per-session token check, middleware/csrf.js,
// is mounted further down once the body parsers have run; the cookie is
// SameSite=strict and the CSP has form-action 'self'). A state-changing
// request that a browser labels as coming from somewhere else is refused
// here before its body is even parsed:
//   * Origin present and not this host  → 403 (a cross-site form post /
//     fetch; 'null' counts as foreign — unless the browser itself labels
//     the request Sec-Fetch-Site: same-origin, a header only the browser
//     sets, which is how a same-origin form POST looks under a
//     `no-referrer` referrer policy; see the helmet referrerPolicy note)
//   * Sec-Fetch-Site present and neither same-origin nor none → 403
//     ('none' = typed URL / bookmark; 'same-site' is a sibling subdomain,
//     which is still not this console)
// A request with NEITHER header passes — curl, scripts, old browsers. The
// console's own forms, Alpine fetches and the image-upload XHR are all
// same-origin, so they carry a matching Origin / 'same-origin'.
const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
app.use((req, res, next) => {
  if (!STATE_CHANGING.has(req.method)) return next();
  const origin = req.get('origin');
  const fetchSite = (req.get('sec-fetch-site') || '').toLowerCase();
  let reason = null;
  if (origin !== undefined && !(origin === 'null' && fetchSite === 'same-origin')) {
    let originHost = null;
    try { originHost = new URL(origin).host.toLowerCase(); } catch (e) { originHost = null; }
    // req.host honours X-Forwarded-Host only when trust proxy is set.
    const ownHost = String(req.host || req.get('host') || '').toLowerCase();
    if (!originHost || !ownHost || originHost !== ownHost) reason = `Origin ${origin} does not match host ${ownHost || '(none)'}`;
  }
  if (!reason && fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') {
    reason = `Sec-Fetch-Site ${fetchSite}`;
  }
  if (!reason) return next();
  console.warn(`[csrf] refused ${req.method} ${req.originalUrl} from ${req.ip}: ${reason}`);
  const wantsJson = (req.get('accept') || '').includes('application/json') ||
                    (req.get('content-type') || '').includes('application/json');
  if (wantsJson) return res.status(403).json({ ok: false, success: false, error: 'Cross-site request refused.' });
  res.status(403).type('text/plain').send('Cross-site request refused.');
});

// Capture the signed-in username while the request is still in flight,
// so morgan's :user token can read it without touching req.session at
// log time. See the matching comment on morgan.token('user', ...) above.
app.use((req, res, next) => {
  try {
    req._loggedUser = (req.session && req.session.user && req.session.user.username) || null;
  } catch (e) { /* leave _loggedUser unset */ }
  next();
});

// 64 KB is enough for the largest forms: a website HTML fragment (JSON
// POST from Web App Website), a pasted SSH private key, a Data Browser row
// with long TEXT columns, and an event / raffle form with its Markdown
// description. Everything else is well under 10 KB. Image uploads are
// multipart (multer, 8 MB) and don't go through these parsers.
app.use(express.urlencoded({ extended: false, limit: '64kb' }));
app.use(express.json({ limit: '64kb' }));
app.use(enforceInputLimits);

const authRl = appConfig.security && appConfig.security.rateLimiting && appConfig.security.rateLimiting.auth;
if (authRl) {
  // Count only FAILED login attempts. The login route sets
  // `req.loginFailed = true` when credentials are rejected; on a
  // successful login the flag stays falsy and the limiter rolls back the
  // increment for that request.
  const authLimiter = rateLimit({
    windowMs: (authRl.windowSeconds || 300) * 1000,
    max: authRl.maxAttempts || 10,
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    requestWasSuccessful: (req /*, res*/) => !req.loginFailed
  });
  app.use(['/login'], authLimiter);
}

app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));

// Never let the browser cache dynamic HTML. Admin pages are session- and
// state-specific, and a stale cached page — Safari's back/forward cache in
// particular — can keep serving old client-side JS after a restart/deploy,
// making fixes appear to "not work". Static assets are served above with
// their own maxAge + mtime cache-buster, so this only affects rendered pages
// and JSON responses. no-store also opts the page out of bfcache.
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, must-revalidate');
  next();
});

// ── CSRF token (middleware/csrf.js) ──────────────────────────────────────
// Mints req.session.csrf on first sight and, for POST / PUT / PATCH /
// DELETE, requires it back as the X-CSRF-Token header or the _csrf body
// field (403 otherwise). It sits after cookie-session and the urlencoded /
// JSON parsers (so a plain form's _csrf field is readable) and before every
// route, including the multer ones — a multipart body isn't parsed yet
// here, so uploads send the header (public/js/csrf.js does that for every
// fetch and re-submits the native multipart forms through fetch). The
// setup gate below is covered too: /setup renders through page(), so its
// form carries the token. Static files were served above, so they never
// start a session.
app.use(csrfProtection);

// ── First-run setup gate ────────────────────────────────────────────────
// While zero local admins exist, redirect every non-static, non-/setup
// request to /setup so the operator is forced to create the break-glass
// admin first. Once at least one local admin is configured, this gate
// short-circuits and normal routing takes over.
app.use((req, res, next) => {
  if (req.path.startsWith('/css/') || req.path.startsWith('/js/') || req.path === '/favicon.ico') return next();
  if (localAdmins.count() > 0) return next();
  // count is 0. That's EITHER a genuine first run (open /setup) OR the
  // credential file exists but is corrupt/unreadable (loadAll returned []).
  // In the corrupt case, fail CLOSED: do not offer the unauthenticated setup
  // flow, or anyone could mint a new admin by damaging the file.
  if (localAdmins.fileError()) {
    return res.status(503).send('local_admins.json exists but is corrupt or unreadable. Restore it from backup (or fix the JSON) and restart — the first-run setup flow is intentionally NOT offered, to avoid creating an unauthorized admin.');
  }
  if (req.path === '/setup') return next();
  // Don't redirect non-GET methods — return 403 so a stray POST during
  // first-run doesn't bounce silently to the setup form.
  if (req.method !== 'GET') return res.status(403).send('First-run setup required — open / in a browser to begin.');
  res.redirect('/setup');
});

app.use('/', require('./routes/setup')(appConfig));
app.use('/', require('./routes/public')(db, appConfig));
app.use('/', require('./routes/settings')(db, appConfig, appConfigModule));
app.use('/', require('./routes/templates')(appConfig, appConfigModule));
app.use('/', require('./routes/webAppSettings')(appConfig, appConfigModule));
app.use('/', require('./routes/webAppLogs')(appConfig));
app.use('/', require('./routes/webAppWebsite')(appConfig, db));
app.use('/', require('./routes/lockedUsers')(db, appConfig));
app.use('/', require('./routes/dataBrowser')(db, appConfig));
app.use('/', require('./routes/reports')(db, appConfig));
app.use('/', require('./routes/backup')(db, appConfig, appConfigModule));
app.use('/', require('./routes/profile')(appConfig));
app.use('/', require('./routes/uploads')(appConfig));
app.use('/', require('./routes/events')(db, appConfig));
app.use('/', require('./routes/raffles')(db, appConfig));
app.use('/', require('./routes/nonprofits')(db, appConfig));
app.use('/', require('./routes/directory')(db, appConfig));
app.use('/', require('./routes/board')(db, appConfig));
app.use('/', require('./routes/admin')(db, appConfig));
app.use('/', require('./routes/audit')(db, appConfig));

app.use((req, res) => {
  res.status(404).send(`<!DOCTYPE html><html><head><title>Not found</title>
    <link rel="stylesheet" href="/css/tailwind.css"></head>
    <body class="min-h-screen flex items-center justify-center"><div class="card card-pad text-center"><h2 class="text-lg font-semibold">Not found</h2><p class="mt-2"><a class="text-brand-600 hover:underline" href="/">← Home</a></p></div></body></html>`);
});

// Final error handler. Express's default one renders err.stack (file paths,
// module names) into the response whenever NODE_ENV isn't 'production'.
// Log the full error here; the client gets a generic page — JSON for the
// console's fetch-based endpoints (they send Accept / Content-Type JSON),
// HTML otherwise. 4xx errors raised by the body parsers (bad JSON, body too
// large) keep their status and their short, safe message.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = Number.isInteger(err && err.status) && err.status >= 400 && err.status < 600 ? err.status
               : Number.isInteger(err && err.statusCode) && err.statusCode >= 400 && err.statusCode < 600 ? err.statusCode
               : 500;
  const safeMsg = status < 500 && err && err.expose && typeof err.message === 'string' && err.message
    ? err.message : 'Something went wrong. The error has been logged.';
  console.error(`[error] ${req.method} ${req.originalUrl} → ${status}:`, (err && err.stack) || err);
  if (res.headersSent) return res.end();
  const wantsJson = (req.get('accept') || '').includes('application/json') ||
                    (req.get('content-type') || '').includes('application/json') ||
                    (req.get('x-requested-with') === 'XMLHttpRequest');
  if (wantsJson) return res.status(status).json({ ok: false, success: false, error: safeMsg });
  res.status(status).send(`<!DOCTYPE html><html><head><title>Error</title>
    <link rel="stylesheet" href="/css/tailwind.css"></head>
    <body class="min-h-screen flex items-center justify-center"><div class="card card-pad text-center max-w-md"><h2 class="text-lg font-semibold">${status < 500 ? 'Request rejected' : 'Something went wrong'}</h2><p class="mt-2 text-sm text-slate-600">${escapeHtml(safeMsg)}</p><p class="mt-2"><a class="text-brand-600 hover:underline" href="/">← Home</a></p></div></body></html>`);
});

const port = appConfig.port || 3005;
const useSsl = !!(appConfig.server && appConfig.server.ssl);

let server;
if (useSsl) {
  // SSL is explicitly enabled. Both the key and the cert must be configured
  // AND present on disk — anything missing is a HARD failure. We refuse to
  // bring the web UI online rather than silently falling back to plaintext
  // HTTP (which would defeat the operator's intent to serve over TLS).
  const { keyPath, certPath } = appConfig.server;
  const problems = [];
  if (!keyPath) problems.push('server.keyPath is not set');
  else if (!fs.existsSync(keyPath)) problems.push(`server.keyPath file does not exist: ${keyPath}`);
  if (!certPath) problems.push('server.certPath is not set');
  else if (!fs.existsSync(certPath)) problems.push(`server.certPath file does not exist: ${certPath}`);

  if (problems.length) {
    console.error('[boot] FATAL: SSL is enabled (server.ssl = true) but the TLS files are not usable:');
    for (const p of problems) console.error(`[boot]   • ${p}`);
    console.error('[boot] Fix the paths in config.json (or set server.ssl to false) and restart. The web UI was NOT started.');
    process.exit(1);
  }

  let opts;
  try {
    opts = {
      key: fs.readFileSync(keyPath),
      cert: fs.readFileSync(certPath)
    };
  } catch (err) {
    console.error('[boot] FATAL: SSL is enabled but the TLS files could not be read:');
    console.error(`[boot]   • ${err.message}`);
    console.error('[boot] Fix the file permissions/paths in config.json (or set server.ssl to false) and restart. The web UI was NOT started.');
    process.exit(1);
  }
  server = https.createServer(opts, app);
} else {
  server = http.createServer(app);
}

server.listen(port, () => {
  const scheme = useSsl ? 'https' : 'http';
  console.log(`[boot] ${appConfig.appTitle || 'MMoA Admin Console'} listening on ${scheme}://localhost:${port}`);
  console.log(`[boot] database: ${db.engine}`);
});

// ── Crash safety + graceful shutdown ──────────────────────────────────────
// Long operations (a bundle backup/restore, a remote SQLite transaction over
// SSM) run as background work inside a request. A stray rejection must NOT
// silently terminate the process mid-operation — keep the process alive on a
// rejection; on a truly uncaught exception the state may be corrupt, so drain
// and exit for a clean supervisor restart.
let _shuttingDown = false;
function shutdown(signal, code = 0) {
  if (_shuttingDown) return;
  _shuttingDown = true;
  console.log(`[shutdown] ${signal} received — closing server`);
  const force = setTimeout(() => { console.error('[shutdown] forced exit after timeout'); process.exit(code); }, 10000);
  server.close(() => { clearTimeout(force); console.log('[shutdown] server closed'); process.exit(code); });
}
process.on('unhandledRejection', (reason) => {
  console.error('[fatal] UNHANDLED REJECTION (kept alive):', (reason && reason.stack) || reason);
});
process.on('uncaughtException', (err) => {
  console.error('[fatal] UNCAUGHT EXCEPTION:', (err && err.stack) || err);
  shutdown('uncaughtException', 1);
});
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
