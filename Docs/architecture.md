# Architecture

How the admin console is wired together — data sources, the Web App
transport, request lifecycle, and the asset pipeline.

## Big picture

```
                 ┌────────────────────────────────────┐
                 │           Browser (operator)       │
                 │   server-rendered HTML +           │
                 │   Tailwind CSS + Alpine.js         │
                 └──────────────────┬─────────────────┘
                                    │  HTTP(S) :3005
                 ┌──────────────────▼─────────────────┐
                 │   mmoa_admin_console (Express 5)   │
                 │  app.js → middleware → routes/*.js │
                 └───┬──────────────┬──────────────┬──┘
                     │              │              │
     ┌───────────────▼───┐  ┌───────▼────────┐  ┌──▼──────────────────────────┐
     │ local_admins.json │  │ Web app DB     │  │ Web App host (transport)    │
     │ console operators │  │ SQLite / MySQL │  │ helpers/webAppAccess.js     │
     │ bcrypt, 0600      │  │ db/database.js │  │ local | ssh | ec2 (SSM)     │
     └───────────────────┘  └────────────────┘  │ config.json, HTML/, logs/,  │
                                                │ scripts, START/STOP/RESTART │
                                                └─────────────────────────────┘
```

Three independent data sources:

1. **`local_admins.json`** — this console's own operators. Never in the
   database, so a dead DB can't lock anyone out.
2. **The web app's database** — `mmoa_web_app.db` (SQLite) or the MySQL
   database. Events, Raffles, Nonprofits, Categories & Cities, Board,
   Data Browser, Locked Users, Reports, the dashboard and database backups
   read/write it through `db/database.js`.
3. **The web app's install directory** — `config.json`, `HTML/`,
   `uploads/`, `logs/app.log`, `scripts/maintenance.sh` and the lifecycle
   scripts, reached through `helpers/webAppAccess.js`.

## The Web App transport

`helpers/webAppAccess.js` hides *where* the web app runs behind one
accessor interface:

| Method | local | ssh | ec2 |
| ------ | ----- | --- | --- |
| `runCommand(cmd, { cwd, timeoutMs })` | `/bin/sh -c` | `conn.exec` | SSM `AWS-RunShellScript` (optionally `su - runAsUser`) |
| `readFile(path)` | `fs` | SFTP | `base64` over SSM — **refuses** output ≥ ~23 KB (SSM truncates at 24 KB) |
| `writeFile(path, content)` | temp + `rename` | SFTP temp + `mv -f` | base64 → temp + `mv -f` (one command — small text files only) |
| `writeFileChunked(path, buffer)` | `mkdir -p` + temp + `rename` | `mkdir -p`, SFTP temp + `mv -f` | `mkdir -p`; base64 pieces appended to a temp file, **each SSM command ≤ 40 KB** after the `su` wrap (`ssmChunkChars`: 39 400 chars, 29 348 with `runAsUser`); final size check (`stat -c %s`, else `wc -c`) then `mv -f`; any failure removes the temp file |
| `exists(path)` | `fs.access` | SFTP `stat` | `test -e` |
| `readBundle({files, dirs})` | parallel reads | one SSH connection | one SSM command with markers (falls back per-file if truncated) |
| `test()` | dir exists / writable | connect + `whoami` + dir | SSM `whoami` + dir probe |

Every write is atomic, so an interrupted save can never leave the web
app's `config.json`, a website fragment or an uploaded image truncated.

### Uploaded images (`uploads/`)

[helpers/webAppUploads.js](../helpers/webAppUploads.js) owns the contract
shared with the web app: files live at
`<appPath>/uploads/<events|raffles|orgs|board>/<16 random hex>.<jpg|png|webp>`,
the DB stores the relative path (`events/3f9c….jpg`), only JPEG / PNG /
WebP pass (checked by magic bytes, 8 MB max), and paths are re-validated
against that exact shape before any read, write or `rm -f`. The browser
resizes first ([public/js/image-upload.js](../public/js/image-upload.js):
canvas, ≤ 1600 px long edge, JPEG 0.82). Thumbnails go through the
console's `/wa-uploads/<kind>/<file>` proxy (CSP allows only same-origin
images): local / SSH read the file; EC2 fetches the web app's public
`<publicBaseUrl>/uploads/…` URL (SSM can only return ~18 KB of file),
falling back to an SSM read for small files. Lifecycle and
maintenance commands run **from** the web app directory (`cwd = appPath`).

`helpers/webAppConfig.js` builds on it: `readRemoteConfig` refuses a
malformed file, callers mutate only the keys their form owns, and
`writeRemoteConfig` writes the whole object back — so `_comment` notes,
secrets and `sessionKeys` survive every save. When a save actually
changes the file, `markWebAppWritten` sets `webApp.restartPending` (the
web app reads its config once at boot); a successful Start / Restart from
the power bar clears it.

### How the database follows the access mode

| `database.engine` | `webApp.mode` | Backend |
| ----------------- | ------------- | ------- |
| `sqlite` | `local` | `sqlite3` driver opens the file directly (never creates it) |
| `sqlite` | `ssh` / `ec2` | `db/remoteSqlite.js` — each statement runs `sqlite3 -json` on the web-app host through the transport |
| `mysql` | any | `mysql2` pool, direct from this console (the endpoint must be reachable from here) |
| `""` / `none` | any | dead-DB stub: every query rejects, pages show a banner |

## Request lifecycle

See [`app.js`](../app.js). In order:

1. **trust proxy** (only if `server.trustProxy` is set).
2. **helmet** — security headers + CSP (`script-src 'self' 'unsafe-eval'`
   for Alpine; `img-src` allows `blob:` for the Appearance preview).
3. **compression**.
4. **morgan** — `[ts] ip - user - method url HTTP/v status - - ms`. The
   `:user` token reads `req._loggedUser`, **not** `req.session` (reading
   the session after the response is sent makes cookie-session set a
   header → `ERR_HTTP_HEADERS_SENT`).
5. **cookie-session** — signed cookie `mac_session`.
6. **`_loggedUser` snapshot** for morgan.
7. **body parsers** — urlencoded + JSON, 64 KB limit.
8. **enforceInputLimits** — per-field caps.
9. **express-rate-limit** on `/login`, counting only failed attempts.
10. **express.static** for `public/` (`maxAge: 1h`, cache-busted by mtime).
11. **`Cache-Control: no-store`** on everything dynamic.
12. **First-run setup gate** — while no local admin exists, everything
    redirects to `/setup` (non-GET → 403); a corrupt `local_admins.json`
    → 503, never the setup form.
13. **Routers**: `setup → public → settings → webAppSettings → webAppLogs →
    webAppWebsite → lockedUsers → dataBrowser → reports → backup →
    profile → uploads → events → raffles → nonprofits → directory →
    board → admin`.
14. **404 fallback**.

Unhandled rejections are logged and the process stays up; an uncaught
exception drains the server and exits non-zero.

## Pages and what they touch

| Page | DB | Transport | Own config |
| ---- | -- | --------- | ---------- |
| Dashboard, Nonprofits, Categories & Cities, Data Browser, Locked Users, Reports | ✓ | | |
| Events, Raffles, Board | ✓ | ✓ (uploads; remote `publicBaseUrl` for View on site) | `timeZone` |
| Nonprofits → IRS / ProPublica lookup | ✓ | | (outbound HTTPS to projects.propublica.org, 10 s timeout) |
| Web App Website / Logs / Settings | | ✓ | `webApp.restartPending` |
| Backup/Restore | ✓ (database) | ✓ (config, website, bundles) | ✓ (console settings) |
| Settings, Profile, Admins | | (Test connection) | ✓ / `local_admins.json` |

## Asset pipeline

- `tailwind.input.css` → `public/css/tailwind.css` (`npm run build:css`,
  run by `prestart`). `@source` scans `routes/`, `views/`, `scripts/`,
  `public/js/` and `app.js`, so classes used in template strings are
  picked up.
- `node_modules/alpinejs/dist/cdn.min.js` → `public/js/alpine.min.js`
  (`npm run copy:alpine`).
- `views/layout.js` appends `?v=<mtime>` to both, so a rebuild is picked
  up without a hard refresh.
- Behaviour that needs real JavaScript (the confirm dialog, the website
  preview popup, the image resize-and-upload helper) lives in external
  files under `public/js/` — the CSP
  has no `'unsafe-inline'` for scripts.

Dark mode is class-based (`dark` on `<html>` from `theme.mode`), see
[appearance.md](appearance.md).
