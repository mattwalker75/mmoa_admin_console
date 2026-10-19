# Operator guide

Tab-by-tab guide for the people running Mission Men of Anna's website
from this console.

## First run

1. `./START_APP.sh` and open http://localhost:3005.
2. With no admins configured you land on **Create the first admin**.
   This account lives in `local_admins.json` on this machine — not in the
   web app's database — so it keeps working if the database is down.
3. Sign in, then open **Settings → Web App** and check that the console
   can reach the web app (**Test connection**) and its database (the
   pill next to "Database" says Connected).

## Profile

Your own name, email and password. Username can't be changed here.

## Dashboard

At-a-glance counts. Tiles link to the page that explains them:
members, verified / unverified / inactive accounts,
events (all / published), and accounts / IPs currently locked out of the
web app's login. A red banner means the database couldn't be reached.

## Admins

Who can sign in to **this console**. Re-using a username replaces that
admin's email / name / password. You can't remove yourself or the last
admin.

## Members

Every account in the web app.

- **Search / filter** by name, email, login or phone; or show
  only unverified / inactive accounts. Click a row for details.
- **Create member** — every account is a member (there are no roles). Leave
  "Email verified" ticked if you know the address is right (unverified
  members can't sign in). Untick "Set a password" for a no-login account;
  the member can use **Forgot password** on the website later.
- **Modify member** — name, login, email, phone, active, verified.
- **Mark verified / unverified** — quick toggle. Marking verified also
  invalidates any outstanding verification link.
- **Reset password** — sets a new password immediately (same bcrypt
  hashing as the website) and invalidates outstanding reset links. Use
  this when someone is locked out of their email.
- **Delete member** — removes the account and its outstanding links.
  Asks for confirmation; can't be undone (restore from a database backup
  if needed).

The detail page also shows outstanding verification / reset links and
whether the account is currently locked out.

## Data Browser

Direct access to every table — mainly for **events**, which have no
dedicated page:

- **Events:** Data Browser → `events` → **Insert row** to add one
  (`title`, `starts_at` as `YYYY-MM-DD HH:MM:SS` in UTC, optional
  `description`, `location`, `ends_at`; `is_published` 1 = shown on the
  website). Open a row to edit or delete it. Changes show on the website
  on the next page load.
- Search matches text columns, or an id when you type a number. Click a
  column heading to sort.
- Password hashes are masked and read-only — use Members → Reset password.
- Edits bypass the website's own validation, so be careful with
  `users` (prefer Members) and token tables.

## Locked Users

Accounts and IP addresses the website has temporarily blocked after too
many failed logins (default: 10 failures → 5 minutes; change it under
Web App Settings → Security). **Unlock** clears the block immediately.
"Only show currently locked" hides lapsed rows.

## Reports

All members, unverified members, events, login lockouts and console
admins. **View** opens the rows in-app; **Download CSV** saves them
(cells that look like spreadsheet formulas are neutralised).

## Web App Website

Edit the public site's five sections — **Hero**, **Mission**, **Events
heading** (the event cards come from the database), **Get involved**,
**Footer**:

- Each card has **Window styling** (background, border, size, corner tag,
  advanced CSS) and **Content** (the section's HTML). Save them
  separately; changes are live on the next page load — no restart.
  **Preview** shows the unsaved content in its window.
- Keep the `{{tokens}}` (`{{appTitle}}`, `{{orgName}}`, `{{year}}`,
  `{{eventCount}}`) — the website fills them in.
- **Images** — upload, then copy the `<img src="/content/images/…">` tag
  into a section. On EC2 (SSM) access only small images transfer
  reliably.
- **Maintenance Mode** — Enable (with a title and message), Disable, or
  Status. Visitors see the maintenance page while it's on.

## Web App Logs

The last 100 – 10 000 lines of the website's `logs/app.log`, newest at
the bottom. **Refresh** re-reads it.

## Web App Settings

The website's own `config.json`, by tab: General, Email, Security,
Database, Server. Saving writes only that tab's fields — everything else
in the file, including secrets, is left alone — and then offers to
**restart the web app** (it reads its config at startup). If you choose
"Not now", the power bar shows **Restart pending** until you restart.

- **Email → Show email links in the browser (TESTING / TEMPORARY)** —
  while email isn't set up, the website shows sign-up / verification /
  password-reset links on screen. Turn it off as soon as email works.
- **Email → AWS (SES credentials)** — only needed with the AWS SES
  transport.
- The **power bar** (Start / Stop / Restart) runs the commands set under
  Settings → Web App.

## Backup/Restore

- **Web App rebuild** — one click captures configuration + website
  (sections, window styling, images) + database into a bundle under
  `backups/` on this machine. **Full Restore** walks through: test access
  → optional Maintenance Mode → verify the bundle → restore configuration
  → website → database, then prompts for the web app restart. Use it
  after the web app server is rebuilt.
- **Console settings** — this console's config (excluding session keys
  and admin passwords).
- **Web App configuration / website** — selective restore by section.
- **Web App database** — full JSON snapshot; restore replaces *all* data
  and requires typing `RESTORE`. Stop the web app or enable Maintenance
  Mode first.

Bundles and configuration backups contain secrets and password hashes —
store them like the database.

## Settings

- **Security** — password rules for console admins and for passwords you
  set on Members; login throttling for this console (restart to apply).
- **Appearance** — light / dark, backgrounds, translucency. Live.
- **Web App** — how the console reaches the website: **Local** (same
  machine), **Remote via SSH** (host, user, private key), or **Remote on
  EC2** (instance id + region, instance profile or access keys, run-as
  user `mmoa`). Also the web app's directory, the database connection, and
  the Start / Stop / Restart commands. **Test connection** checks the
  values in the form before you save. Database changes need a console
  restart (a dialog says so).
