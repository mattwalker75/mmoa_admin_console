// db/database.js — dual-engine MySQL/SQLite abstraction with offline fallback.
//
// The admin console MUST be able to start with no database configured at
// all, or with a configured database that's currently unreachable. So this
// module is defensive in three ways:
//
//   1. If config.database.engine is missing/empty/'none', we skip
//      connecting entirely and return a "dead DB" stub whose queries all
//      reject with a clear error. Routes that wrap queries in safeGet /
//      safeAll show empty data + a "Database unavailable" banner.
//
//   2. SQLite's Database constructor opens asynchronously and signals
//      failures via an 'error' event. We attach a handler immediately so
//      a missing/unreadable file doesn't bring down the process. Queries
//      on a broken handle still error in their callbacks — and we catch
//      those — so the app stays up.
//
//   3. MySQL pool creation is already lazy (no connection until first
//      query). We wrap pool creation in try/catch in case the config
//      itself is malformed.

const fs = require('fs');
const path = require('path');
const webAppAccess = require('../helpers/webAppAccess');
const remoteSqlite = require('./remoteSqlite');

function makeDeadDb(engine, initErr, label) {
  const err = initErr || new Error('Database is not configured.');
  function failCb(...args) {
    const cb = args[args.length - 1];
    if (typeof cb === 'function') cb(err);
  }
  function failPromise() { return Promise.reject(err); }
  return {
    engine,
    raw: null,
    available: false,
    statusMessage: label || err.message,
    get: failCb, all: failCb, run: failCb,
    getAsync: failPromise, allAsync: failPromise, runAsync: failPromise,
    async transaction() { throw err; }
  };
}

function initSqlite(cfg) {
  let sqlite3;
  try {
    sqlite3 = require('sqlite3');
  } catch (err) {
    console.warn('[db] sqlite3 driver could not be loaded:', err.message);
    return makeDeadDb('sqlite', err, 'sqlite3 driver not installed');
  }

  // Absolute paths come straight through; relative paths are resolved
  // against the repo root. `path.join(__dirname, '..', absolutePath)`
  // would *concatenate* on POSIX rather than reset, producing a path
  // like `<repo>/Users/matt/.../mmoa_web_app.db` that doesn't exist.
  const fname = cfg.filename || '../mmoa_web_app/mmoa_web_app.db';
  const dbFile = path.isAbsolute(fname) ? fname : path.resolve(path.join(__dirname, '..', fname));

  // A missing file means the web app hasn't been set up (or the path is
  // wrong). Don't open it at all: sqlite3 would either CREATE an empty file
  // (default mode — see below) or, in read-write-only mode, leave a handle
  // whose queued queries never call back. Run offline instead; a restart
  // after the web app has created its database picks it up.
  if (!fs.existsSync(dbFile)) {
    console.warn(`[db] SQLite file does not exist: ${dbFile}`);
    console.warn(`[db] The admin console can run without it — pages that need data will show "Database unavailable."`);
    return makeDeadDb('sqlite',
      new Error(`SQLite file not found at ${dbFile} — start the web app once (or run its SETUP_SQLLITE_DB.sh), check the path under Settings → Web App, then restart this console`),
      `SQLite file not found at ${dbFile}`);
  }

  // Open READ-WRITE but never CREATE. The sqlite3 default (OPEN_CREATE)
  // would silently make an empty mmoa_web_app.db when the console boots
  // before the web app has ever run — and the web app only bootstraps its
  // schema onto a FRESH (absent) file, so that empty file would leave it
  // with no tables. A missing file stays missing; queries fail and pages
  // show the "Database unavailable" banner instead.
  let sqliteDb;
  try {
    sqliteDb = new sqlite3.Database(dbFile, sqlite3.OPEN_READWRITE);
  } catch (err) {
    console.warn('[db] SQLite open failed synchronously:', err.message);
    return makeDeadDb('sqlite', err, `SQLite file not openable: ${dbFile}`);
  }

  // Attach an error handler BEFORE any other call. Without this, sqlite3
  // emits an 'error' event on broken opens that Node treats as unhandled
  // and the process exits.
  // If the open itself fails (e.g. permissions), remember why so every
  // wrapper below fails fast with that error instead of handing the query to
  // a handle that will never answer.
  let openErr = null;
  sqliteDb.on('error', (err) => {
    console.warn('[db] SQLite error:', err.message);
    if (!sqliteDb.open) openErr = err;
  });

  // Best-effort PRAGMA. Errors are logged, not thrown — a missing/broken
  // DB file would fail here, and we want to keep going.
  sqliteDb.run('PRAGMA foreign_keys = ON', (err) => {
    if (err) console.warn('[db] PRAGMA foreign_keys failed:', err.message);
  });

  // No schema migrations here: the schema belongs to mmoa_web_app (its
  // setup_sqlite_db.sql + boot-time COLUMN_MIGRATIONS / TABLE_MIGRATIONS).
  // The console only reads and writes rows — the Data Browser discovers
  // whatever tables/columns actually exist at request time.

  return {
    engine: 'sqlite',
    raw: sqliteDb,
    available: true,
    statusMessage: 'SQLite OK',

    get(sql, params, cb) {
      if (typeof params === 'function') { cb = params; params = []; }
      if (openErr) return cb && cb(openErr);
      sqliteDb.get(sql, params, cb);
    },
    all(sql, params, cb) {
      if (typeof params === 'function') { cb = params; params = []; }
      if (openErr) return cb && cb(openErr);
      sqliteDb.all(sql, params, cb);
    },
    run(sql, params, cb) {
      if (typeof params === 'function') { cb = params; params = []; }
      if (openErr) return cb && cb(openErr);
      sqliteDb.run(sql, params, function (err) {
        if (cb) cb(err, err ? null : { lastID: this.lastID, changes: this.changes });
      });
    },

    getAsync(sql, params) {
      return new Promise((resolve, reject) => {
        if (openErr) return reject(openErr);
        sqliteDb.get(sql, params || [], (err, row) => err ? reject(err) : resolve(row));
      });
    },
    allAsync(sql, params) {
      return new Promise((resolve, reject) => {
        if (openErr) return reject(openErr);
        sqliteDb.all(sql, params || [], (err, rows) => err ? reject(err) : resolve(rows));
      });
    },
    runAsync(sql, params) {
      return new Promise((resolve, reject) => {
        if (openErr) return reject(openErr);
        sqliteDb.run(sql, params || [], function (err) {
          if (err) reject(err);
          else resolve({ lastID: this.lastID, changes: this.changes });
        });
      });
    },

    async transaction(fn) {
      const tx = this;
      await tx.runAsync('BEGIN');
      try {
        const result = await fn(tx);
        await tx.runAsync('COMMIT');
        return result;
      } catch (err) {
        try { await tx.runAsync('ROLLBACK'); } catch (e) { /* ignore */ }
        throw err;
      }
    }
  };
}

function initMysql(cfg) {
  let mysql;
  try {
    mysql = require('mysql2');
  } catch (err) {
    console.warn('[db] mysql2 driver could not be loaded:', err.message);
    return makeDeadDb('mysql', err, 'mysql2 driver not installed');
  }

  let pool;
  try {
    pool = mysql.createPool({
      host: cfg.host || 'localhost',
      port: cfg.port || 3306,
      user: cfg.user,
      password: cfg.password,
      database: cfg.database,
      connectionLimit: cfg.connectionLimit || 5,
      waitForConnections: cfg.waitForConnections !== false,
      queueLimit: cfg.queueLimit || 100,
      multipleStatements: false,
      // The web app writes JS-computed UTC timestamps into DATETIME columns
      // (and runs its own pool with timezone 'Z'). Return DATETIME /
      // TIMESTAMP values as the raw 'YYYY-MM-DD HH:MM:SS' strings instead of
      // local-time Date objects so every page — and the Data Browser's edit
      // form in particular — shows and round-trips exactly what is stored,
      // identical to the SQLite engine.
      timezone: 'Z',
      dateStrings: true
    });
  } catch (err) {
    console.warn('[db] MySQL pool creation failed:', err.message);
    return makeDeadDb('mysql', err, `MySQL pool failed: ${err.message}`);
  }

  function exec(sql, params, cb) {
    pool.query(sql, params || [], cb);
  }

  return {
    engine: 'mysql',
    raw: pool,
    // We can't know whether MySQL is reachable until first query; treat as
    // available and let safeGet/safeAll classify errors after the fact.
    available: true,
    statusMessage: `MySQL configured (${cfg.host}:${cfg.port}/${cfg.database})`,

    get(sql, params, cb) {
      if (typeof params === 'function') { cb = params; params = []; }
      exec(sql, params, (err, rows) => cb(err, rows && rows[0]));
    },
    all(sql, params, cb) {
      if (typeof params === 'function') { cb = params; params = []; }
      exec(sql, params, (err, rows) => cb(err, rows || []));
    },
    run(sql, params, cb) {
      if (typeof params === 'function') { cb = params; params = []; }
      exec(sql, params, (err, result) => {
        if (cb) cb(err, err ? null : { lastID: result.insertId, changes: result.affectedRows });
      });
    },

    getAsync(sql, params) {
      return new Promise((resolve, reject) => {
        exec(sql, params || [], (err, rows) => err ? reject(err) : resolve(rows && rows[0]));
      });
    },
    allAsync(sql, params) {
      return new Promise((resolve, reject) => {
        exec(sql, params || [], (err, rows) => err ? reject(err) : resolve(rows || []));
      });
    },
    runAsync(sql, params) {
      return new Promise((resolve, reject) => {
        exec(sql, params || [], (err, result) => {
          if (err) reject(err);
          else resolve({ lastID: result.insertId, changes: result.affectedRows });
        });
      });
    },

    async transaction(fn) {
      const conn = await pool.promise().getConnection();
      try {
        await conn.beginTransaction();
        const tx = {
          engine: 'mysql',
          getAsync: async (sql, params) => {
            const [rows] = await conn.query(sql, params || []);
            return rows && rows[0];
          },
          allAsync: async (sql, params) => {
            const [rows] = await conn.query(sql, params || []);
            return rows || [];
          },
          runAsync: async (sql, params) => {
            const [result] = await conn.query(sql, params || []);
            return { lastID: result.insertId, changes: result.affectedRows };
          }
        };
        const result = await fn(tx);
        await conn.commit();
        return result;
      } catch (err) {
        try { await conn.rollback(); } catch (e) { /* ignore */ }
        throw err;
      } finally {
        conn.release();
      }
    }
  };
}

function init(appConfig) {
  const dbCfg = appConfig.database || {};
  const engine = dbCfg.engine;

  // No engine configured → run offline. All DB-touching pages will show a
  // banner pointing the admin to Settings → Web App.
  if (!engine || engine === 'none' || engine === '') {
    console.log('[db] No database configured — running in offline mode. Configure one at Settings → Web App.');
    return makeDeadDb('none', new Error('Database is not configured. Go to Settings → Web App to set it up.'),
      'Database not configured');
  }

  if (engine === 'mysql') {
    console.log(`[db] Using MySQL (${dbCfg.mysql.host}:${dbCfg.mysql.port}/${dbCfg.mysql.database})`);
    try {
      return initMysql(dbCfg.mysql || {});
    } catch (err) {
      console.warn('[db] MySQL init failed, continuing offline:', err.message);
      return makeDeadDb('mysql', err, err.message);
    }
  }

  if (engine === 'sqlite') {
    // The database follows the Web App: when the Web App is
    // remote (ssh / ec2), its SQLite file lives on THAT host, so queries run
    // there through the webAppAccess transport (sqlite3 CLI). Only in
    // local mode do we open the file directly with the sqlite3 driver.
    const waMode = webAppAccess.getMode(appConfig);
    if (waMode !== 'local') {
      const fname = (dbCfg.sqlite && dbCfg.sqlite.filename) || 'mmoa_web_app.db';
      console.log(`[db] Using SQLite on the Web App host via ${waMode} (${fname})`);
      try {
        return remoteSqlite.init(appConfig, dbCfg.sqlite || {});
      } catch (err) {
        console.warn('[db] Remote SQLite init failed, continuing offline:', err.message);
        return makeDeadDb('sqlite', err, err.message);
      }
    }
    console.log(`[db] Using SQLite (${dbCfg.sqlite && dbCfg.sqlite.filename || 'mmoa_web_app.db'})`);
    try {
      return initSqlite(dbCfg.sqlite || {});
    } catch (err) {
      console.warn('[db] SQLite init failed, continuing offline:', err.message);
      return makeDeadDb('sqlite', err, err.message);
    }
  }

  console.warn(`[db] Unknown engine "${engine}" — running offline.`);
  return makeDeadDb('none', new Error(`Unknown engine "${engine}"`), `Unknown engine "${engine}"`);
}

module.exports = { init };
