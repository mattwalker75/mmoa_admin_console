# MMoA Admin Console

Internal operator console for the **Mission Men of Anna** web app
([`mmoa_web_app`](../mmoa_web_app)). It reads and writes the web app's
database (members, events, tokens, lockouts), edits the web app's
`config.json` and website content, tails its log, starts / stops /
restarts it, and backs everything up — whether the web app runs on this
same machine, on a server reachable over SSH, or on an EC2 instance
reachable only through AWS Systems Manager.

This is a small internal tool for **1–3 operators**, not a public surface.
It is a port of `car_show_admin_console` with the car-show-only domain
(deployments, AWS provisioning, payments, reviews, subdomains) removed.

## Highlights

- **Boots without a database.** The DB connection is lazy and optional.
  A missing or unreachable DB never crashes the app — pages render with a
  "Database unavailable" banner and the operator can still sign in and
  fix the connection under Settings → Web App.
- **Local-file admin auth (break-glass).** The console's own operators
  live in `local_admins.json` on disk (gitignored, bcrypt hashes,
  `chmod 0600`). A first-run `/setup` page creates the first one; a
  corrupt file fails closed.
- **Three ways to reach the web app** — `local`, `ssh` (pasted private
  key), `ec2` (SSM Run Command). Every file write is atomic; SSM reads
  refuse anything near the ~24 KB output cap rather than truncate it.
- **Members** — search, create, edit, verify / unverify, reset password
  (bcrypt cost 10, same as the web app), delete.
- **Data Browser** — every table in the live DB; paginate, search, edit,
  insert, delete by primary key. Identifiers come only from the live
  schema, values are always bound, password hashes are masked + read-only.
- **Web App Website / Logs / Settings** — edit the HTML sections, window
  styling, images and Maintenance Mode; tail `logs/app.log`; edit the web
  app's `config.json` with read-modify-write (unexposed keys and secrets
  preserved) and a power bar with a restart-pending prompt.
- **Reports** (CSV / in-app view) and **Backup / Restore** (console
  settings, web-app config, website, an engine-neutral database dump, and
  one-file rebuild bundles).
- **Live appearance theming** and **brute-force protection** carried over
  unchanged from the reference console.

## Stack

- **Node.js 20+ + Express 5**, server-rendered HTML (template strings).
- **SQLite** or **MySQL** — whichever the web app uses.
- **Tailwind CSS v4** built via `@tailwindcss/cli` into
  [public/css/tailwind.css](public/css/tailwind.css).
- **Alpine.js**, self-hosted at `/js/alpine.min.js` (CSP-friendly).
- **bcrypt**, **cookie-session**, **helmet**, **express-rate-limit**,
  **morgan**, **multer**, **mysql2**, **sqlite3**, **ssh2**,
  **@aws-sdk/client-ssm** (lazy-required; the only AWS SDK).

## Quick start

```bash
npm install
./START_APP.sh                  # or: npm start
```

`npm start` runs the `prestart` hook to rebuild Tailwind CSS and refresh
the Alpine bundle, then boots the server on **http://localhost:3005**.

The committed [config.json](config.json) assumes the web app is checked
out next to this repo (`../mmoa_web_app`, database
`../mmoa_web_app/mmoa_web_app.db`). Boot the web app once (or run its
`SETUP_SQLLITE_DB.sh`) so the database exists, then restart the console.

On the first boot the console detects an empty `local_admins.json` and
redirects every request to **`/setup`**. Fill in the form and sign in.
CLI alternative:

```bash
node scripts/create-local-admin.js <username> <email> '<name>' '<password>'
```

## Sidebar tour

| Tab                  | Purpose |
| -------------------- | ------- |
| **Profile**          | Edit your own name / email / password. |
| **Dashboard**        | Counts: members, web-app admins, verified / unverified / inactive, events, locked IPs / accounts, console admins. |
| **Admins**           | Add / replace / remove local-file console admins. |
| **Members**          | The web app's accounts — list, search, create, edit, verify, reset password, delete. |
| **Data Browser**     | Generic table browser / editor for the whole web-app database. |
| **Locked Users**     | Current login lockouts (accounts and IPs) with Unlock. |
| **Reports**          | Members, unverified members, events, lockouts, console admins — view or CSV. |
| **Web App Website**  | HTML sections, window styling, images, Maintenance Mode. |
| **Web App Logs**     | Tail of the web app's `logs/app.log`. |
| **Web App Settings** | The web app's `config.json` (General, Email, Security, Database, Server) + Start / Stop / Restart. |
| **Backup/Restore**   | JSON exports / restores and one-file rebuild bundles. |
| **Settings**         | This console: Security, Appearance, Web App (access mode, database, lifecycle commands, Test connection). |

## Two flavors of "admin"

- **Console admins** — operators of *this* app. Live in
  `local_admins.json`, never in the DB. Managed under **Admins**.
- **Web-app admins** — rows in the web app's `users` table with
  `role='admin'`. They can't sign in here; the web app has no admin
  surface of its own — this console is it. Managed under **Members**.

## Cookie name

Sessions use cookie name **`mac_session`** (vs the web app's `mw_session`)
so one browser can be signed into both without one clobbering the other.

## Where things live

```
app.js                          Express entry: middleware chain, route wiring, SSL/HTTPS
config.json                     Runtime configuration (port 3005, web app access, DB, theme, security)
config/appConfig.js             Config loader/saver with defaults; atomic save
db/database.js                  Dual-engine SQLite/MySQL with "dead-DB" fallback
db/remoteSqlite.js              SQLite on the web-app host via the sqlite3 CLI (ssh / ec2 modes)
middleware/auth.js              requireAdmin, hash/verify password, password complexity helpers
middleware/inputLimits.js       Per-field char caps on form bodies
helpers/localAdmins.js          Read/write/lookup over local_admins.json
helpers/webAppAccess.js         local / ssh / ec2 transport (run, read, write, readBundle, test)
helpers/webAppConfig.js         Read-modify-write of the web app's config.json; restart-pending flag
helpers/dbSchema.js             Live-schema introspection for the Data Browser and Backup
helpers/awsSsm.js               SSM Run Command (ec2 mode); awsLog.js / awsClientKey.js support it
views/layout.js                 HTML shell, sidebar, themeCss, restart prompt, confirm dialog
views/escapeHtml.js             escapeHtml + jsAttrStr
routes/setup.js                 First-run "create the first admin" gate
routes/public.js                /login, /logout (LOCAL FILE auth only)
routes/profile.js               /profile + /profile/password
routes/admin.js                 Dashboard + console admin CRUD
routes/members.js               Members pages
routes/dataBrowser.js           Data Browser
routes/lockedUsers.js           Locked Users
routes/reports.js               Reports registry + CSV / JSON
routes/backup.js                Backup / Restore + rebuild bundles
routes/webAppWebsite.js         Web App Website editor + Maintenance Mode
routes/webAppLogs.js            Web App Logs
routes/webAppSettings.js        Web App Settings (remote config.json) + power bar
routes/settings.js              Settings (Security, Appearance, Web App)
scripts/create-local-admin.js   Command-line admin seeding
public/js/ui-confirm.js         CSP-safe confirm dialog (window.uiConfirm)
public/js/wa-preview.js         Website section preview popup
tailwind.input.css              Tailwind v4 source
START_APP.sh                    Convenience boot script
local_admins.json               GITIGNORED — bcrypt hashes for console admins
backups/                        GITIGNORED — rebuild bundles
```

## Configuration

All operator-facing settings live in [config.json](config.json) and can
be edited live from **Settings**. See
[Docs/configuration.md](Docs/configuration.md) for the full reference.
The committed `config.json` carries the defaults with every secret blank.

Sensitive files to keep tightly permissioned in production:

```bash
chmod 0600 config.json local_admins.json
chmod 0700 backups
```

## Detailed documentation

- [Docs/README.md](Docs/README.md) — index
- [Docs/architecture.md](Docs/architecture.md) — request lifecycle, transport, layout
- [Docs/configuration.md](Docs/configuration.md) — every field in `config.json`
- [Docs/database.md](Docs/database.md) — DB module, offline mode, expected schema, Data Browser
- [Docs/security.md](Docs/security.md) — auth, sessions, throttling, CSP, write safety
- [Docs/appearance.md](Docs/appearance.md) — theme system
- [Docs/operator-guide.md](Docs/operator-guide.md) — tab-by-tab user guide
- [Docs/development.md](Docs/development.md) — how to add a page, styles, debugging

## Known gaps

- **SSH and EC2 modes need a real host to verify.** They are ported
  as-is from the reference console (plus atomic SSH writes); local mode
  and all three database engines were exercised end to end.
- **Remote SQLite doesn't enforce foreign keys** (one `sqlite3` process
  per statement). Members → Delete removes child token rows explicitly;
  a raw Data Browser delete of a `users` row on a remote SQLite database
  leaves its tokens behind.
- **Secrets in `config.json`.** The SSH private key, EC2 access keys and
  the MySQL password live there. Keep it out of version control once
  filled in, and `chmod 0600`.
