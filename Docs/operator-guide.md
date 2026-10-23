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
Changing your password keeps you signed in on this browser and signs
out every other session for your account. Sessions also end after
`sessionMaxAgeHours` (8 by default) whatever the browser does.

## Dashboard

At-a-glance counts. Tiles link to the page that explains them:
nonprofits verified / pending verification / rejected, upcoming published
events, event drafts, open raffles, logins currently locked out, and
console admins. Below them, the **Pending verification** list — each name
opens that nonprofit. A red banner means the database couldn't be reached.

## Admins

Who can sign in to **this console**. Re-using a username replaces that
admin's email / name / password. You can't remove yourself or the last
admin. Removing an admin (or replacing their password) ends their
existing sessions on the next request — they land on the login page.

## Events

The website is where events live (Facebook posts just link to them).

- **Status** — every event is **Draft** (being prepared, not on the
  website), **Published** (on the website) or **Archived** (taken off the
  website but kept here for reference — e.g. to copy next year). Change it
  with the Draft / Published / Archived buttons at the top of the page or
  the identical set at the bottom of the form: clicking one **saves the
  event** (your edits included) with that status. On **New event** they
  create it with that status; "Create event" alone makes a draft.
- **Show** drop-down — **All** (the default), **Draft**, **Published** or
  **Archived**, each with its count. Published events are split the way
  the website splits them: **upcoming** (starting no more than 12 hours ago;
  soonest first), then **past** (newest first). "All" shows Drafts,
  Published — upcoming, Published — past, then Archived. Only Published
  events are on the site.
- **New event** — title, optional URL slug (made from the title; changing
  it later breaks links already shared), summary (≤ 200 characters, shown
  on cards), **Starts** in **Central time** (`timeZone` in this console's
  config) picked from a calendar with a time picker (or typed), an
  optional **Ends** — tick "Has an end time" to add one (it starts 3 hours
  after the start and can't be earlier than it; untick to leave the end
  open) — description, venue / address / city, optional map link (blank =
  the site builds a Google Maps search from the address), registration
  link (a Stripe Payment Link or any https page) with its button label and
  note, and **beneficiaries** — pick a directory organization (the site
  links to its profile while it's verified and listed) or type a name and
  link.
- **Description** — Markdown-lite: blank line = paragraph, `**bold**`,
  `*italic*`, `[text](https://…)`, lines starting `- ` for bullets. The
  **Preview** beside the box uses the website's own renderer.
- **Flyer / cover** — appear after the event is saved. Pick a photo; your
  browser shrinks it to 1600 px and uploads it to the website's
  `uploads/events/`. Replacing or removing one deletes the old file.
- **Generate flyer** — next to the flyer's Upload: builds a 1200 × 1600
  flyer from the event's details as they are in the form *right now*
  (title, summary, when, where, the registration note, who it benefits and
  the event's web address) over the **cover photo** (a dark backdrop if
  there isn't one), in the website's fonts and colours. **Use as flyer**
  uploads it as the event's flyer (saving any unsaved edits too);
  **Download** saves a copy. Change the event and generate again to update
  it — uploading your own flyer still works the same.
- **Latest event** — tick "Also show this event at /events/latest" to give
  one event a fixed address you can share (e.g. a pinned Facebook post).
  Only one event can be Latest: ticking it on another event moves it there
  (the form says which event has it now, and the save message says which
  one lost it). `/events/latest` only works while that event is
  Published. `latest` can't be used as an event's own slug.
- **Preview** — opens the event's **real website page** in a pop-up (with
  Desktop / Phone width and "Open in new tab"), even while it's a draft or
  archived; a "Preview" banner says it isn't public. It shows the last
  *saved* version. The preview link lasts 30 minutes and only works for
  whoever has it. Needs the Public base URL (Web App Settings → General),
  and the Web App has to be **running** (it serves the page): the console
  checks first, and if it's offline — or in maintenance mode — the pop-up
  says so, with a **Try again** button.
- **View on site** (published events), and **Delete** (also deletes the
  image files).

## Raffles

Same pattern as events. Tickets are sold **in person only** (Texas law),
so "How to buy" carries that wording and there is no payment link.

A raffle has two separate settings:

- **Status** — **Draft** / **Published** / **Archived**, exactly like
  events: only Published raffles are on the website. Change it with the
  buttons at the top of the page or the bottom of the form (a click saves
  the raffle, edits included).
- **Stage** — **Open** (selling tickets) → **Closed** (sales ended) →
  **Drawn** (enter the winning ticket number), one step at a time, each
  undoable one step back. Stages work whatever the status, so you can take
  a *draft* through every stage and **Preview** how the page looks at each
  one before publishing. On the website, published Open / Closed raffles
  are "current", Drawn ones "past"; the winning ticket shows only once drawn.

- **Show** drop-down — **All** (the default), **Draft**, **Published** or
  **Archived**, each with its count; the list shows each raffle's status
  and stage.
- **Latest raffle** — like events: tick "Also show this raffle at
  /raffles/latest" (right under the URL slug). One raffle at a time —
  ticking it on another moves it there; it only works while that raffle is
  Published, and `latest` can't be a raffle's own slug.
- **Who it benefits** — the same list as events: add as many beneficiaries
  as you like (a directory organization, or a name + optional link), reorder
  them, plus an optional **Beneficiaries note**. The website shows them under
  "Where the money goes".
- **Drawing date & time** — the same calendar + time picker as events.
- **Generate flyer** — like events, next to the raffle flyer's Upload:
  a 1200 × 1600 flyer over the **first prize photo** with the title, the
  prize description's first paragraph, **Drawing** (date, time, location)
  and **Tickets** (price, total) cards, the first sentence of "How to buy"
  (the in-person-only wording), who it benefits and the raffle's address.
  **Use as flyer** / **Download** work the same way.
- **Preview** — the same pop-up as events: the raffle's real website page,
  even while it's a draft or archived (a banner says so), at Desktop / Phone
  width. It shows the last *saved* version and needs the Web App running.

- **How to buy** and **Claim requirements** (one per line) each have a
  **Templates…** drop-down: **load** a saved template into the box (it asks
  before replacing different text), **Save as new template…** (type a name),
  **Update “…”** (overwrite the template you last loaded or saved there), or
  **Manage templates…** (Settings → Templates, in a new tab). Starter
  templates: "In person (default)", "Firearm" and "Standard".
- **Flyer** and up to **8 prize photos** (with alt text; ◀ ▶ to reorder).

## Nonprofits

Every organization with a login on the website ("Need Help?" directory).
New sign-ups start **Pending verification** and are not in the public
directory until a board member verifies them.

- **Search / filter** by verification status, whether the organization
  listed or hid its profile, and account state.
- The detail page shows the **whole profile**, including fields the
  organization marked hidden (each field is tagged public / hidden), its
  contacts, categories, cities and photos (**Remove** takes down an
  inappropriate photo and deletes the file), and its private **search
  keywords** (never shown on the website; they only help the "Need Help?"
  keyword search find the organization).
- The keyword search matches the organization name, its search keywords,
  its services, and its public address / hours / cities served — not the
  description or "What to bring".
- **IRS / ProPublica lookup** runs automatically: the IRS name, city /
  state, ruling date, NTEE code and 501(c) subsection for the EIN — or
  "not found" (new organizations can take months to appear; use the IRS
  Tax Exempt Organization Search link).
- **Verify / Mark rejected / Reset to unverified**, with a private note.
- Account actions: activate / deactivate the login, mark the email
  verified, reset password, edit account, and **Delete** (removes the
  account, the profile, its contacts / categories / cities / photo files;
  events and raffles that named it keep the name without the link).

## Categories & Cities

The services and service areas organizations pick and visitors search by.
Order here is the website's order (▲ ▼). **Deactivate** hides one from the
website and the portal without touching organizations that already chose
it; **Delete** is only offered when no organization uses it. Category
slugs appear in links (`/need-help?category=food`) — avoid changing them.
**Other** is *built in*: the website relies on it (and re-adds it on every
restart), so you can rename, reorder or deactivate it, but not delete it or
change its slug.

## Board

The board roles on the About page, in order: role, description, the
person holding it (blank = open) and their photo. Add or remove roles.

## Data Browser

Direct access to every table, for anything the pages above don't cover:

- Search matches text columns, or an id when you type a number. Click a
  column heading to sort.
- Password hashes are masked and read-only — use Nonprofits → Reset
  password.
- Edits bypass the website's own validation and don't delete image files
  — prefer the dedicated pages.

## Locked Users

Accounts and IP addresses the website has temporarily blocked after too
many failed logins (default: 10 failures → 5 minutes; change it under
Web App Settings → Security). **Unlock** clears the block immediately.
"Only show currently locked" hides lapsed rows.

## Reports

All nonprofits, nonprofits pending verification, events, raffles, login
lockouts and console admins. **View** opens the rows in-app; **Download CSV** saves them
(cells that look like spreadsheet formulas are neutralised).

## Web App Website

Edit the website's fixed copy — **Home hero**, **About — our story**,
**How you can help**, **Partner With Us** and **Footer**. Events, raffles,
the board and the directory come from the database (their own pages).

- Each card holds that section's HTML. Saves are live on the next page
  load — no restart. **Preview** shows the unsaved HTML on the site's dark
  palette.
- Keep the `{{tokens}}` (`{{appTitle}}`, `{{orgName}}`, `{{year}}`) — the
  website fills them in.
- **Images** — upload, then copy the `<img src="/content/images/…">` tag
  into a section. Works in every access mode.
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
- **General → Public site info** — phone, EIN and Facebook URL shown in the
  site's header / footer, the portal's max upload size, and the optional
  **Donate** button: paste the donation payment link (e.g. a Stripe Payment
  Link) and turn on **Show the "Donate" button** — it won't turn on without
  a valid `https://` link. Turning it off keeps the link for later. Restart
  the web app after saving.
- The **power bar** (Start / Stop / Restart) runs the commands set under
  Settings → Web App.

## Backup/Restore

### What's in a bundle

**Web App rebuild** — one click captures everything needed to rebuild the
Web App's state at that moment into a single bundle under `backups/` on
this machine (`web_app_bundle_<stamp>.json`, downloadable):

| Section | What |
|---|---|
| `config` | the Web App's `config.json` |
| `localSecrets` | `local-secrets.json` — the session signing keys, so members stay signed in after a restore |
| `maintenance` | `maintenance.json` — the Maintenance Mode state |
| `website` | every `HTML/<section>.html` fragment + `HTML/images/*` |
| `uploads` | `uploads/**` — event flyers / covers, raffle photos, nonprofit photos, board photos |
| `database` | every table of the live catalog (`admin_audit`, `raffle_beneficiaries`, `org_*`, … — discovered, not listed by hand), as **one point-in-time snapshot** (see [database.md](database.md)) |
| `templates` | this console's raffle text templates (`<kind>/<id>.json` under the Settings → Templates folder) |
| `console` | this console's own settings export (the same file Console settings → Backup downloads) |
| `_meta` | the manifest: created at, console version, engine, the time window the files and the database were read in, a row count per table, a sha256 + size per file, file count and total bytes, template counts, whether the secrets were captured, and any image path in the database that had **no file on the host** when the bundle was made |

The files are read first, then the database, and the manifest records
both windows (`_meta.window`) — on a quiet site they are milliseconds
apart. Over EC2 (SSM) access, files larger than ~18 KB can't be read and
are listed as warnings — use SSH / Local for a complete bundle. For the
demo data (31 nonprofits with photos, two events with flyer + cover, two
raffles with photos) a bundle is about 12 MB.

Bundles are listed from a small `.meta.json` summary written next to each
one (a bundle copied in by hand is summarized once, on the next page
view). Each bundle row offers **Download** and, for bundles that carry one,
**Console settings** — the console settings export inside the bundle as a
file for Console settings → Restore (a bundle restore never changes this
console's own settings).

### Verify

**Verify selected bundle** runs a checklist (shown in the Progress area
and in the status window) and records a `backup.verify` audit row:

- JSON parses · manifest present · bundle type
- `config.json` present · `local-secrets.json` present (yes / no — never
  the values) · `maintenance.json` present
- website HTML sections (all five) · images · uploads
- database tables present · **every table's row count equals the
  manifest** · **every file's sha256 matches the manifest**
- **every image path the database refers to has a file in the bundle**
  (missing ones are listed)
- console templates present · console settings present

A failed *error* check (type, config, tables, row counts, hashes) makes the
bundle invalid and the restore refuses it; the rest are warnings. Bundles
made by an older console (no manifest) still restore — Verify says what it
could not check.

### Restore

**Full Restore** walks through: test access → optional Maintenance Mode →
verify the bundle → restore, with the status window showing each step:

1. configuration — `config.json` (only the keys Web App Settings edits;
   the bundle's `maintenanceCommand` is left as the host has it unless you
   tick **Also restore the shell commands**) + `local-secrets.json`
   (mode 600)
2. website — HTML sections, images
3. uploads — every file in the bundle is written; tick **Remove uploads
   not in the bundle** (off by default) to also delete files under
   `uploads/` the bundle doesn't have
4. database — **every live table is emptied**, then the bundle's tables are
   reloaded in one transaction (a live table the bundle lacks ends up
   empty, a bundle table the live schema lacks is skipped — both are
   reported)
5. console templates — ticked by default; written into the Settings →
   Templates folder, a template with the same id is replaced, others are
   kept
6. `maintenance.json` — last, so a bundle made with Maintenance Mode off
   can't lift your maintenance screen mid-restore; if the bundle was made
   with it ON, the page says so and offers to disable it

then it prompts for the Web App restart the new config needs. A
`backup.restore` audit row lists what was restored and what was skipped
(`backup.create`, `backup.upload`, `backup.verify` and `backup.delete` are
recorded too). The safeguards stay: type `RESTORE`, the access test must
pass, one backup / restore at a time, shell commands only when ticked.

**Restoring to a fresh box**

1. Clone the Web App repo on the new host and run its `START_APP.sh` once,
   so `node_modules`, the SPA build and the database exist (it bootstraps
   the schema onto a fresh `mmoa_web_app.db`; on MySQL run
   `SETUP_MYSQL_DB.sh`). Stop it or enable Maintenance Mode.
2. On this console, point Settings → Web App at the new host (and its
   database), then **Test access to the Web App**.
3. Select the bundle (upload it first if it was made elsewhere), **Verify**,
   type `RESTORE`, **Web App Full Restore**.
4. Restart the Web App (the prompt / power bar) so it reads the restored
   `config.json` and `local-secrets.json`.

**Why not just copy `mmoa_web_app.db`?** The Web App keeps the SQLite
file in WAL mode: recent commits live in `mmoa_web_app.db-wal` until a
checkpoint, so a plain copy of the `.db` file alone is **not** a safe
backup — it can be missing the latest writes or be torn mid-checkpoint.
Use the console's bundle / database export (a read transaction, one
snapshot), or on the host `sqlite3 mmoa_web_app.db ".backup backup.db"`.

- **Console settings** — this console's config (excluding session keys
  and admin passwords). The `webApp` section's Start / Stop / Restart
  commands are kept as they are unless you tick **Also restore the shell
  commands**; appearance values that aren't an uploaded `/images/…` file
  or a plain color are dropped (the page says so).
- **Web App configuration / website** — selective restore by section.
  Only known config keys are offered; `maintenanceCommand` needs the
  commands box ticked.
- **Web App database** — full JSON snapshot; restore replaces *all* data
  and requires typing `RESTORE`. **Every live table is emptied**, then
  the tables the backup has are reloaded — a live table the backup lacks
  ends up empty, a backup table the live schema lacks is skipped, and
  both cases are reported on the result banner. Stop the web app or
  enable Maintenance Mode first.

**Why the commands box?** The console runs those values as shell
commands on the Web App host (Maintenance Mode, the power bar). A backup
file you didn't make yourself could plant one, so a restore keeps the
live commands unless you say otherwise.

Bundles and configuration backups contain secrets (the Web App's SMTP /
AWS credentials and session keys, this console's SSH key / AWS keys /
MySQL password) and password hashes — store them like the database.

## Settings

- **Security** — password rules for console admins and for passwords you
  set on Nonprofits; login throttling for this console (restart to apply).
- **Appearance** — light / dark, backgrounds, translucency. Live.
- **Web App** — how the console reaches the website: **Local** (same
  machine), **Remote via SSH** (host, user, private key), or **Remote on
  EC2** (instance id + region, instance profile or access keys, run-as
  user `mmoa`). The SSH private key and the AWS secret are write-only:
  the form never shows them again — leave the field blank to keep what
  is stored, paste a new value to replace it, or tick **Remove the
  stored …** to clear it. Also the web app's directory, the database connection, and
  the Start / Stop / Restart commands. **Test connection** checks the
  values in the form before you save. Database changes need a console
  restart (a dialog says so).
- **Templates** — the raffle text templates ("How to buy", "Claim
  requirements"): where they're saved (a folder on this console's server,
  default `templates/` in the console folder — one sub-folder per field,
  one `.json` file per template), and create / edit / rename / delete for
  each. A Web App rebuild bundle carries them too (and puts them back on
  restore unless you untick it).
