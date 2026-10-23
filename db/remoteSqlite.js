// db/remoteSqlite.js — SQLite backend for a database that lives on the
// Web App HOST, not on this machine.
//
// SQLite is a file, not a server: when the Web App runs remotely
// (Settings → Web App mode "ssh" or "ec2"), its mmoa_web_app.db can't
// be opened over the network. Instead, every query is executed ON that host
// by running the `sqlite3` CLI through the same webAppAccess transport
// the rest of the console uses (SSH, or AWS SSM Run Command on EC2). Results
// come back as JSON (`sqlite3 -json`).
//
// Contract: implements the exact same surface as db/database.js's engines —
// engine/available/statusMessage + get/all/run (+ *Async) + transaction —
// so every route works unchanged. Differences worth knowing:
//
//   * Latency: each statement is one remote command (≈1s over SSM). Fine
//     for an operator console; not a general-purpose driver.
//   * Parameters: the sqlite3 CLI has no bind API, so `?` placeholders are
//     replaced with safely-encoded SQL literals ('' doubling for strings,
//     X'…' for buffers). The replacement is quote-aware, so `?` inside a
//     string literal in the SQL text is left alone.
//   * run() is for writes: its result row (lastID/changes) is read back in
//     the same sqlite3 invocation via last_insert_rowid()/changes().
//   * transaction(fn): tx.runAsync() calls are QUEUED, then flushed as a
//     single atomic BEGIN…COMMIT script in one sqlite3 -bail invocation
//     (chunk-uploaded to a temp file when large). Reads inside a
//     transaction are not supported — no current caller does that.
//   * dumpTables(names): a point-in-time read of MANY tables in ONE sqlite3
//     invocation (BEGIN; SELECT marker; SELECT * …; COMMIT;), so a backup
//     is a single snapshot even though every other statement is its own
//     process. The output is split on per-call random markers
//     (splitTableDump) — see Backup/Restore.
//   * Large results on EC2: SSM returns at most ~24 KB of stdout, so there
//     sqlite3 writes to a temp file next to the DB; small outputs are still
//     echoed inline (one command), bigger ones come back through
//     accessor.readFileChunked and the temp file is removed. SSH/local are
//     unaffected (no output cap).
//   * The remote sqlite3 CLI must exist (the mmoa_web_app_infra EC2 user
//     data installs it for SETUP_SQLLITE_DB.sh). A missing DB file is an error, never
//     an implicit create — `sqlite3` happily creates empty DBs otherwise.
//   * `.timeout 5000` is set so writes wait out short locks held by the
//     web app itself instead of failing with SQLITE_BUSY.
//   * Schema is owned by the web app (its setup_sqlite_db.sql + boot-time
//     migrations), so unlike the reference console this backend applies no
//     migrations of its own.
//   * Each statement is its own sqlite3 process, so connection-level
//     PRAGMAs (foreign_keys) do not persist between calls: ON DELETE CASCADE
//     is NOT enforced here. Callers that delete parent rows (Nonprofits
//     → Delete, Events / Raffles → Delete) remove the child rows explicitly.

const crypto = require('crypto');
const webAppAccess = require('../helpers/webAppAccess');

// Single-quote for POSIX sh (same rule as webAppAccess.shQuote).
function shq(s) {
  return `'` + String(s).replace(/'/g, `'\\''`) + `'`;
}

// Per-call random suffix for temp files next to the DB, so two admins'
// transactions / result files can't interleave.
function tmpSuffix() {
  return crypto.randomBytes(4).toString('hex');
}

// Encode one JS value as a SQLite literal.
function sqlLit(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (Buffer.isBuffer(v)) return "X'" + v.toString('hex') + "'";
  return "'" + String(v).replace(/'/g, "''") + "'";
}

// Replace `?` placeholders with encoded literals, skipping quoted spans
// ('…', "…", `…`) so a literal question mark inside SQL text is untouched.
function bindSql(sql, params) {
  const s = String(sql);
  const a = params || [];
  let out = '', i = 0, p = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      out += ch; i++;
      while (i < s.length) {
        out += s[i];
        if (s[i] === ch) {
          if (s[i + 1] === ch) { out += s[i + 1]; i += 2; continue; } // doubled quote = escape
          i++; break;
        }
        i++;
      }
      continue;
    }
    if (ch === '?') {
      if (p >= a.length) throw new Error(`Missing bind parameter #${p + 1} for SQL: ${s}`);
      out += sqlLit(a[p++]); i++;
      continue;
    }
    out += ch; i++;
  }
  if (p < a.length) throw new Error(`Too many bind parameters (${a.length} given, ${p} used) for SQL: ${s}`);
  return out;
}

// Normalize a statement for inclusion in a script: exactly one trailing `;`.
function terminate(stmt) {
  return String(stmt).trim().replace(/;+\s*$/, '') + ';';
}

// Keep any single remote command comfortably under SSM's payload limits
// (the EC2 transport also base64-inflates it by ~33%).
const MAX_INLINE_SQL = 12000;

// On EC2, sqlite3 output up to this many BYTES is echoed inline; anything
// bigger is read back from the temp file in pieces (bytes ≥ chars, so this
// stays under webAppAccess.SSM_OUTPUT_CAP_CHARS).
const MAX_INLINE_OUTPUT = 20000;

// Split a script into base64 pieces of at most `maxBytes` BYTES each, for
// `printf '%s' <b64> | base64 -d >> file`. The split is done on the UTF-8
// bytes — never on the JS string — so a character that straddles a boundary
// (an emoji is two UTF-16 units, four UTF-8 bytes) is reassembled intact when
// the pieces are appended on the host. Exported for the tests.
function chunkForUpload(text, maxBytes) {
  const buf = Buffer.from(String(text), 'utf8');
  const max = Math.max(1, Number(maxBytes) || MAX_INLINE_SQL);
  const out = [];
  for (let off = 0; off < buf.length; off += max) out.push(buf.subarray(off, off + max).toString('base64'));
  return out;
}

// ── Multi-table dump (one snapshot) ───────────────────────────────────
// sqlite3 -json prints one JSON array per SELECT (nothing for zero rows),
// each row on its own line. dumpTables() interleaves the table SELECTs with
// marker SELECTs — `SELECT '<nonce> TABLE <name>' AS m;` → the single line
// [{"m":"<nonce> TABLE <name>"}] — and ends with a '<nonce> END' marker. The
// nonce is random per call, so no row value can forge a marker, and a
// missing END marker means the output was cut short (never "fewer rows").
// Exported for the unit test.
function dumpMarker(nonce, what) {
  return `[{"m":"${nonce} ${what}"}]`;
}
function splitTableDump(stdout, nonce) {
  const tables = {};
  let cur = null, buf = [], complete = false;
  const flush = () => {
    if (cur === null) return;
    const text = buf.join('\n').trim();
    let rows = [];
    if (text) {
      try { rows = JSON.parse(text); }
      catch (e) { throw new Error(`Could not parse the dump of table "${cur}" as JSON: ${text.slice(0, 120)}`); }
      if (!Array.isArray(rows)) throw new Error(`Unexpected dump shape for table "${cur}".`);
    }
    tables[cur] = rows;
  };
  const tableRe = new RegExp('^\\[\\{"m":"' + nonce + ' TABLE (.+)"\\}\\]$');
  const endLine = dumpMarker(nonce, 'END');
  for (const raw of String(stdout || '').split('\n')) {
    const line = raw.replace(/\r$/, '');
    const m = tableRe.exec(line);
    if (m) { flush(); cur = m[1]; buf = []; continue; }
    if (line === endLine) { flush(); cur = null; buf = []; complete = true; break; }
    if (cur !== null) buf.push(line);
  }
  if (!complete) throw new Error('The remote SQLite dump ended early (no END marker) — the output was truncated or sqlite3 stopped before COMMIT.');
  return tables;
}

function init(appConfig, sqliteCfg) {
  const cfg = sqliteCfg || {};

  function accessor() {
    return webAppAccess.createAccessorFromConfig(appConfig);
  }

  // DB file path ON THE WEB APP HOST. Absolute paths pass through;
  // blank or relative paths resolve against the Web App directory.
  function dbFile() {
    const a = accessor();
    const fname = (cfg.filename || '').trim() || 'mmoa_web_app.db';
    if (fname.startsWith('/')) return fname;
    const base = String(a.appPath || '').replace(/\/+$/, '');
    if (!base) {
      throw new Error('No Web App directory path is configured (Settings → Web App), so the relative SQLite path cannot be resolved.');
    }
    return `${base}/${fname}`;
  }

  // Run `sqlite3` on the remote host with the given argv statements (each
  // may be SQL or a dot-command), guarded so a missing DB file is an error
  // instead of sqlite3 silently creating an empty database.
  // `else` branch shared by every sqlite3 invocation (message shell-quoted).
  function guardMissing(file, body) {
    return `if [ -f ${shq(file)} ]; then ${body}; else echo ${shq('SQLite file not found on the Web App host: ' + file)} >&2; exit 42; fi`;
  }

  async function execRaw(statements, opts) {
    const a = accessor();
    const file = dbFile();
    const flags = `-batch ${opts && opts.bail ? '-bail ' : ''}${opts && opts.json ? '-json ' : ''}-cmd ".timeout 5000"`;
    const argv = statements.map(shq).join(' ');
    const run = `sqlite3 ${flags} ${shq(file)} ${argv}`;
    let cmd, tmp = null;
    if (a.mode === 'ec2') {
      // SSM keeps only the first ~24 KB of stdout: write the output to a
      // temp file; echo it inline when small (one round trip, as before),
      // otherwise hand back a marker and read the file in pieces.
      tmp = `${file}.console-out.${tmpSuffix()}.tmp`;
      cmd = guardMissing(file,
        `${run} > ${shq(tmp)}; rc=$?; sz=$(wc -c < ${shq(tmp)} | tr -d ' '); ` +
        `if [ "$rc" -ne 0 ] || [ "$sz" -lt ${MAX_INLINE_OUTPUT} ]; then cat ${shq(tmp)}; rm -f ${shq(tmp)}; exit $rc; fi; echo "__RS_BIG__ $sz"`);
    } else {
      cmd = guardMissing(file, run);
    }
    const rmTmp = async () => { if (tmp) { try { await a.runCommand(`rm -f ${shq(tmp)}`, { timeoutMs: 30000 }); } catch (e) { /* best effort */ } } };
    let r;
    try { r = await a.runCommand(cmd, { timeoutMs: (opts && opts.timeoutMs) || 60000 }); }
    catch (e) { await rmTmp(); throw e; }
    if (r.timedOut) { await rmTmp(); throw new Error('Remote SQLite query timed out (the command may still be running on the host).'); }
    if (r.code !== 0) {
      const msg = (r.stderr || '').trim() || (r.stdout || '').trim() || `sqlite3 exited with code ${r.code}`;
      throw new Error(`Remote SQLite error: ${msg}`);
    }
    const out = r.stdout || '';
    const big = tmp && /^__RS_BIG__ (\d+)\s*$/.exec(out);
    if (big) {
      try { return await a.readFileChunked(tmp, { encoding: 'utf8', timeoutMs: (opts && opts.timeoutMs) || 60000 }); }
      finally { await rmTmp(); }
    }
    if (r.truncated) throw new Error('Result too large for AWS SSM (output truncated at ~24 KB) — use a smaller page size.');
    return out;
  }

  function parseRows(stdout) {
    const t = (stdout || '').trim();
    if (!t) return []; // sqlite3 -json prints nothing for zero rows
    try {
      const rows = JSON.parse(t);
      return Array.isArray(rows) ? rows : [];
    } catch (e) {
      throw new Error('Could not parse remote SQLite output as JSON: ' + t.slice(0, 200));
    }
  }

  async function allAsync(sql, params) {
    return parseRows(await execRaw([terminate(bindSql(sql, params))], { json: true, bail: true }));
  }

  async function getAsync(sql, params) {
    const rows = await allAsync(sql, params);
    return rows[0];
  }

  async function runAsync(sql, params) {
    // The write emits no rows, so the trailing SELECT is the only JSON output.
    const out = await execRaw([
      terminate(bindSql(sql, params)),
      'SELECT last_insert_rowid() AS lastID, changes() AS changes;'
    ], { json: true, bail: true });
    const row = parseRows(out)[0] || {};
    return { lastID: row.lastID, changes: row.changes };
  }

  // One snapshot of every named table (names MUST come from the catalog —
  // helpers/dbSchema.listTables — they are quoted as identifiers here).
  // BEGIN … COMMIT in one sqlite3 process: the web app's writes between
  // tables can't leak in. Output goes through execRaw's large-output path
  // (temp file + readFileChunked on EC2). Returns { [table]: rows }.
  async function dumpTables(names) {
    const nonce = 'DUMP' + crypto.randomBytes(8).toString('hex');
    const stmts = ['BEGIN;'];
    for (const t of names) {
      const q = '`' + String(t).replace(/`/g, '``') + '`';
      stmts.push(`SELECT '${nonce} TABLE ${String(t).replace(/'/g, "''")}' AS m;`);
      stmts.push(`SELECT * FROM ${q};`);
    }
    stmts.push('COMMIT;', `SELECT '${nonce} END' AS m;`);
    const out = await execRaw(stmts, { json: true, bail: true, timeoutMs: 600000 });
    return splitTableDump(out, nonce);
  }

  // Flush a queued transaction atomically. Small scripts go inline; large
  // ones (e.g. a database restore) are chunk-appended to a remote temp file
  // and executed with `sqlite3 < file` — still ONE sqlite3 run, so BEGIN…
  // COMMIT stays atomic and -bail aborts (implicit rollback) on any error.
  async function flushTransaction(stmts) {
    const script = ['BEGIN;', ...stmts.map(terminate), 'COMMIT;'];
    const totalLen = script.reduce((n, s) => n + s.length, 0);
    if (totalLen <= MAX_INLINE_SQL) {
      await execRaw(script, { bail: true, timeoutMs: 120000 });
      return;
    }
    const a = accessor();
    const file = dbFile();
    const tmp = `${file}.console-tx.${tmpSuffix()}.sql`;
    const text = script.join('\n') + '\n';
    try {
      const pieces = chunkForUpload(text, MAX_INLINE_SQL);
      for (let i = 0; i < pieces.length; i++) {
        const redir = i === 0 ? '>' : '>>';
        const r = await a.runCommand(`printf '%s' ${shq(pieces[i])} | base64 -d ${redir} ${shq(tmp)}`, { timeoutMs: 60000 });
        if (r.code !== 0) throw new Error(`Could not stage transaction SQL on the host: ${(r.stderr || '').trim() || 'exit ' + r.code}`);
      }
      const r = await a.runCommand(
        guardMissing(file, `sqlite3 -batch -bail -cmd ".timeout 5000" ${shq(file)} < ${shq(tmp)}`),
        { timeoutMs: 600000 }
      );
      if (r.timedOut) throw new Error('Remote SQLite transaction timed out (it may still be running on the host).');
      if (r.code !== 0) {
        throw new Error(`Remote SQLite transaction failed (rolled back): ${(r.stderr || '').trim() || 'exit ' + r.code}`);
      }
    } finally {
      try { await a.runCommand(`rm -f ${shq(tmp)}`, { timeoutMs: 30000 }); } catch (e) { /* best effort */ }
    }
  }

  const cb = (promise, done) => {
    promise.then(v => done && done(null, v), err => done && done(err));
  };

  return {
    engine: 'sqlite',
    remote: true,
    raw: null,
    // Reachability is unknown until the first query; classify then, like MySQL.
    available: true,
    statusMessage: `SQLite on the Web App host (${webAppAccess.getMode(appConfig)}) — ${(cfg.filename || 'mmoa_web_app.db')}`,

    get(sql, params, done) {
      if (typeof params === 'function') { done = params; params = []; }
      cb(getAsync(sql, params), done);
    },
    all(sql, params, done) {
      if (typeof params === 'function') { done = params; params = []; }
      cb(allAsync(sql, params), done);
    },
    run(sql, params, done) {
      if (typeof params === 'function') { done = params; params = []; }
      cb(runAsync(sql, params), done);
    },
    getAsync, allAsync, runAsync, dumpTables,

    // `opts` (database.js's { snapshot } for read transactions) is accepted
    // for interface parity; reads inside a transaction are not supported
    // here — use dumpTables() for a consistent multi-table read.
    async transaction(fn, opts) { // eslint-disable-line no-unused-vars
      const stmts = [];
      const tx = {
        engine: 'sqlite',
        remote: true,
        runAsync: async (sql, params) => {
          stmts.push(bindSql(sql, params));
          // lastID/changes aren't knowable until the flush; no caller uses them.
          return { lastID: null, changes: null };
        },
        getAsync: async () => { throw new Error('Reads inside a transaction are not supported when the SQLite database is on a remote Web App host.'); },
        allAsync: async () => { throw new Error('Reads inside a transaction are not supported when the SQLite database is on a remote Web App host.'); }
      };
      const result = await fn(tx);
      if (stmts.length) await flushTransaction(stmts);
      return result;
    }
  };
}

module.exports = { init, bindSql, sqlLit, chunkForUpload, splitTableDump, dumpMarker, MAX_INLINE_SQL };

