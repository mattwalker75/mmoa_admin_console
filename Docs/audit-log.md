# Audit log

The admin console keeps a trail of who did what: every sign-in and every
change made through the console lands as one row in the `admin_audit`
table, and the **Audit log** page (`/audit`, in the sidebar) shows it newest
first.

## Where it lives

- The rows are in the **web app's database** (`mmoa_web_app`'s SQLite file
  or MySQL schema), in the table `admin_audit`. The **web app creates and
  owns the table** — it adds it when it boots (`db/database.js` boot
  migrations, `setup_sqlite_db.sql` / `setup_mysql_db.sql`). The console only
  inserts and reads.
- Because it is part of the web app's database, it is included in every
  **Backup/Restore** bundle the console makes, and restoring a bundle brings
  the trail back with everything else.
- Until the web app has been restarted after the update that introduced
  the table, the console cannot record anything: the Audit log page shows
  the usual *"Start (or restart) the Web App to finish an update"* banner,
  and the Dashboard's *Recent activity* card says the same. Use Web App
  Settings → Restart, then reload. Nothing else is affected — an action
  whose audit insert fails still completes; the failure is only logged to the
  console's own log (`[audit] could not record …`).

## What a row holds

| Column | Meaning |
| --- | --- |
| `at` | When (UTC, `YYYY-MM-DD HH:MM:SS`). The page shows it in the console's time zone (`timeZone` in `config.json`, default America/Chicago). |
| `admin` | The console admin who did it (the session username). `system` when there is no session — a failed sign-in. |
| `action` | Lower-case, dotted: `<area>.<verb>` (list below). |
| `target_kind` / `target_id` | What it acted on — `event` / `raffle` / `nonprofit` / `admin` / `table` / `settings` … and its id (a number, a username, a table name, a tab key). |
| `target_label` | A human name for the target: event or raffle title, organization name, admin username, template name, table name. |
| `summary` | One short sentence about what happened. |
| `ip` | The request's client IP (honours `server.trustProxy`). |

Summaries are written to be safe to read over anyone's shoulder:

- **Never a password, key or secret.** Settings saves list the *names* of
  the keys that changed, never their values; the SSH private key, the AWS
  secret access key and the MySQL password are reported only as
  *replaced* or *cleared*. Nonprofit password resets say that a password was
  set, nothing more.
- **Never the winning ticket number** — a raffle drawn says *winner
  recorded*.
- **Never a verification note's text** — only its length.
- **Never a temporary password** — creating a nonprofit records only
  whether the email / organization were marked verified.
- **Never Data Browser cell values** — only the table, the row key and the
  column names.

## Actions

| Action | Recorded when | Target / summary |
| --- | --- | --- |
| `login.success` | An admin signs in | admin · *Signed in* |
| `login.failure` | A sign-in is refused (wrong password or unknown name) | admin is `system`; summary *Failed sign-in for "name"* |
| `logout` | An admin signs out | admin · *Signed out* |
| `admin.add` / `admin.replace` / `admin.remove` | Admins page: a console admin added, re-added (record replaced) or removed | the username |
| `profile.save` / `profile.password` | Profile page: own name / email saved, own password changed | own username; which of name / email changed |
| `event.create` / `event.save` / `event.delete` | Events: created, saved, deleted | title; a save says whether the status changed (*Status draft → published*) or stayed, whether it was renamed or marked Latest |
| `event.image` | Flyer or cover photo uploaded, replaced or removed | title; which slot |
| `event.preview` | A preview link was made | title |
| `raffle.create` / `raffle.save` / `raffle.delete` | Raffles: created, saved, deleted | title; a save says whether the visibility changed |
| `raffle.stage` | Stage moved (open → closed → drawn → claimed, or back) | title · *Stage closed → drawn (winner recorded)* |
| `raffle.image` | Flyer uploaded / replaced / removed; prize photo added / moved / deleted | title |
| `raffle.preview` | A preview link was made | title |
| `nonprofit.verify` / `nonprofit.reject` / `nonprofit.reset` | Verification decision | organization name; note length |
| `nonprofit.activate` / `nonprofit.deactivate` | Login switched on / off | organization name |
| `nonprofit.email_verified` | Email marked verified / unverified | organization name |
| `nonprofit.password_reset` | An admin set the account's password | organization name |
| `nonprofit.edit` | Account fields saved | organization name; which fields changed |
| `nonprofit.create` | A login + organization created from the console (New nonprofit) | organization name; *email verified: yes/no, organization verified: yes/no* — never the temporary password |
| `nonprofit.profile_edit` | Edit profile saved | organization name; the names of the profile fields that changed (`contacts`, `categories`, `cities` count as fields) — never the values |
| `nonprofit.hide` / `nonprofit.unhide` | Hidden from / shown in the Need Help directory by MMoA (the override) | organization name |
| `nonprofit.lock` / `nonprofit.unlock` | Login locked by an admin (no expiry) / unlocked (also clears an automatic lock) | organization name |
| `nonprofit.preview` | A preview link was made | organization name |
| `nonprofit.photo_remove` | A profile photo removed | organization name |
| `nonprofit.delete` | The account (and its organization profile) deleted | organization name |
| `category.add` / `.rename` / `.move` / `.active` / `.delete` | Categories & Cities — categories | the name |
| `city.add` / `.rename` / `.move` / `.active` / `.delete` | Categories & Cities — cities | the name |
| `board.add` / `board.save` / `board.move` / `board.photo` / `board.delete` | Board page | *Role — Person* |
| `settings.save` | Settings → Security / Appearance / Web App saved | the tab; the names of the keys that changed |
| `templates.dir` | Settings → Templates: the templates folder changed | the new folder |
| `template.create` / `template.update` / `template.delete` | A template saved (from Settings or from a form's Templates drop-down) or deleted | template name |
| `webapp_settings.save` | Web App Settings → a tab saved | the tab; the names of the keys that changed in the web app's `config.json` |
| `webapp.power` | Start / Stop / Restart Web App | the action and the command's exit code |
| `website.section` | Web App Website: a section (hero, about, impact, help, partner, footer) saved | the section |
| `website.image` | Web App Website: an image uploaded or deleted | the file name |
| `maintenance.enable` / `maintenance.disable` / `maintenance.status` | Maintenance mode command run | exit code |
| `lockout.unlock` | Locked Users: a lockout cleared | the scope (IP or login) |
| `data.insert` / `data.update` / `data.delete` | Data Browser: a row inserted, updated or deleted | the table; the row key and column names |
| `backup.*` | Backup/Restore actions | see `routes/backup.js` |

Reads — opening pages, downloading a backup, the Reports page, viewing an
upload — are not recorded.

## Reading the page

- **Filters**: an admin, an action (one exact action, or a whole area such
  as *event — all*), a free-text search over the target label and the
  summary (case-insensitive, matches anywhere), and a date range. The dates
  are whole days in the console's time zone.
- Clicking an admin or an action in the table filters by it.
- 50 rows a page; *Newer* / *Older* keep the filters.
- Hover a time to see the stored UTC value.
- The Dashboard shows the five most recent rows under *Recent activity*.

## For developers

```js
const audit = require('../helpers/audit')(db);
await audit(req, 'event.publish', { kind: 'event', id, label: title, summary: 'Published' });
```

- Call it **after** the write succeeded, inside the `try`. It never throws
  and never blocks the action: a failed insert is logged and swallowed.
- `admin` comes from `req.session.user.username` (`system` without a
  session); `ip` from `req.ip`. Every field is clipped to the column size.
- Routers that app.js does not hand a `db` (`profile`, `templates`,
  `webAppSettings`, `webAppWebsite`) use the shared recorder
  `require('./audit').record`, which `routes/audit.js` binds to the db when
  app.js mounts it — audit calls only happen at request time, after every
  router is mounted, so mount order does not matter.
- New actions: keep the `<area>.<verb>` shape, give the target a label a
  board member would recognize, and keep secrets and long text out of the
  summary. Add the action to the table above.
