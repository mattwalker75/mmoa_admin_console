// middleware/csrf.js — per-session CSRF token (synchroniser-token pattern).
//
// Defence in depth on top of app.js's Origin / Sec-Fetch-Site check and the
// SameSite=strict session cookie. The token lives in the (client-side,
// signed) cookie-session as req.session.csrf — 32 random bytes as hex. It is
// minted lazily on the first request that lacks one (the login page needs
// one before anyone is signed in), survives login (cookie-session has no
// server-side store to rotate against, and the cookie is signed), and goes
// away with the session on logout (req.session = null), so the next visit
// mints a fresh one.
//
// How the token reaches the browser — both done centrally in
// views/layout.js page(), so route files need no changes:
//   * <meta name="csrf-token" content="…"> in every rendered <head>;
//     public/js/csrf.js reads it and adds an X-CSRF-Token header to every
//     same-origin, state-changing fetch() (JSON calls, multipart uploads).
//   * <input type="hidden" name="_csrf" value="…"> injected into every
//     <form method="POST"> in the rendered page.
//
// Validation (csrfProtection, mounted in app.js after cookie-session and the
// body parsers, before the routes): POST / PUT / PATCH / DELETE must carry the
// session's token in the X-CSRF-Token header or as the _csrf body field.
// Multipart bodies are parsed later by multer, so a multipart request can
// only satisfy this with the header — every upload in the console goes
// through fetch (public/js/csrf.js also re-submits the few native
// multipart forms through fetch for that reason). Anything else → 403 with a
// JSON body for JSON / XHR callers and a short HTML page otherwise, plus a
// `[csrf]` warning in the log. _csrf is deleted from req.body after the check
// so handlers that copy req.body wholesale never see it.
//
// page() has no access to req, so the request is published through an
// AsyncLocalStorage for the duration of the request: currentToken() reads it
// from there (and re-mints a token if a route dropped the session before
// rendering — GET /login does that for a stale cookie).

'use strict';

const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');
const { escapeHtml } = require('../views/escapeHtml');

const requestStore = new AsyncLocalStorage();

const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const TOKEN_RE = /^[0-9a-f]{64}$/;
const ERROR_MESSAGE = 'Invalid or missing CSRF token — reload the page and try again.';

function newToken() {
  return crypto.randomBytes(32).toString('hex');
}

// The session's token, minting one when the session has none. If a route
// has already cleared the session on this request (req.session = null) a
// new, token-only session is started so the page being rendered and the
// cookie that goes with it agree.
function ensureToken(req) {
  if (!req) return '';
  let sess = req.session;
  if (!sess || typeof sess !== 'object') {
    req.session = {};
    sess = req.session;
  }
  if (typeof sess.csrf !== 'string' || !TOKEN_RE.test(sess.csrf)) sess.csrf = newToken();
  return sess.csrf;
}

// Token for the request currently being rendered ('' outside a request —
// e.g. page() called from a script or a unit test).
function currentToken() {
  const store = requestStore.getStore();
  return store ? ensureToken(store.req) : '';
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function wantsJson(req) {
  return (req.get('accept') || '').includes('application/json') ||
         (req.get('content-type') || '').includes('application/json') ||
         req.get('x-requested-with') === 'XMLHttpRequest';
}

// Where the "go back" link on the HTML refusal page points: the referring
// console page when the Referer is same-origin, else the dashboard.
function backLink(req) {
  const ref = req.get('referer');
  if (!ref) return '/';
  try {
    const u = new URL(ref);
    const ownHost = String(req.host || req.get('host') || '').toLowerCase();
    if (u.host.toLowerCase() === ownHost) return u.pathname + u.search;
  } catch (e) { /* fall through */ }
  return '/';
}

function refuse(req, res, why) {
  console.warn(`[csrf] refused ${req.method} ${req.originalUrl} from ${req.ip}: ${why}`);
  if (wantsJson(req)) return res.status(403).json({ ok: false, success: false, error: ERROR_MESSAGE });
  const back = backLink(req);
  res.status(403).type('html').send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Request refused</title>
    <link rel="stylesheet" href="/css/tailwind.css"></head>
    <body class="min-h-screen flex items-center justify-center"><div class="card card-pad text-center max-w-md"><h2 class="text-lg font-semibold">Request refused</h2><p class="mt-2 text-sm text-slate-600">${escapeHtml(ERROR_MESSAGE)}</p><p class="mt-2"><a class="text-brand-600 hover:underline" href="${escapeHtml(back)}">← Go back</a></p></div></body></html>`);
}

function csrfProtection(req, res, next) {
  const expected = ensureToken(req);
  requestStore.run({ req }, () => {
    if (!STATE_CHANGING.has(req.method)) return next();
    const header = req.get('x-csrf-token');
    let bodyToken;
    if (req.body && typeof req.body === 'object' && Object.prototype.hasOwnProperty.call(req.body, '_csrf')) {
      bodyToken = req.body._csrf;
      // Never let the token reach a handler (some copy req.body wholesale).
      delete req.body._csrf;
    }
    const sent = typeof header === 'string' && header ? header
               : typeof bodyToken === 'string' ? bodyToken : '';
    if (sent && safeEqual(sent, expected)) return next();
    refuse(req, res, sent ? 'token mismatch' : 'no token');
  });
}

module.exports = { csrfProtection, currentToken, ensureToken, ERROR_MESSAGE };
