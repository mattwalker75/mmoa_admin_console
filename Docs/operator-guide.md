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
nonprofits verified / pending verification / rejected, upcoming published
events, event drafts, open raffles, logins currently locked out, and
console admins. Below them, the **Pending verification** list — each name
opens that nonprofit. A red banner means the database couldn't be reached.

## Admins

Who can sign in to **this console**. Re-using a username replaces that
admin's email / name / password. You can't remove yourself or the last
admin.

## Events

The website is where events live (Facebook posts just link to them).

- **Status** — every event is **Draft** (being prepared, not on the
  website), **Published** (on the website) or **Archived** (taken off the
  website but kept here for reference — e.g. to copy next year). Change it
  with the Draft / Published / Archived switch at the bottom of the form, or
  the same three buttons at the top of the page (they save your edits too).
- **Upcoming / Past / Drafts / Archived** — upcoming means published and
  starting no more than 12 hours ago (the website's rule); past means
  published and older. Only Published events are on the site.
- **New event** — title, optional URL slug (made from the title; changing
  it later breaks links already shared), summary (≤ 200 characters, shown
  on cards), start / end in **Central time** (`timeZone` in this console's
  config), description, venue / address / city, optional map link (blank =
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
- **Preview** — opens the event's **real website page** in a pop-up (with
  Desktop / Phone width and "Open in new tab"), even while it's a draft or
  archived; a "Preview" banner says it isn't public. It shows the last
  *saved* version. The preview link lasts 30 minutes and only works for
  whoever has it. Needs the Public base URL (Web App Settings → General).
- **View on site** (published events), and **Delete** (also deletes the
  image files).

## Raffles

Same pattern as events. Tickets are sold **in person only** (Texas law),
so "How to buy" carries that wording and there is no payment link.

- **Claim requirements** — one per line. **Firearm preset** / **Standard
  preset** fill the box (you can still edit it).
- **Status** — Draft → Open (selling) → Closed (sales ended) → Drawn
  (enter the winning ticket number), one step at a time; each step can be
  undone one step back. The website lists open, closed and drawn raffles
  that are published, and shows the winning ticket only once drawn.
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

- **Web App rebuild** — one click captures configuration + website
  (sections, images) + every uploaded image (`uploads/` — flyers, prize,
  nonprofit and board photos) + database into a bundle under `backups/` on
  this machine. Over EC2 (SSM) access, uploads larger than ~18 KB can't be
  read and are listed as warnings — use SSH / Local for a complete bundle.
  **Full Restore** walks through: test access → optional Maintenance Mode
  → verify the bundle → restore configuration → website → uploads →
  database, then prompts for the web app restart. Use it
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
  set on Nonprofits; login throttling for this console (restart to apply).
- **Appearance** — light / dark, backgrounds, translucency. Live.
- **Web App** — how the console reaches the website: **Local** (same
  machine), **Remote via SSH** (host, user, private key), or **Remote on
  EC2** (instance id + region, instance profile or access keys, run-as
  user `mmoa`). Also the web app's directory, the database connection, and
  the Start / Stop / Restart commands. **Test connection** checks the
  values in the form before you save. Database changes need a console
  restart (a dialog says so).
