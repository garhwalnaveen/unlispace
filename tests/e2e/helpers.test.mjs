import assert from 'node:assert/strict';
import test from 'node:test';
import { otpFromLog, uploadResult, watchHas, fixture } from './helpers.mjs';

test('OTP parser supports current console and historical Miniflare output without mixing users', () => {
  const email = 'e2e+a.1@example.com';
  assert.equal(otpFromLog(`[email:dev] to=${email} subject=Your Unlispace code: 123456\nYour Unlispace sign-in code is 123456.\n`, email), '123456');
  assert.equal(otpFromLog(`To: ${email}\nYour code: 654321\n`, email), '654321');
  assert.equal(otpFromLog('[email:dev] to=other@example.com subject=code: 123456\n', email), undefined);
  assert.equal(otpFromLog(`[email:dev] to=${email}.invalid subject=code: 123456\n`, email), undefined);
  assert.equal(otpFromLog(`[email:dev] to=${email} subject=waiting\n[email:dev] to=other@example.com subject=code: 123456\n`, email), undefined);
});

test('CLI upload metrics require both version and actual transfer counts', () => {
  assert.deepEqual(uploadResult('f.bin  8.0 MiB  version v_one  seq 2  (1 of 4 shards uploaded, 1.0 MiB sent, 0.1s)'), { version: 'v_one', seq: 2, uploaded: 1, unique: 4 });
  assert.throws(() => uploadResult('error: 1 of 4 shards uploaded'));
});

test('watch requires an exact path, operation, and version', () => {
  assert(watchHas('12  put      watched.bin  v_one\n', 'watched.bin', 'v_one'));
  assert(!watchHas('12  put      watched.bin  v_other\n', 'watched.bin', 'v_one'));
  assert(!watchHas('12  put      prefix-watched.bin  v_one\n', 'watched.bin', 'v_one'));
});

test('fixture is reproducible and edit changes exactly the last 4 KiB', () => {
  const original = fixture();
  const edited = Buffer.from(original);
  for (let i = edited.length - 4096; i < edited.length; i++) edited[i] ^= 255;
  assert.equal(original.length, 8 * 1024 * 1024);
  assert.deepEqual(original, fixture());
  assert.deepEqual(original.subarray(0, -4096), edited.subarray(0, -4096));
  assert.equal(original.reduce((n, byte, i) => n + (byte !== edited[i]), 0), 4096);
});
