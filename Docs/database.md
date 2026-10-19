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
| `users` | `user_id` PK, `login_name` (unique, case-insensitive), `email` (unique, lowercased), `first_name`, `last_name`, `phone_number`, `password_hash`, `role` (`member` / `admin`), `is_active`, `email_verified_at`, `created_at`, `last_login_at` |
| `email_verification_tokens` | `token_id`, `user_id` (FK cascade), `token`, `expires_at`, `consumed_at`, `created_at` |
| `password_reset_tokens` | same shape |
| `login_lockouts` | `id`, `scope` (`ip` / account), `scope_key`, `fail_count`, `locked_until_ms` (epoch ms), `last_failed_at`, `updated_at`, `created_at` |
| `events` | `event_id`, `title`, `description`, `location`, `starts_at`, `ends_at`, `is_published`, `created_at`, `updated_at` |

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
| Members → Create | `INSERT INTO users` (role `member`; `password_hash` bcrypt or `no_login`) |
| Members → Modify / Verify | `UPDATE users`; verifying also stamps `consumed_at` on open verification tokens |
| Members → Reset password | `UPDATE users SET password_hash`; consumes open reset tokens |
| Members → Delete | one transaction: delete the member's tokens, then the user |
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
