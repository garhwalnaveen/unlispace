import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { bounded, copyAndSync, generateFixture, hashFile, stressBytes } from './stress.mjs';

test('native stress requires an explicit supported byte count', () => {
  assert.equal(stressBytes(undefined), null);
  assert.equal(stressBytes(''), null);
  assert.equal(stressBytes('50000000'), 50_000_000);
  assert.equal(stressBytes('1000000000'), 1_000_000_000);
  for (const value of ['0', '1', '50MB', '50000000x']) assert.throws(() => stressBytes(value));
});

test('streamed fixture, explicit sync/close copy and hashing agree at a partial block boundary', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'orbit-stress-self-test-'));
  try {
    const source = join(temporary, 'source'), target = join(temporary, 'target');
    const size = 4 * 1024 * 1024 + 17;
    const fixture = await generateFixture(source, size);
    const copied = await copyAndSync(source, target);
    const hashed = await hashFile(target);
    assert.equal(fixture.bytes, size);
    assert.equal(copied.bytes, size);
    assert.equal(hashed.bytes, size);
    assert.equal(copied.sha256, fixture.sha256);
    assert.equal(hashed.sha256, fixture.sha256);
    assert.equal((await stat(source)).mode & 0o777, 0o600);
    await assert.rejects(copyAndSync(source, target), /EEXIST/);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test('outer deadline can fail a command whose kernel cleanup has not returned', async () => {
  assert.equal(await bounded(Promise.resolve('ready'), 50, 'late'), 'ready');
  await assert.rejects(bounded(new Promise(() => {}), 10, 'kernel I/O deadline'), /kernel I\/O deadline/);
});
