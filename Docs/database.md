# Database

The console has no database of its own. It reads and writes the **web
app's** database — `mmoa_web_app.db` (SQLite) or the `mmoa_web_app`
MySQL schema — which `mmoa_web_app` creates and migrates
(`setup_sqlite_db.sql` / `setup_mysql_db.sql` + its boot-time
migrations). The console applies no migrations.

## The DB module

[db/database.js](../db/database.js) returns one object with the same
surface for every backend:

```
engine, available, statusMessage, remote?
get / all / run            (callback style)
getAsync / allAsync / runAsync   → row / rows / { lastID, changes }
transaction(async tx => …)
```

Backends:

- **Local SQLite** (`engine: sqlite`, `webApp.mode: local`) — the
  `sqlite3` driver, `PRAGMA foreign_keys = ON`. The file is opened
  read-write **without create**: if it doesn't exist the console runs
  offline instead of making an empty file (which would stop the web app
  from bootstrapping its schema onto a fresh file). Restart the console
  once the web app has created it.
- **Remote SQLite** (`engine: sqlite`, mode `ssh` / `ec2`) —
  [db/remoteSqlite.js](../db/remoteSqlite.js) runs every statement as
  `sqlite3 -batch -json -cmd ".timeout 5000" <file> '<sql>'` on the
  web-app host through the transport. Bound values are encoded as SQL
  literals (quote-aware `?` substitution). Transactions are queued and
  flushed as one `BEGIN…COMMIT` script with `-bail` (large ones are
  chunk-uploaded to a temp file first). Expect ~1 s per statement over
  SSM. Foreign keys are **not** enforced (each statement is a new
  process). The `sqlite3` CLI must be installed on the host.
- **MySQL** — `mysql2` pool with `timezone: 'Z'` and `dateStrings: true`,
  so DATETIME values come back as the stored `YYYY-MM-DD HH:MM:SS`
  strings, exactly like SQLite. The pool is lazy; reachability is
  discovered on the first query.
- **Dead DB** (`engine: ""`, unknown engine, missing SQLite file, driver
  missing) — every query rejects with a clear error.

## Offline behaviour

Routes wrap queries in `safeGet` / `safeAll` (or try/catch) and render a
**"Database unavailable"** banner with empty data instead of failing.
Reports refuse DB-backed reports while offline; Backup hides the
database group. Login never touches the DB.

## Schema the console expects

From the shared build contract (both engines, same columns):

| Table | Columns used by the console |
| ----- | --------------------------- |
| `users` | `user_id` PK, `login_name` (unique, case-insensitive), `email` (unique, lowercased), `first_name`, `last_name`, `phone_number`, `password_hash`, `is_active`, `email_verified_at`, `created_at`, `last_login_at` |
| `email_verification_tokens` | `token_id`, `user_id` (FK cascade), `token`, `expires_at`, `consumed_at`, `created_at` |
| `password_reset_tokens` | same shape |
| `login_lockouts` | `id`, `scope` (`ip` / account), `scope_key`, `fail_count`, `locked_until_ms` (epoch ms), `last_failed_at`, `updated_at`, `created_at` |
| `organizations` | `org_id`, `user_id` (1:1), `name`, `ein`, address / contact / social fields (`phone` + optional `phone_ext`), `description_md`, `hours`, `what_to_bring`, `search_tags` (private comma-separated search keywords — never public, only used by the keyword search), `public_fields` (JSON array), `is_listed`, `verification_status` (`unverified` / `verified` / `rejected`), `verified_at`, `verified_by`, `verification_note`, `created_at`, `updated_at` |
| `org_contacts` (incl. optional `phone_ext`), `org_images` (`path` relative to `uploads/`; `alt` doubles as the public photo caption), `org_categories`, `org_cities` | children of `organizations` |
| `categories` / `cities` | `category_id` / `city_id`, `slug` (categories), `name`, `sort`, `is_active`. The `other` category is built in: the web app re-adds it on every start, so the console locks its slug and refuses to delete it |
| `events` | `event_id`, `slug`, `title`, `summary`, `description_md`, `starts_at`, `ends_at` (UTC), venue / address / city / `map_url`, `flyer_path`, `cover_path`, `registration_url` / `_label` / `_note`, `beneficiaries_text`, `status` (`draft` / `published` / `archived` — only published is public), `is_published` (legacy mirror: 1 only while published; the console keeps it in step), `preview_token` + `preview_expires_at` (the Preview button's 30-minute link), `created_at`, `updated_at` |
| `event_beneficiaries` | `event_id`, `org_id` (nullable), `name`, `url`, `sort` — no primary key; replaced wholesale on save |
| `raffles` / `raffle_images` | the raffle fields incl. `status` (`draft` / `open` / `closed` / `drawn`), `winning_ticket`, `claim_requirements`, `claim_preset`, `beneficiary_org_id`; prize photos with `path`, `alt`, `sort` |
| `board_members` | `board_id`, `role_title`, `role_description`, `person_name`, `photo_path`, `sort` |

Remote SQLite (ssh / ec2) has no foreign-key enforcement and no reads
inside a transaction, so every page above reads first, then writes, and
deletes / nulls child rows itself.

Portability rules followed by every query here:

- Timestamps written by the console come from `sqlTime()` — a
  JS-computed UTC `YYYY-MM-DD HH:MM:SS` string, the same format the web
  app writes — never `datetime('now')` or `NOW()`.
- "Is it locked now?" compares `locked_until_ms` against a bound
  `Date.now()`.
- No string concatenation in SQL (`||` means OR on MySQL); names are
  composed in JS.
- `LIKE … ESCAPE '!'` (a backslash escape is not portable to MySQL).

## What each page writes

| Page | Writes |
| ---- | ------ |
| Nonprofits → Verification | `UPDATE organizations` (`verification_status`, `verified_at`, `verified_by`, `verification_note`) |
| Nonprofits → account actions | `UPDATE users` (active, email verified + consume open verification tokens, account fields, `password_hash` + consume open reset tokens) |
| Nonprofits → Delete | read photo paths, then one transaction: null `event_beneficiaries.org_id` / `raffles.beneficiary_org_id`, delete `org_images`, `org_contacts`, `org_categories`, `org_cities`, `organizations`, the user's tokens and the user; then `rm -f` the photo files |
| Events → Create / Save | `INSERT` / `UPDATE events`; beneficiaries replaced (`DELETE` + `INSERT`) in one transaction; slug made unique (`-2`, `-3`, …) |
| Events / Raffles / Board → image upload | file first (`writeFileChunked`), then `UPDATE … SET *_path` / `INSERT INTO raffle_images`; the replaced file is deleted; a failed DB write deletes the new file |
| Events / Raffles → Delete | one transaction (children, then the row), then the image files |
| Raffles → Status | `UPDATE raffles SET status, winning_ticket … WHERE status = <current>` (one step at a time) |
| Categories & Cities / Board / prize photos → reorder | `sort` renumbered 1..n in one transaction |
| Categories & Cities → Delete | `DELETE … WHERE id = ? AND NOT EXISTS (SELECT 1 FROM org_* …)` — refused while in use |
| Locked Users → Unlock | `DELETE FROM login_lockouts WHERE id = ?` |
| Data Browser | `UPDATE` / `INSERT` / `DELETE` on any table, by primary key |
| Backup → Database restore | every table present in both the backup and the live schema is emptied and reloaded in one transaction, with FK checks off (`PRAGMA foreign_keys = OFF` around it on SQLite, `SET FOREIGN_KEY_CHECKS = 0` inside it on MySQL) |

## Data Browser internals

[helpers/dbSchema.js](../helpers/dbSchema.js) is the single source of
identifiers:

- `listTables` — `sqlite_master` (minus `sqlite_*`) or
  `information_schema.tables` (`BASE TABLE`s of `DATABASE()`).
- `describeTable` — `PRAGMA table_info` or `information_schema.columns`
  + `key_column_usage` (for composite primary-key order). Each column:
  `name, type, notnull, dflt, pk, auto`.
- `quoteIdent` — backtick quoting, valid on both engines, only applied
  to catalog names.

Nothing is cached, so a column the web app adds at its next boot shows up
on the next page load. See [security.md](security.md) for the write
safety rules.

## Database backups

**Backup/Restore → Web App database** exports an engine-neutral JSON
envelope:

```json
{ "_meta": { "type": "web-app-database", "engine": "sqlite", "tableCount": 5, "rowCount": 68, … },
  "tables": { "users": [ {…}, … ], "events": [ … ], … } }
```

A SQLite dump can be restored into MySQL and vice versa (verified both
ways during development). Restore requires typing `RESTORE`; only tables
and columns that exist in the live schema are touched.
