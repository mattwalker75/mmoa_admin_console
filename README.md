# MMoA Admin Console

Internal operator console for the **Mission Men of Anna** web app
([`mmoa_web_app`](../mmoa_web_app)). It reads and writes the web app's
database (nonprofit accounts + directory profiles, events, raffles, the
board, directory categories / cities, tokens, lockouts), uploads images
to the web app host, edits the web app's `config.json` and website copy,
tails its log, starts / stops /
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
- **Events & Raffles** — the website is the source of truth for both
  (Facebook only links to it). Create / edit, Draft → Published →
  Archived, a **Preview** pop-up of the real page, Markdown-lite
  descriptions with a live preview (same renderer as the website), flyer /
  cover / prize-photo uploads, event beneficiaries, raffle claim presets
  (Firearm / Standard) and the draft → open → closed → drawn workflow.
- **Nonprofits** — the only web-app logins are other nonprofits, each with
  a "Need Help?" directory profile. Review the whole profile (hidden fields,
  phone extensions, photo captions and the private search keywords too),
  check the EIN with the built-in **IRS / ProPublica lookup**, then
  Verify / Mark rejected / Reset; plus account actions (activate,
  email-verified, reset password, edit, delete with every child row and
  photo file).
- **Categories & Cities** and **Board** — the directory's lookup lists and
  the About page's board roles / names / photos. The built-in **Other**
  category can be renamed or deactivated but not deleted or re-slugged.
- **Image uploads to the web app host** in every access mode — the
  browser shrinks photos to 1600 px first; EC2 mode sends them as ≤ 40 KB
  SSM pieces (`webAppAccess.writeFileChunked`).
- **Data Browser** — every table in the live DB; paginate, search, edit,
  insert, delete by primary key. Identifiers come only from the live
  schema, values are always bound, password hashes are masked + read-only.
- **Web App Website / Logs / Settings** — edit the website copy (hero,
  about, help, partner, footer), images and Maintenance Mode; tail `logs/app.log`; edit the web
  app's `config.json` with read-modify-write (unexposed keys and secrets
  preserved) and a power bar with a restart-pending prompt — including the
  website's optional **Donate** button (switch + donation link; it won't
  switch on without a valid link).
- **Reports** (CSV / in-app view) and **Backup / Restore** (console
  settings, web-app config, website, an engine-neutral database dump, and
  one-file rebuild bundles that also carry `uploads/**`).
- **Live appearance theming** and **brute-force protection** carried over
  unchanged from the reference console.

## Stack

- **Node.js 20+ + Express 5**, server-rendered HTML (template strings).
- **SQLite** or **MySQL** — whichever the web app uses.
- **Tailwind CSS v4** built via `@tailwindcss/cli` into
  [public/css/tailwind.css](public/css/tailwind.css).
- **Alpine.js**, self-hosted at `/js/alpine.min.js` (CSP-friendly).
- **flatpickr** date / time picker, self-hosted at `/js/flatpickr.min.js`
  (wired up by `public/js/date-picker.js` for any `input[data-datetime]`).
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

**Where are the console passwords?** In `local_admins.json`, also reachable
through the `admin_passwords.json` symlink. They are bcrypt **hashes**, not
encrypted or plain passwords, so they can't be read back. A forgotten
password is replaced by re-running the command above with the same username.

## Sidebar tour

| Tab                  | Purpose |
| -------------------- | ------- |
| **Profile**          | Edit your own name / email / password. |
| **Dashboard**        | Nonprofits verified / pending / rejected, upcoming events, event drafts, open raffles, locked logins, console admins + the "Pending verification" list. |
| **Admins**           | Add / replace / remove local-file console admins. |
| **Events**           | List filtered by a Show drop-down (All / Draft / Published / Archived); create, edit, Draft / Published / Archived switch, Preview pop-up, flyer + cover, beneficiaries, delete, View on site. |
| **Raffles**          | Same pattern (Draft / Published / Archived, Preview) + a separate stage (open → closed → drawn, with winning ticket), claim presets, prize photos (≤ 8, reorder). |
| **Nonprofits**       | Accounts + directory profiles; ProPublica lookup; Verify / Reject / Reset; New nonprofit (temporary password shown once); Edit profile (the portal's rules); Hide from / Show in directory (MMoA override); Preview pop-up; account actions. (`/members` redirects here.) |
| **Categories & Cities** | The directory's service categories and cities — add, rename, reorder, activate / deactivate, delete when unused (never the built-in **Other**). |
| **Board**            | Board roles, person names, photos, order. |
| **Data Browser**     | Generic table browser / editor for the whole web-app database. |
| **Locked Users**     | Current login lockouts (accounts and IPs) with Unlock. |
| **Reports**          | Nonprofits (all / pending), events, raffles, lockouts, console admins — view or CSV. |
| **Web App Website**  | Website copy sections (hero, about, help, partner, footer), images, Maintenance Mode. |
| **Web App Logs**     | Tail of the web app's `logs/app.log`. |
| **Backup/Restore**   | JSON exports / restores and one-file rebuild bundles (incl. `uploads/**`). |
| **Web App Settings** | The web app's `config.json` (General incl. public site info and the Donate button, Email, Security, Database, Server) + Start / Stop / Restart. |
| **Settings**         | This console: Security, Appearance, Web App (access mode, database, lifecycle commands, Test connection), Templates (raffle text templates and where they're saved). |

## Admins vs. nonprofits

- **Console admins** — MMoA board members operating *this* app. Live in
  `local_admins.json`, never in the DB. Managed under **Admins**.
- **Nonprofits** — rows in the web app's `users` table, each with one
  `organizations` profile. Logins exist only so other nonprofits can keep
  their "Need Help?" listing current. They can't sign in here; the web app
  has no admin surface of its own — this console is it. Managed under
  **Nonprofits**.

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
helpers/webAppUploads.js        uploads/<kind>/<16-hex>.<ext> contract: magic bytes, save, delete
helpers/markdownLite.js         VERBATIM copy of mmoa_web_app/helpers/markdownLite.js (keep identical)
helpers/localTime.js            Event / raffle times: org time zone (timeZone) ↔ stored UTC
helpers/pageKit.js              Shared bits for the content pages (safeGet, slugs, reorder, upload widget)
helpers/awsSsm.js               SSM Run Command (ec2 mode); awsLog.js / awsClientKey.js support it
views/layout.js                 HTML shell, sidebar, themeCss, restart prompt, confirm dialog
views/escapeHtml.js             escapeHtml + jsAttrStr
routes/setup.js                 First-run "create the first admin" gate
routes/public.js                /login, /logout (LOCAL FILE auth only)
routes/profile.js               /profile + /profile/password
routes/admin.js                 Dashboard + console admin CRUD
routes/events.js                Events
routes/raffles.js               Raffles
routes/nonprofits.js            Nonprofits (+ ProPublica lookup, /members redirect)
routes/directory.js             Categories & Cities
routes/board.js                 Board
routes/uploads.js               /wa-uploads image proxy + /markdown-preview
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
public/js/image-upload.js       Browser-side resize (≤ 1600 px JPEG) + upload
tailwind.input.css              Tailwind v4 source
START_APP.sh                    Convenience boot script
local_admins.json               GITIGNORED — bcrypt hashes for console admins
admin_passwords.json            Symlink → local_admins.json (easy-to-find name; holds no data itself)
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
  as-is from the reference console (plus atomic SSH writes). The v2 upload
  path was exercised against a local ssh2 test server and a mocked SSM
  executor; local mode and all three database engines end to end.
- **EC2 (SSM) reads are capped at ~18 KB of file.** Thumbnails in ec2 mode
  are fetched from the web app's public `/uploads` URL instead, and a
  rebuild bundle made over SSM skips (and lists) any upload larger than
  that. Use SSH or local access for a complete bundle.
- **Remote SQLite doesn't enforce foreign keys** (one `sqlite3` process
  per statement). Nonprofits / Events / Raffles → Delete remove child rows
  explicitly; a raw Data Browser delete of a parent row on a remote SQLite
  database leaves its children behind.
- **Secrets in `config.json`.** The SSH private key, EC2 access keys and
  the MySQL password live there. Keep it out of version control once
  filled in, and `chmod 0600`.
