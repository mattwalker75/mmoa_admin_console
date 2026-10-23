# Security

How authentication, sessions, brute-force protection, and HTTP security
headers work in this app.

The model is deliberately small and operator-only: 1–3 humans sign in
to manage a backend. There is no public surface, no signup flow, no
password-reset email for *this console* — the member-facing flows all
live in `mmoa_web_app`.

## Auth model

### Where admins live

This console's operators live in **`local_admins.json`** at the repo
root:

```json
[
  { "username": "matt",
    "email": "matt@example.com",
    "name": "Matt Walker",
    "password_hash": "$2b$10$…" }
]
```

The file is:

- **Gitignored** (see [`.gitignore`](../.gitignore)).
- Created with `chmod 0600` on every write (best-effort —
  [helpers/localAdmins.js](../helpers/localAdmins.js) calls
  `fs.chmodSync(filePath, 0o600)` and ignores failures).
- Validated on load: rows missing a `username` or `password_hash` are
  dropped before the rest of the app sees them.

### Why a local file (and not the database)

The database is owned by `mmoa_web_app`. Putting the admin
console's own credentials there would mean:

1. Console + DB share a circular dependency: you can't reach the
   "fix the DB" page if you can't sign in, but you can't sign in if
   the DB is down.
2. Schema coupling — adding `console_admins` to a foreign team's DB.

The local file design is a **break-glass capability**: even with the
DB unreachable, an operator can log in, navigate the UI, fix the
connection from Settings → Web App (Database section), and resume.

The `users` table in the web app's DB holds nonprofit accounts (there are
no roles), not operators of this console. They cannot sign in here. See
[routes/public.js](../routes/public.js) — the login lookup is always
`localAdmins.findByUsername(...)`, never a DB query.

### Password storage

[bcrypt](https://github.com/kelektiv/node.bcrypt.js) at cost factor 10.
[middleware/auth.js](../middleware/auth.js) exports `hashPassword` and
`verifyPassword`; everything else (setup, /admins POST,
/profile/password, the CLI) goes through those.

### Password complexity

Five rules, all configurable from **Settings → Security**:

- `minLength` — integer ≥ 1.
- `requireUpper` — `[A-Z]`.
- `requireLower` — `[a-z]`.
- `requireDigit` — `[0-9]`.
- `requireSymbol` — `[^A-Za-z0-9]`.

Helper: `validatePassword(password, rules)` in
[middleware/auth.js](../middleware/auth.js). Returns `null` on success
or a single human-readable string naming the first failing rule.

`getPasswordRules(appConfig)` reads from `security.password.*` with a
fallback to the legacy top-level `passwordMinLength` so older configs
still work.

Existing passwords keep working even after the rules change — they're
verified against the bcrypt hash, not re-checked against rules. The
rules apply only when a password is **created or changed**.

Wired into:

- [routes/setup.js](../routes/setup.js) — first-run setup
- [routes/admin.js](../routes/admin.js) — `POST /admins`
- [routes/profile.js](../routes/profile.js) — `POST /profile/password`
- [scripts/create-local-admin.js](../scripts/create-local-admin.js) — CLI

The Profile page also surfaces a human-readable rules hint string
(e.g. *"Min 12 chars · 1 uppercase · 1 digit"*) under the New
password input.

## Sessions

Built on
[cookie-session](https://github.com/expressjs/cookie-session).
Signed (not encrypted) cookies named **`mac_session`** carry the
session object directly — there is no server-side session store.

Cookie attributes come from `security.session`:

- `httpOnly: true` (default)
- `secure: null` (default = **auto**: the cookie is `Secure` whenever the
  console serves HTTPS — `server.ssl` true or an `https://`
  `publicBaseUrl`. An explicit `true` / `false` in `config.json` wins.)
- `sameSite: 'strict'` (default)
- `maxAge: sessionMaxAgeHours * 60 * 60 * 1000`

Signing keys come from `appConfig.sessionKeys` when
`sessionKeyMode === 'fixed'`, otherwise two fresh 32-byte random hex
strings per process boot.

### Session shape

```js
req.session.user = {
  user_id: 'local:' + username,
  username: 'matt',
  email: 'matt@example.com',
  name: 'Matt Walker',
  role: 'admin'
}
req.session.iat = 1761150000000   // Date.now() at login
req.session.fp  = '3f9c…'         // first 16 hex of sha256(password_hash)
```

Updated by `/login` on successful sign-in and by `/profile` when the
operator changes their own name or email (so the sidebar reflects the
new value without a re-login). `fp` is refreshed when the operator
changes their own password (`/profile/password`, or re-adding
themselves on Admins) so that session survives; every other session for
that admin ends.

### `requireAdmin`

[middleware/auth.js](../middleware/auth.js). A well-formed admin session
is **re-checked against `local_admins.json` on every request**
(`sessionProblem`) — the cookie is signed, not stored server-side, so
this is the only way to revoke one:

| Problem   | When                                                             |
| --------- | ---------------------------------------------------------------- |
| `removed` | the username is no longer in `local_admins.json`                 |
| `changed` | the stored `password_hash` no longer matches the session's `fp`  |
| `expired` | `Date.now() - iat` exceeds `sessionMaxAgeHours` (the cookie's own `maxAge` is only enforced by the browser) |
| `stale`   | a session without `iat` / `fp` (minted before this check existed) |

On any of these the session is cleared and the request is redirected to
`/login?error=…`; the reason is logged as `[auth] session for "x"
rejected: …`. Removing an admin on the Admins page therefore ends that
admin's sessions immediately. The file read is synchronous and tiny —
the first-run setup gate already does the same once per request.

Every authenticated route uses this. Routes that mutate state (e.g.
`POST /admins/delete`) also enforce it.

### Login timing

`POST /login` runs a bcrypt compare even when the username is unknown
(against a throwaway hash made at boot, `DUMMY_HASH`), so a bad
username and a bad password take the same time and response timing
can't enumerate admin usernames.

## Brute-force protection

[`express-rate-limit`](https://github.com/express-rate-limit/express-rate-limit)
on `POST /login`, configured to count **only failed logins**:

```js
const authLimiter = rateLimit({
  windowMs: windowSeconds * 1000,
  max: maxAttempts,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  requestWasSuccessful: (req) => !req.loginFailed
});
```

[routes/public.js](../routes/public.js) marks `req.loginFailed = true`
on every failure branch (missing fields, unknown user, bad password,
internal error) via a small `fail()` helper. Successful logins never
set the flag.

Defaults: 10 failures in 5 minutes per IP. Configurable via Settings →
Security. The UI displays the window as **minutes** (1–1440) and
multiplies by 60 on save.

The limiter is registered **once at boot**, so changing
`maxAttempts` or `windowSeconds` requires a server restart. The
save flash message reminds operators of this.

### IP source

The IP key is whatever `express-rate-limit` derives from `req.ip`,
which respects `app.set('trust proxy', ...)`. Set
`server.trustProxy` in `config.json` to a truthy value (or a hop
count) when running behind a load balancer; otherwise `req.ip` is
the direct socket peer (which may be the proxy itself, defeating the
rate-limit).

## Input limits

[middleware/inputLimits.js](../middleware/inputLimits.js) caps the
length of every string field on `req.body` to protect against trivial
DOS via oversized form posts.

Defaults:

| Field                | Cap (chars) |
| -------------------- | ----------- |
| `email`              | 255         |
| `name`               | 100         |
| `password`           | 256         |
| `current_password`   | 256         |
| `new_password`       | 256         |
| `confirm_password`   | 256         |
| `sshPrivateKey`      | 20 000      |
| `html` (website fragment) | 200 000 |
| `cmd_start` / `cmd_stop` / `cmd_restart` | 4 000 |
| `key` (Data Browser row key) | 4 000 |
| `v__<n>` (Data Browser cell) | 20 000 |
| *(anything else)*    | 1 000       |

Exceeding any cap returns a 400 with an HTML / JSON explanation.
`express.urlencoded` and `express.json` are configured with a 64 KB
total body limit (large enough for a website fragment, a pasted SSH
key, or a Data Browser row with long TEXT columns).

## HTTP security headers

[helmet](https://helmetjs.github.io/) is enabled by default
(`security.headers.enabled`). CSP is also on by default
(`security.headers.contentSecurityPolicy`). The directives are
defined in [app.js](../app.js):

| Directive       | Sources                            | Why                                                                 |
| --------------- | ---------------------------------- | ------------------------------------------------------------------- |
| `default-src`   | `'self'`                           | Lock everything down by default.                                    |
| `style-src`     | `'self' 'unsafe-inline'`           | Inline `<style>` for theme + tiny inline `style="…"` overrides.     |
| `script-src`    | `'self' 'unsafe-eval'`             | Alpine.js compiles directives via `new Function(...)` → needs eval. |
| `img-src`       | `'self' data: blob:`               | `data:` for favicon/etc., `blob:` for Appearance live preview.      |
| `connect-src`   | `'self'`                           | No third-party API calls.                                           |
| `form-action`   | `'self'`                           | Forms can't post off-site.                                          |

`crossOriginEmbedderPolicy: false` — disabled because we don't ship
any cross-origin embeds and turning it on breaks the embedded
self-hosted Alpine bundle in some browsers.

## Cross-site request forgery (CSRF)

Four layers, each independent of the others:

1. **A per-session CSRF token** ([middleware/csrf.js](../middleware/csrf.js)).
   32 random bytes (hex) stored in the signed session cookie as
   `req.session.csrf`. It is minted lazily on the first request that has
   none — the login page needs one before anyone is signed in — kept
   across login (the cookie is signed and there is no server-side store
   to rotate against) and dropped with the session on logout, so the
   next visit gets a fresh one. Every `POST` / `PUT` / `PATCH` / `DELETE`
   must send it back, either as the `X-CSRF-Token` header or as the
   `_csrf` form field, and it is compared with `crypto.timingSafeEqual`.
   A missing or wrong token is refused with 403 — JSON
   `{ ok: false, error: 'Invalid or missing CSRF token — reload the page
   and try again.' }` for JSON / XHR callers, a short HTML page with a
   "Go back" link otherwise — and logged as `[csrf] refused …`. Nothing
   is exempt. `_csrf` is deleted from `req.body` after the check so
   handlers that copy the body wholesale (Data Browser, Web App
   Settings) never see it.
2. **The Origin / Sec-Fetch-Site check** in [app.js](../app.js), which
   runs first (before the body is parsed): a state-changing request whose
   `Origin` names a host other than the request's own (`'null'` counts as
   foreign), or whose `Sec-Fetch-Site` is neither `same-origin` nor
   `none`, is refused with 403 and logged as `[csrf] refused …`. A
   request with neither header passes on to the token check (curl,
   scripts). Behind a reverse proxy set `server.trustProxy` so
   `req.host` reads `X-Forwarded-Host`.

   One wrinkle: under a `Referrer-Policy` of `no-referrer` (helmet's
   default) browsers serialise the `Origin` of a same-origin **form**
   POST — a navigation, unlike `fetch` — as the literal `null`, which
   this check would refuse (the login form included; headless Chrome
   showed exactly that). So `app.js` sets helmet's `referrerPolicy` to
   `same-origin` (the Referer never leaves the console, and `Origin`
   stays intact), and the check additionally accepts `Origin: null`
   when the browser itself labels the request `Sec-Fetch-Site:
   same-origin` — a header a cross-site page cannot set.
3. The session cookie is `SameSite=strict`, so a browser doesn't send it
   on a request started from another site.
4. The CSP `form-action 'self'` stops the console's own pages posting
   elsewhere.

### How the token travels

Both ends are handled centrally, so a route or page never has to think
about it:

- [views/layout.js](../views/layout.js) `page()` puts
  `<meta name="csrf-token" content="…">` in every `<head>` (login layout
  and main layout) and injects
  `<input type="hidden" name="_csrf" value="…">` right after every
  `<form method="POST" …>` tag in the finished page (forms with no
  method — GET — are left alone). `page()` reads the token for the
  current request through an `AsyncLocalStorage` that the middleware
  sets up, which is why no `req` has to be threaded through to it.
- [public/js/csrf.js](../public/js/csrf.js) is the first script in both
  layouts (plain, not deferred). It wraps `window.fetch` so every
  same-origin request with a method other than GET / HEAD / OPTIONS
  carries `X-CSRF-Token` unless the caller set one, and exposes
  `window.csrfToken()`. All the console's JSON calls (Alpine `x-data`
  handlers, the Preview pop-up, templates, power / maintenance buttons,
  the backup status poll) and all image uploads (`macUploadImage`) go
  through the global `fetch`, so none of them needed changing.
- **Multipart forms.** The token check runs before multer, so a hidden
  `_csrf` field inside a `multipart/form-data` body is invisible to it;
  multipart requests must use the header. The image uploads already use
  `fetch`; the five native multipart forms (backup restore / bundle
  upload, Settings → Appearance, Web App Website image upload) are
  submitted by `csrf.js` through `fetch` instead of a plain navigation,
  then the redirect every one of those routes answers with is followed
  with `location.assign`. A non-redirect answer (a 403 or 413 page) is
  shown in place.

If a page's form starts answering 403 "Invalid or missing CSRF token",
the usual causes are: the page was rendered without `page()` (no meta /
hidden input), a new multipart form that submits natively, or a
`fetch` that bypasses the global `window.fetch` (an `XMLHttpRequest`,
`navigator.sendBeacon`, or a `fetch` captured before `csrf.js` ran).

## Error responses

A final 4-argument error handler in [app.js](../app.js) replaces
Express's default one, which prints `err.stack` (file paths, module
names) into the response unless `NODE_ENV=production`. It logs the full
error and answers with a generic page — JSON `{ ok: false, error }`
when the request asked for JSON (the console's fetch endpoints), HTML
otherwise. Body-parser 4xx errors (bad JSON, body too large) keep their
status and short message. `START_APP.sh` also exports
`NODE_ENV=production` unless already set.

## First-run setup gate

While `localAdmins.count() === 0`, [app.js](../app.js) redirects every
non-static, non-`/setup` GET to `/setup`. Non-GET methods during this
window return a 403 ("First-run setup required — open / in a browser
to begin.") rather than silently bouncing — that prevents a stray
form POST from succeeding against an unconfigured app.

Once the first admin is created, the gate short-circuits and normal
routing takes over. The `/setup` route itself also self-disables —
both GET and POST redirect to `/login` as soon as at least one admin
exists.

**Corrupt credential file fails closed.** A count of 0 can mean either a
genuine first run *or* a `local_admins.json` that exists but can't be
used. `localAdmins.fileError()` distinguishes them: if the file is
present but unparseable, not an array, or a non-empty array in which
no entry has a string `username` + `password_hash`, the gate returns a
503 telling the operator to restore it, and does **not** offer the
unauthenticated setup flow (an empty `[]` is a genuine first run) —
otherwise damaging the file would let anyone mint a fresh admin. The file
is also written atomically (temp + rename, created `0600`) so a crash
mid-write can't truncate it into that corrupt state in the first place.

## Data Browser and Nonprofits write safety

The console writes the web app's database directly, so these pages carry
their own guard rails (details at the top of
[routes/dataBrowser.js](../routes/dataBrowser.js) and
[helpers/dbSchema.js](../helpers/dbSchema.js)):

- **Identifiers only from the live schema.** Table and column names that
  end up in SQL come from `sqlite_master` / `PRAGMA table_info` (SQLite,
  local or remote) or `information_schema` (MySQL) — never from the URL,
  a form field or an uploaded backup. An unknown table is a 404; an
  unknown sort column or form column is a 400. Edit / insert forms name
  columns by their *position* in the live schema (`v__3`), so a tampered
  field name can't reach a column the UI didn't offer.
- **Values always bound** as `?` parameters (search terms, keys, cells,
  `LIMIT` / `OFFSET`). Remote SQLite has no bind API, so
  [db/remoteSqlite.js](../db/remoteSqlite.js) encodes each bound value as
  a quoted SQL literal (quote-aware placeholder substitution).
- **Hash columns are read-only.** Any column named `*password_hash*` or
  `*_hash` is shown masked and can't be written from the Data Browser.
  Nonprofit passwords are set from **Nonprofits → Reset password** (bcrypt cost
  10 — identical to the web app). A NOT NULL hash column on an inserted
  row gets the sentinel `no_login`, which is not a bcrypt hash and so can
  never authenticate.
- **Rows by primary key only; keys are not editable.** Tables without a
  primary key are read-only.
- **Every delete goes through `uiConfirm`.**

Nonprofits → Edit account pre-checks login name
(case-insensitive) and email uniqueness.

## Uploads, Markdown and outbound calls

- **Uploads** are accepted only as JPEG / PNG / WebP **by magic bytes**
  (the browser's type and filename are ignored), at most 8 MB, stored
  under a random 16-hex name the console chooses. Every path that reaches
  a shell command or the filesystem is re-validated against
  `^(events|raffles|orgs|board)/[0-9a-f]{16}\.(jpg|png|webp)$` and
  single-quoted, so a hand-edited DB row can't point `rm -f` elsewhere.
- **Markdown-lite** previews use a verbatim copy of the web app's
  renderer, which HTML-escapes the whole input first and only allows
  http / https / mailto links — the preview pane's `x-html` only ever
  receives that output.
- **ProPublica lookup** is a server-side GET to
  `projects.propublica.org` with only the 9 EIN digits in the URL and a
  10 s timeout; the response is reduced to a few display fields.

## File permissions in production

Sensitive files on disk:

| File                 | What's in it                                | Recommended mode |
| -------------------- | ------------------------------------------- | ---------------- |
| `local_admins.json`  | bcrypt hashes                               | `0600` (auto-set on every write) |
| `config.json`        | session keys (if `fixed`), Web App SSH private key / EC2 access keys, MySQL password | `0600` (auto-set on every save from Settings) |
| `backups/`           | web app rebuild bundles + `.meta.json` summaries | `0700` dir, `0600` files (auto-set when a bundle is created / uploaded) |
| `public/images/*`    | uploaded background images                  | default |

```bash
chmod 0600 config.json local_admins.json
```

Do this once after cloning: `config.json` is tracked in git (the infra
scripts depend on it) and a fresh checkout is `0644` until the console
first saves it. The Settings → Web App form never echoes the SSH
private key or the AWS secret back to the browser — a blank field keeps
the stored value, a "Remove the stored …" checkbox clears it.

Treat `config.json` as a secret. In EC2 mode prefer the instance profile
(Settings → Web App → "This app is deployed in AWS") over stored access
keys. The console's only AWS call is SSM Run Command — it never creates
or modifies AWS resources.

## What's NOT in scope

Things this console deliberately does *not* implement, because they
belong in `mmoa_web_app`:

- **Nonprofit self-service** (signup, login, verify email, forgot password,
  editing their own directory profile and photos).
- **Email sending** (verification, password reset).
- **SSO / OAuth.**
- **Multi-factor auth.** This is left as a future enhancement —
  hooks would go in [routes/public.js](../routes/public.js) `POST /login`
  and a new column in `local_admins.json`.

## Things to remember when changing security defaults

- Auto-generated session keys mean **all sessions invalidate on
  restart** unless you switch to `sessionKeyMode: "fixed"` and provide
  durable keys.
- Setting `security.session.secure: true` over HTTP will make
  cookies invisible to the browser. Leave it `null` (auto) unless you
  terminate TLS somewhere the console can't see — then set it
  explicitly.
- `skipSuccessfulRequests` resets the failure counter on *every*
  successful login from that IP, so an attacker who eventually
  guesses a password resets their own throttle. The intended use is
  to stop blind bot password-spray, not targeted attacks.
