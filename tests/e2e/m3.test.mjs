import assert from 'node:assert/strict';
import { test } from 'node:test';
import { patch } from './m3.mjs';

test('S3SP fixture encodes one big-endian edit without changing its bytes', () => {
  const bytes = Buffer.from([0, 255, 17]);
  const encoded = patch(0x100000001, bytes);
  assert.equal(encoded.subarray(0, 8).toString('hex'), '5333535001000000');
  assert.equal(encoded.readUInt32BE(8), 1);
  assert.equal(encoded.readBigUInt64BE(12), 0x100000001n);
  assert.equal(encoded.readBigUInt64BE(20), 3n);
  assert.deepEqual(encoded.subarray(28), bytes);
});
