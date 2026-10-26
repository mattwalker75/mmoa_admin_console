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

The page opens straight away and the numbers fill in a moment later
("Loading the latest numbers…"). When the Web App's database is on the
EC2 instance every read is an SSM round trip, so that takes a second or
two; signing in no longer waits for it.

**Slow pages.** Any page that reads the Web App's database over EC2 can
take a few seconds. If a page hasn't arrived after about 0.7 s a
"Loading… fetching data from the Web App" notice appears at the top of the
screen and goes away when the page loads.

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
  listed or hid its profile (or MMoA hid it), and account state.
- The list shows each organization's **login name** (sortable column),
  and the nonprofit page repeats it under the title and in *Login account*.
- **New nonprofit** creates a login and its organization profile from the
  console, for an organization that is not signing itself up on the
  website: the same rules as sign-up (login name, email, contact person,
  organization name, optional EIN — formatted as you type, like the site)
  plus a temporary password typed twice (**Generate** makes a random one
  and fills both fields). Two boxes, both off by default: *Mark the email
  address as verified* (otherwise the login is refused until the
  organization verifies it) and *Mark the organization as verified* (it
  goes straight into the directory, listed, with every field public). The
  temporary password is shown **once**, on the page you land on — pass it
  to the organization; it is not kept anywhere, including the audit log.
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
- **Preview** (next to the status) opens the organization's real page on
  the website in a pop-up — desktop or phone width — through a link that
  works for 30 minutes and isn't public, whatever the verification status
  or listing (like event / raffle previews). Only shown when the account
  has an organization profile and the Web App's public URL is set.
- **Edit profile** changes every field the organization can edit in its
  portal — name, EIN, address, phone, public email, links, description,
  hours, what to bring, search keywords, services, cities served, contacts,
  which fields are public, and the organization's own "Listed in Need
  Help?" switch — with exactly the portal's rules (same normalizing of
  phone numbers, Facebook / Instagram links and EINs, same limits, same
  error messages). The EIN can be changed here at any status (the
  organization itself can't once reviewed); leaving it blank keeps the
  stored one. The website shows the change within 20 seconds.
- **Lock login / Unlock login** (under *Login account*) — an admin lock on
  the account: the website refuses sign-in with "locked by Mission Men of
  Anna" until you unlock it here (or under Locked Users). It never expires
  on its own. *Unlock* also clears an automatic too-many-failures lock.
  Different from **Deactivate login**: a deactivated account is switched
  off (and signed out) as a matter of record; a lock is a hold.
- **Hide from directory / Show in directory** (under *Login account*) is
  MMoA's override: a hidden organization is not in the public "Need Help?"
  directory whatever its own listing switch says, and its portal tells it
  MMoA hid it. The page and the list show **Hidden by MMoA**, distinct from
  the organization's own **Hidden** (its listing switch off).
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

Accounts and IP addresses the website has blocked: automatically after too
many failed logins (default: 10 failures → 5 minutes; change it under Web
App Settings → Security), or by an admin with **Lock login** on the
nonprofit's page (shown as *Locked by MMoA*, never lapses). **Unlock**
clears either immediately. One entry per account (login name and email,
linked to the nonprofit's page); "Only show currently locked" hides lapsed rows.

## Reports

All nonprofits, nonprofits pending verification, events, raffles, nonprofit
activity, login lockouts and console admins. **View** opens the rows in-app; **Download CSV** saves them
(cells that look like spreadsheet formulas are neutralised). The nonprofit
reports and the lockout report include each account's login name; a
lockout row also shows the email and whether the lock is an admin lock
("locked by MMoA").

**Nonprofit activity** is the website's anonymous usage count per
nonprofit: how often it appeared in Need Help search results, how often
its profile was opened, and how often each of its links was used (call,
directions, website, email, Facebook, Instagram, other), over the last 7
days, 30 days and 12 months. The website counts in memory and writes once
an hour, so the current hour is not in the report yet; it keeps hourly
detail for 7 days, daily for 4 weeks, weekly after that, and deletes
anything older than 5 years. Nothing about the visitor is recorded. Each
nonprofit sees its own numbers in its portal ("Your profile activity").

## Web App Website

Edit the website's fixed copy — **Home hero**, **About — our story**,
**How you can help**, **Partner With Us** and **Footer**. Events, raffles,
the board and the directory come from the database (their own pages).

- Each card holds that section's HTML. Saves are live on the next page
  load — no restart. **Preview** opens the unsaved HTML in a window on the
  site's dark palette with its images shown and its `{{tokens}}` filled in
  (the site's own component styles are not applied, so it is approximate).
- Keep the `{{tokens}}` — the website fills them in: `{{appTitle}}`,
  `{{appSubtitle}}`, `{{orgName}}`, `{{tagline}}`, `{{foundedYear}}`,
  `{{phone}}`, `{{phoneTel}}` (digits only, for `tel:` links), `{{email}}`,
  `{{ein}}`, `{{addressLine1}}`, `{{addressLine2}}`, `{{city}}`, `{{state}}`,
  `{{zip}}`, `{{address}}` (all of it on one line), `{{meetingInfo}}`,
  `{{facebookUrl}}`, `{{instagramUrl}}`, `{{youtubeUrl}}`, `{{xUrl}}`,
  `{{nextdoorUrl}}`, `{{donationUrl}}` (empty while the Donate button is
  off), `{{year}}` and `{{eventCount}}`. An unset value renders as nothing. The values come from Web
  App Settings → General, where each field that feeds a token says so
  ("Website token: …").
- **Website** — the address visitors use, with an **Open website** button
  that opens it in a new browser window. Which address depends on where the
  Web App runs (Settings → Web App):
  - **Local** — its `publicBaseUrl` (Web App Settings → General);
    `localhost` is fine because it's on the same machine.
  - **EC2** — the load balancer the instance is registered with, found
    with read-only AWS calls (target groups → load balancer → listeners,
    for http or https). The card names the load balancer and says whether
    it reports the instance healthy. With no load balancer it falls back
    to a non-localhost `publicBaseUrl`, and never shows localhost. The
    lookup is cached for 10 minutes; saving Settings → Web App clears it.
    The same address is used everywhere the console points at the live
    site: the Preview pop-ups on Events, Raffles and Nonprofits, and the
    fast path for loading uploaded photos.
  - **SSH** — a non-localhost `publicBaseUrl`, else the SSH host on the
    Web App's port.
- **Images** — upload, then copy the `<img src="/content/images/…">` tag
  into a section. **Preview** opens the picture in a floating window (Esc
  or ✕ closes it). Works in every access mode.
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
apart. Over EC2 (SSM) access every file is captured, but in ~15 KB pieces
(one SSM command each), so a photo-heavy site takes a long time to bundle
or restore — SSH / Local are much faster. For the
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

### Validate (before any restore)

Every restore has a **Validate** button — *Validate selected bundle* for
the Full Restore, and *Validate* next to the restore button of Console
settings, Web App configuration, Web App website, Image Restore and Web
App database. It runs every check the restore would run, with the options
you ticked, and stops before the first write: **nothing on the Web App or
this console changes**. The result says whether the restore can be done
and what it would do (sections, files, tables, what needs a restart) or
exactly why not.

- Database (and the database part of a Full bundle): a real **trial load**
  — every row is written inside a transaction that is always rolled back,
  so duplicate keys and other constraint problems are found now, not mid-
  restore. Over EC2 the trial runs on the Web App host with ROLLBACK.
- Full bundle: checksums, row counts and table contents against the
  manifest, fit with this database, access to the Web App (read, write,
  run commands, every uploads folder) and the trial load.
- Images: every checksum and that each file is the image its name says.
- Settings / configuration: every value against the Settings pages'
  limits, and what this server would keep.
- Validation isn't audited (nothing happened) — except the Full bundle
  check, which records a "verify" entry as before.

### Restore

**Tested end to end (2026-10-23, local access, SQLite).** A full backup,
then heavy damage to the site (deleted nonprofits, board and categories,
edited users, deleted and added images and uploads, a defaced and a
missing HTML section, changed config, new session keys, Maintenance Mode
on), then a full restore with the defaults: every table, file, config
value and public / portal API response matched the original, and a
nonprofit signed in before the backup stayed signed in. The same bundle
restored onto a brand-new install (repo checkout, empty database, EC2-style
config) matched as well, apart from that server's own AWS credential
source and maintenance command, which a restore keeps on purpose.

**Deep testing (2026-10-24)** added: MySQL / MariaDB backup → damage →
restore and SQLite ↔ MySQL in both directions (identical, after pinning
the console's MySQL sessions to UTC), awkward data (emoji, 100 KB text,
NULL vs '', quotes, large images), 23 kinds of tampered bundle, schema
skew, failures mid-restore (now leave nothing half-done), concurrent
backups / restores under heavy write load (consistent snapshots; the
one-at-a-time lock holds) and the browser flow. Bundles use about 9× their
size in console memory while being made, verified or restored — mind that
on a small instance once the photo library grows.

**Over EC2 (SSM)** the same backup → damage → restore and the brand-new
install restore were run through a local SSM stand-in that enforces AWS's
output limits: identical results. Files move 4 at a time; with this data
set (≈23 MB of images) a backup was ≈270 SSM-seconds and a restore ≈200 at
0.25 s per command — expect several minutes on real SSM, more as photos
grow. A database step the console stops waiting for is followed to the
end on the host rather than reported as failed.

**Full Restore** walks through: test access (read, write, run a command,
every uploads folder) → optional Maintenance Mode → verify the bundle
(including whether it fits *this* database) → restore → restart the Web
App → turn Maintenance Mode off. The status window shows each step, and
the order is what makes a failed restore safe:

1. **database first** — the bundle is checked against the live schema,
   then every live table is emptied and the bundle's tables reloaded in
   ONE transaction. If anything fails here, **nothing at all has changed**
   (the error names the table and row).
2. configuration — `config.json` (only the keys Web App Settings edits;
   the maintenance command stays as the host has it unless you tick **Also
   restore the shell commands**) + `local-secrets.json` (mode 600). **Keep
   this server's own machine settings** (on by default) keeps the host's
   `port`, `server` (TLS / proxy), `database` connection,
   `aws.runningInAws` and `aws.region`, and its `publicBaseUrl` when it has
   one — they describe the machine and its address, not the site, and the
   EC2 install script sets them per instance (a setting the host doesn't
   have stays at its default). Site settings the bundle doesn't have go back
   to their defaults. File permissions (e.g. a 0600 `config.json`) are kept.
3. website (HTML sections, images) and uploads — written, never removed
   at this point, so a failure here leaves extra files, never missing ones;
   running the restore again finishes the job.
4. console templates — ticked by default; the set is made to match the
   bundle exactly (templates added after the backup are removed).
5. **Remove images not in the bundle** (on by default) — website images and
   uploads added after the backup are deleted, only after every write above
   succeeded. A file the bundle lists as *skipped* is never removed, nor
   are non-image files (`README.txt`, `.gitkeep`).
6. `maintenance.json` — last. If you turned Maintenance Mode on for this
   restore it **stays on**; the page then offers to restart the Web App
   (it reads its config and session keys only at start-up) and only after
   that to turn Maintenance Mode off.

If the console itself stops in the middle (crash, restart), the next page
view shows a red **interrupted** banner saying which step it reached; run
the restore again. Each restore first removes temp files an earlier failed or interrupted
run left behind (older than a minute).


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

- **Console settings** — this console's config plus the Appearance
  background images (excluding session keys, admin accounts and the raffle
  templates themselves, which are in the Full Backup). The file must be a
  console-settings backup. Every value is checked with the Settings pages'
  own rules first — anything that would stop the console starting or lock
  admins out (a busy or invalid port, TLS without usable key / certificate,
  secure-only cookies over plain http, a session age of 0 …) is refused and
  nothing is written. Each ticked section replaces that section (a stored
  SSH key / AWS secret / MySQL password the file lacks is kept). **Web App
  access** (connection: mode, folder, SSH / EC2 settings, and the Start /
  Stop / Restart commands) is only taken from the file when you tick that
  box. The result lists what needs a console restart. Exports and restores
  are in the Audit log.
- **Web App configuration** — the Web App's `config.json` plus its session
  keys (`local-secrets.json`). The keys are only restored when you tick
  **Also restore the session keys** (members stay signed in) — whoever has
  the file could sign in as any member with them. Each ticked
  section replaces that section; values are checked with Web App Settings'
  own limits first (number ranges, choices, the Donate-link guard, a real
  port) and nothing is written if one fails. **Keep this server's own
  machine settings** (on by default) keeps the host's port, TLS / proxy,
  database connection, public address and AWS credential source / region,
  as the Full Restore does. The maintenance command is only taken from the
  file when you tick that box — the page shows the file's command first.
  Every restored section needs a Web App restart; the page offers it. If
  the Web App's `config.json` is missing or broken, the restore rebuilds it
  from the file — only with every section ticked; the broken file is kept as
  `config.json.broken-…` and the new one is private (0600). Sections must
  have the right shape (text, groups, http(s) links) or nothing is written. Exports and restores are in the Audit log.
- **Web App website** — selective restore of the HTML sections (each up to
  the editor's 60 KB; the form shows every section's size). One file
  operation runs at a time: it waits for a running Full Backup / Restore or
  Image Restore. Audited.
- **Images** — *Image Backup* downloads every image with a size and
  SHA-256 each: the website images in `HTML/images/` (Web App Website →
  Images) and the uploads in `uploads/` (event flyers and covers, raffle
  photos, nonprofit photos, board photos). It records what it couldn't
  include (oddly named files, unreadable files, photos the database points
  at that are missing on the host) and the restore shows those notes.
  *Image Restore* takes that file or a full bundle, checks every checksum
  first (a damaged file refuses the restore), skips — with a warning —
  any file that isn't the image its name says, writes the rest (4 at a time;
  over SSH / EC2 a file already identical on the host isn't re-sent), and
  by default removes website images and uploads added after the backup so
  the site looks as it did — never a photo the database uses. One file
  operation runs at a time. The HTML-sections backup does not include
  images.
- **Web App database** — full JSON snapshot; restore replaces *all* data
  and requires typing `RESTORE`. Files up to 256 MB; the file must be a
  database backup; checked against this database first (a NUL character
  in a value, a missing required value … refuse it, nothing changes). One
  operation at a time with the other restores. The result shows accounts
  before → after and locked logins, and offers the Web App restart it
  needs. Audited — and because the audit log lives in the database a
  restore replaces, every database-replacing restore is also written to
  `backups/.restore-log.jsonl` on the console's own disk. Choosing a file
  shows, before you type RESTORE, which tables it would leave empty or skip
  and which columns an older / newer backup lacks or adds. Afterwards it
  warns about photos the restored rows point at that aren't on the host
  (restore those with Image Restore or a Full bundle). Passwords and
  sign-ins go back to the backup's — a password changed since is the old
  one again. Best practice: stop the Web App (or turn Maintenance Mode on)
  first, then restart it after. **Every live table is emptied**, then
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
