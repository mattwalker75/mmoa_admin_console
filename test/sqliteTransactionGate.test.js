// test/sqliteTransactionGate.test.js — the console's local SQLite wrapper
// serializes transactions and holds other statements until the open one
// finishes (one shared connection). Before the gate, a console save during
// a Full Restore failed with "cannot start a transaction within a
// transaction", and a plain write landed inside the restore's transaction
// and vanished when it rolled back.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sqlite3 = require('sqlite3');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mmoa-console-gate-'));
const file = path.join(tmp, 'g.db');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let db;

test.before(async () => {
  await new Promise((res, rej) => { const d = new sqlite3.Database(file, (e) => e ? rej(e) : d.run('CREATE TABLE t (v TEXT)', (e2) => e2 ? rej(e2) : d.close(res))); });
  db = require('../db/database').init({ webApp: { mode: 'local', local: { appPath: tmp } }, database: { engine: 'sqlite', sqlite: { filename: file } } });
  await sleep(50);
  assert.equal(db.engine, 'sqlite', db.statusMessage);
});
test.after(async () => { await new Promise(r => db.raw.close(r)); fs.rmSync(tmp, { recursive: true, force: true }); });

test('a write issued during a transaction that rolls back is kept, not rolled back', async () => {
  let started; const inBody = new Promise(r => { started = r; });
  const t = db.transaction(async (tx) => {
    await tx.runAsync("INSERT INTO t VALUES ('inside')");
    started(); await sleep(150);
    throw new Error('boom');
  }).catch(e => e.message);
  await inBody;
  const outside = db.runAsync("INSERT INTO t VALUES ('outside')"); // must wait, not join the tx
  assert.equal(await t, 'boom');
  await outside;
  const rows = (await db.allAsync('SELECT v FROM t ORDER BY v')).map(r => r.v);
  assert.deepEqual(rows, ['outside']);
});

test('two overlapping transactions run one after the other (no nested BEGIN error)', async () => {
  await db.runAsync('DELETE FROM t');
  const a = db.transaction(async (tx) => { await tx.runAsync("INSERT INTO t VALUES ('a1')"); await sleep(80); await tx.runAsync("INSERT INTO t VALUES ('a2')"); });
  const b = db.transaction(async (tx) => { await tx.runAsync("INSERT INTO t VALUES ('b1')"); });
  await Promise.all([a, b]);
  const rows = (await db.allAsync('SELECT v FROM t ORDER BY rowid')).map(r => r.v);
  assert.deepEqual(rows, ['a1', 'a2', 'b1']);
});

test('a stray db.* call inside a transaction body runs inside it instead of deadlocking', async () => {
  await db.runAsync('DELETE FROM t');
  await db.transaction(async (tx) => { await tx.runAsync("INSERT INTO t VALUES ('x')"); await db.runAsync("INSERT INTO t VALUES ('y')"); });
  assert.equal((await db.getAsync('SELECT COUNT(*) AS c FROM t')).c, 2);
});
