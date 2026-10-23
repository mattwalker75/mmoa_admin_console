// test/remoteSqliteDump.test.js — db/remoteSqlite.js dumpTables() reads
// every table in ONE sqlite3 -json invocation (BEGIN … COMMIT) and splits
// the output on per-call random marker rows (splitTableDump). The split
// must survive row values that look like markers, zero-row tables, and
// must refuse an output that was cut short. When the sqlite3 CLI is on the
// PATH the real output format is checked too. Run with `node --test test/`.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { splitTableDump, dumpMarker } = require('../db/remoteSqlite');

const NONCE = 'DUMPdeadbeef01234567';

test('splits per-table arrays, keeps zero-row tables, ignores marker-like values', () => {
  const out = [
    dumpMarker(NONCE, 'TABLE users'),
    '[{"user_id":1,"name":"a\\nb"},',
    `{"user_id":2,"name":"${dumpMarker(NONCE, 'TABLE users').replace(/"/g, '\\"')}"}]`,
    dumpMarker(NONCE, 'TABLE empty'),
    dumpMarker(NONCE, 'TABLE t2'),
    '[{"a":1}]',
    dumpMarker(NONCE, 'END')
  ].join('\n');
  const t = splitTableDump(out, NONCE);
  assert.deepEqual(Object.keys(t), ['users', 'empty', 't2']);
  assert.equal(t.users.length, 2);
  assert.equal(t.users[0].name, 'a\nb');
  assert.ok(t.users[1].name.includes('TABLE users'));
  assert.deepEqual(t.empty, []);
  assert.deepEqual(t.t2, [{ a: 1 }]);
});

test('a dump without the END marker (truncated / sqlite3 stopped early) is refused', () => {
  const out = [dumpMarker(NONCE, 'TABLE users'), '[{"user_id":1}]'].join('\n');
  assert.throws(() => splitTableDump(out, NONCE), /ended early/);
});

test('a different nonce never matches (markers are per call)', () => {
  const out = [dumpMarker('OTHER', 'TABLE users'), '[{"user_id":1}]', dumpMarker('OTHER', 'END')].join('\n');
  assert.throws(() => splitTableDump(out, NONCE), /ended early/);
});

test('real sqlite3 -json output of the dump script splits cleanly', (t) => {
  let have = false;
  try { execFileSync('sqlite3', ['-version'], { stdio: 'ignore' }); have = true; } catch (e) { /* no CLI */ }
  if (!have) { t.skip('sqlite3 CLI not on PATH'); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rsdump-'));
  const file = path.join(dir, 't.db');
  try {
    execFileSync('sqlite3', [file, "CREATE TABLE a (id INTEGER PRIMARY KEY, txt TEXT); CREATE TABLE b (id INTEGER PRIMARY KEY); INSERT INTO a (txt) VALUES ('x'), ('multi\nline'), ('" + NONCE + " TABLE a');"]);
    const stmts = ['BEGIN;',
      `SELECT '${NONCE} TABLE a' AS m;`, 'SELECT * FROM `a`;',
      `SELECT '${NONCE} TABLE b' AS m;`, 'SELECT * FROM `b`;',
      'COMMIT;', `SELECT '${NONCE} END' AS m;`];
    const out = execFileSync('sqlite3', ['-batch', '-bail', '-json', file, ...stmts]).toString('utf8');
    const tables = splitTableDump(out, NONCE);
    assert.deepEqual(Object.keys(tables), ['a', 'b']);
    assert.equal(tables.a.length, 3);
    assert.equal(tables.a[1].txt, 'multi\nline');
    assert.equal(tables.a[2].txt, `${NONCE} TABLE a`);
    assert.deepEqual(tables.b, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
