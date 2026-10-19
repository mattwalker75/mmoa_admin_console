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
//     is NOT enforced here. Callers that delete parent rows (Members →
//     Delete) remove the child rows explicitly.

const webAppAccess = require('../helpers/webAppAccess');

// Single-quote for POSIX sh (same rule as webAppAccess.shQuote).
function shq(s) {
  return `'` + String(s).replace(/'/g, `'\\''`) + `'`;
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
  async function execRaw(statements, opts) {
    const file = dbFile();
    const flags = `-batch ${opts && opts.bail ? '-bail ' : ''}${opts && opts.json ? '-json ' : ''}-cmd ".timeout 5000"`;
    const argv = statements.map(shq).join(' ');
    const cmd = `if [ -f ${shq(file)} ]; then sqlite3 ${flags} ${shq(file)} ${argv}; else echo "SQLite file not found on the Web App host: ${file}" >&2; exit 42; fi`;
    const r = await accessor().runCommand(cmd, { timeoutMs: (opts && opts.timeoutMs) || 60000 });
    if (r.timedOut) throw new Error('Remote SQLite query timed out (the command may still be running on the host).');
    if (r.code !== 0) {
      const msg = (r.stderr || '').trim() || (r.stdout || '').trim() || `sqlite3 exited with code ${r.code}`;
      throw new Error(`Remote SQLite error: ${msg}`);
    }
    return r.stdout || '';
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
    const tmp = file + '.console-tx.sql';
    const text = script.join('\n') + '\n';
    try {
      for (let off = 0, first = true; off < text.length; off += MAX_INLINE_SQL, first = false) {
        const b64 = Buffer.from(text.slice(off, off + MAX_INLINE_SQL), 'utf8').toString('base64');
        const redir = first ? '>' : '>>';
        const r = await a.runCommand(`printf '%s' ${shq(b64)} | base64 -d ${redir} ${shq(tmp)}`, { timeoutMs: 60000 });
        if (r.code !== 0) throw new Error(`Could not stage transaction SQL on the host: ${(r.stderr || '').trim() || 'exit ' + r.code}`);
      }
      const r = await a.runCommand(
        `if [ -f ${shq(file)} ]; then sqlite3 -batch -bail -cmd ".timeout 5000" ${shq(file)} < ${shq(tmp)}; else echo "SQLite file not found on the Web App host: ${file}" >&2; exit 42; fi`,
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
    getAsync, allAsync, runAsync,

    async transaction(fn) {
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

module.exports = { init, bindSql, sqlLit };

