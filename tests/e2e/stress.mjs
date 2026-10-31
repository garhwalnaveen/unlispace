import assert from 'node:assert/strict';
import { createHash, randomFillSync } from 'node:crypto';
import { mkdtemp, open, readdir, realpath, rm, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const worker = fileURLToPath(import.meta.url);
const blockBytes = 4 * 1024 * 1024;

export function stressBytes(value) {
  if (value === undefined || value === '') return null;
  assert(['50000000', '1000000000'].includes(value), 'E2E_STRESS_BYTES must be 50000000 or 1000000000');
  return Number(value);
}

export async function bounded(promise, milliseconds, message) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

async function writeAll(file, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await file.write(bytes, offset, bytes.length - offset);
    assert(bytesWritten > 0, 'native write made no progress');
    offset += bytesWritten;
  }
}

// All payload I/O runs in a bounded subprocess: a blocked kernel mount must not strand the harness.
export async function generateFixture(path, size) {
  const file = await open(path, 'wx', 0o600);
  const hash = createHash('sha256');
  const bytes = Buffer.allocUnsafe(Math.min(blockBytes, size));
  let written = 0;
  try {
    while (written < size) {
      const chunk = bytes.subarray(0, Math.min(bytes.length, size - written));
      randomFillSync(chunk);
      await writeAll(file, chunk);
      hash.update(chunk);
      written += chunk.length;
    }
    await file.sync();
  } finally { await file.close(); }
  return { bytes: written, sha256: hash.digest('hex') };
}

export async function copyAndSync(source, target) {
  const input = await open(source, 'r');
  let output;
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(blockBytes);
  let bytes = 0, syncMs, closeMs, phase = "open target";
  const started = performance.now();
  try {
    output = await open(target, 'wx', 0o600);
    phase = "read input/write target";
    while (true) {
      const { bytesRead } = await input.read(buffer, 0, buffer.length);
      if (!bytesRead) break;
      const chunk = buffer.subarray(0, bytesRead);
      await writeAll(output, chunk);
      hash.update(chunk);
      bytes += bytesRead;
    }
    phase = "fsync target";
    const syncing = performance.now();
    await output.sync();
    syncMs = performance.now() - syncing;
    const closing = performance.now();
    // CLOSE failures are a test failure even when publication later succeeds.
    const closingFile = output; output = undefined;
    phase = "close target";
    await closingFile.close();
    closeMs = performance.now() - closing;
  } catch (error) {
    error.message = `${phase}; ${bytes} bytes; elapsed ${((performance.now()-started)/1000).toFixed(2)} s: ${error.message}`;
    throw error;
  } finally {
    try { if (output) await output.close(); } finally {
      try { await input.close(); } catch (error) { error.message = `close local input: ${error.message}`; throw error; }
    }
  }
  return { bytes, sha256: hash.digest('hex'), totalMs: performance.now() - started, syncMs, closeMs };
}

export async function hashFile(path) {
  const file = await open(path, 'r');
  const buffer = Buffer.allocUnsafe(blockBytes);
  const hash = createHash('sha256');
  let bytes = 0;
  const started = performance.now();
  try {
    while (true) {
      const { bytesRead } = await file.read(buffer, 0, buffer.length);
      if (!bytesRead) break;
      bytes += bytesRead;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally { await file.close(); }
  return { bytes, sha256: hash.digest('hex'), totalMs: performance.now() - started };
}

export async function nativeStressChecks(h) {
  const size = stressBytes(process.env.E2E_STRESS_BYTES);
  if (size === null) { console.log('Native stress phase disabled (E2E_STRESS_BYTES=50000000 or 1000000000 enables it)'); return; }
  const { work, drive, control, check, native, smbMountpoint, cli, independentToken, until } = h;
  const base = await realpath(work);
  assert(/^\/private\/tmp\/unlispace-e2e\.|^\/tmp\/unlispace-e2e\./.test(base), 'stress work must be an owned E2E directory');
  assert(control && smbMountpoint && independentToken, 'stress requires the isolated authenticated SMB phase');
  const mount = resolve(smbMountpoint);
  assert(mount.startsWith(join(base, 'smb-state/mnt') + '/'), 'stress mount is outside the isolated daemon state');
  const temporary = await mkdtemp(join(base, 'native-stress-'));
  const source = join(temporary, 'source.bin'), download = join(temporary, 'download.bin');
  const name = `native-stress-${size}-${temporary.split('/').at(-1)}.bin`;
  const target = join(mount, name);
  let expected, written, published = false;
  const same = result => {
    assert.equal(result.bytes, size, 'stress byte count differs');
    assert.equal(result.sha256, expected.sha256, 'stress SHA-256 differs');
  };
  const run = async (operation, args, timeout = 180000) => JSON.parse(await bounded(
    native(process.execPath, [worker, '--worker', operation, ...args], timeout - 4000),
    timeout, `stress ${operation} exceeded ${timeout / 1000} s (cleanup will detach the owned mount)`,
  ));
  const drained = async () => {
    const uploads = await control.call('uploads', {}, 5000);
    const state = await control.call('status', {}, 5000);
    return uploads.pending.length === 0 && state.pendingOps === 0;
  };
  try {
    await check(`smb stress ${size} B native write + fsync + close`, async () => {
      expected = await run('generate', [source, String(size)]);
      assert.equal(expected.bytes, size);
      written = await run('copy', [source, target]);
      same(written);
      return `${size} random bytes; local accept ${(written.totalMs / 1000).toFixed(2)} s; fsync ${(written.syncMs / 1000).toFixed(2)} s; close ${(written.closeMs / 1000).toFixed(2)} s`;
    });
    await check(`smb stress ${size} B publication + independent CLI SHA-256`, async () => {
      assert(expected, 'fixture generation must succeed first');
      const started = performance.now();
      await until(drained, 300000, 'stress journal did not drain within 300 s');
      const drainedMs = performance.now() - started;
      // Regression: our own commit echoing back through the drive watch used to make the file
      // briefly ENOENT right after the queue drained. Read it through the same mount, no remount.
      same(await run('hash', [target], 300000));
      const result = await bounded(cli(['get', drive, name, download], { token: independentToken, timeout: 296000 }),
        300000, 'independent stress download exceeded 300 s');
      assert.equal(result.code, 0, 'independent stress download failed');
      same(await run('hash', [download]));
      published = true;
      return `journal empty; independent length and SHA-256 match; drain ${(drainedMs / 1000).toFixed(1)} s; verification ${(performance.now() - started) / 1000 | 0} s${written ? "" : "; native close failed separately"}`;
    });
    await check(`smb stress ${size} B cold remount + native SHA-256`, async () => {
      assert(published, 'independent publication verification must succeed first');
      await until(drained, 300000, 'stress journal must drain before cold remount');
      await control.call('drive.unmount', { driveId: drive }, 35000);
      const cache = join(base, 'smb-state/cache');
      assert.equal(await realpath(cache), cache, 'isolated cache must not be a symlink');
      for (const entry of await readdir(cache, { withFileTypes: true })) {
        if (/^[a-f0-9]{64}$/.test(entry.name)) {
          assert(entry.isFile(), 'cache shard must be a regular file');
          await unlink(join(cache, entry.name));
        }
      }
      assert(!(await readdir(cache)).some(entry => /^[a-f0-9]{64}$/.test(entry)), 'isolated cache still contains shards');
      await control.call('drive.mount', { driveId: drive, mountpoint: mount }, 35000);
      const mounted = (await control.call('drives.list')).drives.find(d => d.driveId === drive);
      assert.equal(mounted?.mountState, 'mounted');
      assert.equal(resolve(mounted.mountPath), mount, 'stress remounted a different path');
      const result = await run('hash', [target], 300000);
      same(result);
      return `empty isolated disk cache + new VFS/kernel mount; ${size} bytes/SHA-256 match; native read ${(result.totalMs / 1000).toFixed(2)} s`;
    });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[2] === '--worker' && resolve(process.argv[1]) === worker) {
  try {
    const [operation, first, second] = process.argv.slice(3);
    let result;
    if (operation === 'generate') {
      const size = Number(second);
      assert(Number.isSafeInteger(size) && size > 0 && size <= 1_000_000_000, 'invalid fixture size');
      result = await generateFixture(first, size);
    } else if (operation === 'copy') result = await copyAndSync(first, second);
    else { assert.equal(operation, 'hash'); result = await hashFile(first); }
    console.log(JSON.stringify(result));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
