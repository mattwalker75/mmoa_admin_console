// test/remoteSqliteChunks.test.js — db/remoteSqlite.js splits a large
// transaction script into base64 pieces that are appended to a temp file on
// the Web App host. The split must happen on UTF-8 BYTES: slicing the JS
// string (UTF-16 units) would cut an emoji in half and encode each half as
// U+FFFD, corrupting the SQL. Run with `node --test test/`.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { chunkForUpload, MAX_INLINE_SQL } = require('../db/remoteSqlite');

// What the host ends up with: every piece base64-decoded and appended.
function reassemble(pieces) {
  return Buffer.concat(pieces.map(p => Buffer.from(p, 'base64')));
}

test('an emoji straddling a chunk boundary survives the round trip', () => {
  // 'ab🎉cd' is 8 UTF-8 bytes: a b F0 9F 8E 89 c d. A 4-byte limit splits
  // the emoji's bytes 2 + 2 across two pieces.
  const text = 'ab🎉cd';
  const pieces = chunkForUpload(text, 4);
  assert.equal(pieces.length, 2);
  assert.equal(reassemble(pieces).toString('utf8'), text);
  // The old String.slice approach would have produced replacement chars.
  const broken = Buffer.concat([Buffer.from(text.slice(0, 3), 'utf8'), Buffer.from(text.slice(3), 'utf8')]).toString('utf8');
  assert.notEqual(broken, text);
});

test('a realistic SQL script with emoji at the default boundary is byte-identical', () => {
  // Build a script whose MAX_INLINE_SQL byte boundary lands inside an emoji.
  const emoji = '🎉';
  let head = '';
  while (Buffer.byteLength(head + emoji, 'utf8') <= MAX_INLINE_SQL) head += 'x';
  // head is MAX_INLINE_SQL-3 .. MAX_INLINE_SQL bytes; trim so the emoji starts 2 bytes before the boundary.
  head = head.slice(0, MAX_INLINE_SQL - 2);
  const text = `BEGIN;\nINSERT INTO t (c) VALUES ('${head}${emoji}tail — ünïcödé');\nCOMMIT;\n`;
  const pieces = chunkForUpload(text, MAX_INLINE_SQL);
  assert.ok(pieces.length >= 2);
  for (const p of pieces) assert.ok(Buffer.from(p, 'base64').length <= MAX_INLINE_SQL);
  assert.deepEqual(reassemble(pieces), Buffer.from(text, 'utf8'));
});

test('every piece is at most maxBytes and nothing is lost or duplicated', () => {
  const text = '😀'.repeat(1000) + 'plain ascii' + 'é'.repeat(500);
  for (const max of [1, 3, 7, 100, 4096]) {
    const pieces = chunkForUpload(text, max);
    for (const p of pieces) assert.ok(Buffer.from(p, 'base64').length <= max, `piece over ${max} bytes`);
    assert.equal(reassemble(pieces).toString('utf8'), text);
  }
});

test('empty input yields no pieces', () => {
  assert.deepEqual(chunkForUpload('', 100), []);
});
