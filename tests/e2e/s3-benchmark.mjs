import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { arch, platform, release } from 'node:os';
import { resolve } from 'node:path';

const require = createRequire(new URL('../../cloud/s3-gateway/package.json', import.meta.url));
const aws = require('@aws-sdk/client-s3');
const { NodeHttpHandler } = require('@smithy/node-http-handler');
const { S3SDKClient } = await import(new URL('../../cloud/s3-gateway/node_modules/@spacefs/s3sdk/dist/index.js', import.meta.url));
const KiB = 1024, MiB = 1024 * KiB;
const sizes = [4 * KiB, MiB, 32 * MiB, 64 * MiB];
const label = n => n < MiB ? `${n / KiB} KiB` : `${n / MiB} MiB`;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const median = values => {
  assert(values.length > 0);
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

export function scenarios(names = []) {
  const rows = [];
  for (const size of sizes) for (const kind of ['get', 'put']) rows.push({ name: `${kind} ${label(size)}`, kind, size });
  for (const size of [4 * KiB, MiB]) rows.push({ name: `overwrite ${label(size)}`, kind: 'overwrite', size });
  for (const [size, part] of [[64 * MiB, 8 * MiB], [256 * MiB, 16 * MiB]]) {
    rows.push({ name: `multipart put ${label(size)} × ${label(part)}`, kind: 'multipart', size, part });
    rows.push({ name: `stream get ${label(size)}`, kind: 'stream', size });
  }
  rows.push({ name: 'range 64 KiB of 64 MiB', kind: 'range', size: 64 * MiB });
  rows.push({ name: 'head', kind: 'head', size: 4 * KiB });
  rows.push({ name: 'list 200 keys', kind: 'list', size: 4 * KiB });
  rows.push({ name: 'rename 64 MiB', kind: 'rename', size: 64 * MiB });
  rows.push({ name: 'move dir 200 × 64 KiB', kind: 'move', size: 64 * KiB });
  for (const [count, size, concurrency] of [[1000, 4 * KiB, 32], [1000, 4 * KiB, 64], [200, 256 * KiB, 32]]) {
    for (const kind of ['get', 'put']) rows.push({ name: `fanout ${kind} ${count} × ${label(size)}, ${concurrency} at once`, kind: `fanout-${kind}`, size, count, concurrency });
  }
  for (const size of sizes.slice(1)) for (const kind of ['append', 'truncate', 'write', 'patch', 'insert-start', 'insert-middle', 'delete-start', 'delete-middle']) {
    const name = kind === 'append' ? `append 4 KiB to ${label(size)}`
      : kind === 'truncate' ? `truncate 4 KiB, end of ${label(size)}`
      : kind === 'write' ? `write at 4 KiB in ${label(size)}`
      : kind === 'patch' ? `patch 16 × 4 KiB in ${label(size)}`
      : `${kind.startsWith('insert') ? 'insert' : 'delete'} 4 KiB, ${kind.endsWith('start') ? 'start' : 'middle'} of ${label(size)}`;
    rows.push({ name, kind, size });
  }
  assert.equal(rows.length, 49);
  assert.equal(new Set(names).size, names.length, 'Scenario names must be unique');
  for (const name of names) assert(rows.some(row => row.name === name), `Unknown scenario: ${name}`);
  return names.length ? rows.filter(row => names.includes(row.name)) : rows;
}

// Settle every worker before cleanup; an early rejection must not leave writes running.
export async function pool(count, concurrency, operation) {
  let next = 0;
  const settled = await Promise.allSettled(Array.from({ length: Math.min(count, concurrency) }, async () => {
    while (next < count) await operation(next++);
  }));
  const failures = settled.filter(r => r.status === 'rejected');
  if (failures.length) throw new AggregateError(failures.map(r => r.reason), 'Benchmark operation failed');
}

export function edited(kind, original, data) {
  const out = Buffer.from(original), middle = Math.floor(out.length / 2);
  if (kind === 'append') return Buffer.concat([out, data]);
  if (kind === 'truncate') return out.subarray(0, out.length - data.length);
  if (kind === 'write') { data.copy(out, 4 * KiB); return out; }
  if (kind === 'patch') {
    for (let i = 0; i < 16; i++) data.copy(out, Math.floor(i * (out.length - data.length) / 15));
    return out;
  }
  const offset = kind.endsWith('start') ? 0 : middle;
  if (kind.startsWith('insert')) return Buffer.concat([out.subarray(0, offset), data, out.subarray(offset)]);
  assert(kind.startsWith('delete'));
  return Buffer.concat([out.subarray(0, offset), out.subarray(offset + data.length)]);
}

async function run(configPath, output, names = []) {
  const selected = scenarios(names);
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  const { endpoint, bucket, accessKeyId, secretAccessKey } = config;
  assert(endpoint && bucket && accessKeyId && secretAccessKey, 'Credentials JSON needs endpoint, bucket, accessKeyId, secretAccessKey');
  const url = new URL(endpoint);
  assert(url.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(url.hostname), 'Use HTTPS for hosted credentials');
  assert(!url.username && !url.password && !url.search && !url.hash);
  const client = new S3SDKClient({ endpoint, accessKeyId, secretAccessKey, region: config.region ?? 'us-east-1',
    s3: { maxAttempts: 1, requestHandler: new NodeHttpHandler({ connectionTimeout: 15000, requestTimeout: 120000, httpsAgent: { maxSockets: 64, keepAlive: true } }) },
    fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(120000) }),
  });
  const prefix = `orbit-benchmark-${randomUUID()}/`, rows = [];
  const report = { startedAt: new Date().toISOString(), endpoint, bucket, prefix,
    host: { platform: platform(), release: release(), arch: arch(), node: process.version },
    method: { rounds: 2, warmups: 3, samplesPerRound: 8, concurrency: 8, maxSockets: 64, retries: 0, selectedScenarios: selected.map(row => row.name),
      figure: 'Median of round p50s; fanout rows use individual request latencies',
      cache: 'No client object cache; server caches uncontrolled', verification: 'SHA-256 after timing; streaming digest during timing',
      limitation: 'Reconstructed from the pasted scenario table; original sample count and harness unavailable. Not the original same-bucket experiment.' }, rows };
  const save = () => writeFile(output, JSON.stringify(report, null, 2) + '\n');
  const put = (key, body) => client.putObject(bucket, key, body);
  const get = async key => Buffer.from((await client.getObject(bucket, key)).body);
  const send = command => client.s3.send(command, { abortSignal: AbortSignal.timeout(120000) });
  async function verify(key, expected) { assert.equal(hash(await get(key)), hash(expected), `SHA-256 mismatch: ${key}`); }
  async function multipart(key, body, partSize) {
    const { UploadId } = await send(new aws.CreateMultipartUploadCommand({ Bucket: bucket, Key: key }));
    assert(UploadId);
    try {
      const parts = [];
      await pool(Math.ceil(body.length / partSize), 8, async i => {
        const { ETag } = await send(new aws.UploadPartCommand({ Bucket: bucket, Key: key, UploadId, PartNumber: i + 1, Body: body.subarray(i * partSize, (i + 1) * partSize) }));
        parts[i] = { PartNumber: i + 1, ETag };
      });
      await send(new aws.CompleteMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId, MultipartUpload: { Parts: parts } }));
    } catch (error) {
      try { await send(new aws.AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId })); }
      catch (abortError) { report.multipartAbortError = abortError.name; }
      throw error;
    }
  }
  async function timed(operation) {
    const start = performance.now(), result = await operation();
    return { ms: performance.now() - start, result };
  }
  try {
    // Refuse the expensive workload immediately if this account cannot publish and retrieve.
    const probe = randomBytes(4 * KiB);
    await put(`${prefix}preflight`, probe); await verify(`${prefix}preflight`, probe);
    report.preflight = 'passed'; await save();
    for (const [index, scenario] of selected.entries()) {
      const row = { ...scenario, rounds: [], status: 'running' }; rows.push(row);
      const base = `${prefix}${index}/`, source = randomBytes(scenario.size), data = randomBytes(4 * KiB);
      let serial = 0;
      const fanout = scenario.kind.startsWith('fanout');
      async function prepare(i) {
        const key = `${base}operation-${serial++}`;
        const { kind, size } = scenario;
        let expected = source, perform, check;
        if (kind === 'get' || kind === 'fanout-get') {
          perform = () => get(`${base}read-${fanout ? i : 0}`);
          check = result => assert.equal(hash(result), hash(source));
        } else if (kind === 'stream') {
          perform = async () => {
            const response = await send(new aws.GetObjectCommand({ Bucket: bucket, Key: `${base}read-0` }));
            const digest = createHash('sha256'); let bytes = 0;
            for await (const chunk of response.Body) { bytes += chunk.length; digest.update(chunk); }
            return { bytes, hash: digest.digest('hex') };
          };
          check = result => assert.deepEqual(result, { bytes: size, hash: hash(source) });
        } else if (kind === 'range') {
          perform = () => client.readRange(bucket, `${base}read-0`, { offset: 32 * MiB, length: 64 * KiB });
          check = result => assert(Buffer.from(result).equals(source.subarray(32 * MiB, 32 * MiB + 64 * KiB)));
        } else if (kind === 'head') {
          perform = () => send(new aws.HeadObjectCommand({ Bucket: bucket, Key: `${base}read-0` }));
          check = result => assert.equal(result.ContentLength, size);
        } else if (kind === 'list') {
          perform = () => client.listObjects(bucket, { prefix: `${base}list/` });
          check = result => assert.deepEqual([...result.keys].sort(), Array.from({ length: 200 }, (_, n) => `${base}list/${n}`).sort());
        } else if (['put', 'overwrite', 'fanout-put', 'multipart'].includes(kind)) {
          expected = randomBytes(size);
          if (kind === 'overwrite') await put(key, source);
          perform = () => kind === 'multipart' ? multipart(key, expected, scenario.part) : put(key, expected);
          check = () => verify(key, expected);
        } else if (kind === 'rename' || kind === 'move') {
          const old = `${key}-old${kind === 'move' ? '/' : ''}`, destination = `${key}-new${kind === 'move' ? '/' : ''}`;
          if (kind === 'move') await pool(200, 8, n => put(`${old}${n}`, source));
          else await put(old, source);
          perform = () => client.rename(bucket, old, destination);
          check = async () => { if (kind === 'move') {
            assert.equal((await client.listObjects(bucket, { prefix: destination })).keys.length, 200);
            await pool(200, 8, n => verify(`${destination}${n}`, source));
            assert.equal((await client.listObjects(bucket, { prefix: old })).keys.length, 0);
          } else {
            await verify(destination, source);
            await assert.rejects(() => get(old), error => error.status === 404);
          } };
        } else {
          await put(key, source); expected = edited(kind, source, data);
          perform = () => {
            if (kind === 'append') return client.writeAt(bucket, key, size, data);
            if (kind === 'truncate') return client.truncate(bucket, key, size - data.length);
            if (kind === 'write') return client.writeAt(bucket, key, 4 * KiB, data);
            if (kind === 'patch') return client.patch(bucket, key, Array.from({ length: 16 }, (_, n) => ({ offset: Math.floor(n * (size - data.length) / 15), data })));
            const offset = kind.endsWith('start') ? 0 : Math.floor(size / 2);
            return kind.startsWith('insert') ? client.insert(bucket, key, offset, data) : client.removeRange(bucket, key, offset, data.length);
          };
          check = () => verify(key, expected);
        }
        return { perform, check };
      }
      try {
        if (['get', 'stream', 'range', 'head', 'fanout-get'].includes(scenario.kind)) {
          if (scenario.size > 64 * MiB) await multipart(`${base}read-0`, source, 16 * MiB);
          else await pool(scenario.count ?? 1, 8, n => put(`${base}read-${n}`, source));
        }
        if (scenario.kind === 'list') await pool(200, 8, n => put(`${base}list/${n}`, source));
        for (let round = 0; round < 2; round++) {
          for (let warm = 0; warm < 3; warm++) {
            const operation = await prepare(warm);
            await operation.check(await operation.perform());
          }
          const samples = [];
          const count = scenario.count ?? 8, concurrency = scenario.concurrency ?? 8;
          // Prepare and verify whole waves outside timing, keeping their traffic out of samples.
          for (let start = 0; start < count; start += concurrency) {
            const operations = [], results = [];
            await pool(Math.min(concurrency, count - start), concurrency, async n => { operations[n] = await prepare(start + n); });
            await pool(operations.length, concurrency, async n => {
              const measured = await timed(operations[n].perform);
              samples.push(measured.ms); results[n] = measured.result;
            });
            await pool(operations.length, concurrency, n => operations[n].check(results[n]));
          }
          row.rounds.push({ p50Ms: median(samples), samplesMs: samples });
          await save();
        }
        row.medianMs = median(row.rounds.map(r => r.p50Ms)); row.status = 'passed';
      } catch (error) {
        row.status = 'failed'; row.error = { name: error.name, code: error.code, status: error.status ?? error.$metadata?.httpStatusCode };
        if (error instanceof AggregateError) row.error.causes = error.errors.map(e => ({ name: e.name, code: e.code, status: e.status ?? e.$metadata?.httpStatusCode }));
      }
      await save(); console.log(`${index + 1}/${selected.length} ${row.status} ${row.name}${row.medianMs ? `: ${row.medianMs.toFixed(1)} ms` : ''}`);
    }
  } catch (error) {
    report.preflight = 'failed'; report.error = { name: error.name, code: error.code, status: error.status ?? error.$metadata?.httpStatusCode };
  } finally {
    try {
      const listing = await client.listObjects(bucket, { prefix });
      assert(listing.keys.every(key => key.startsWith(prefix)));
      await pool(listing.keys.length, 8, i => client.deleteObject(bucket, listing.keys[i]));
      assert.equal((await client.listObjects(bucket, { prefix })).keys.length, 0);
      report.cleanup = 'Live benchmark objects deleted; immutable history and retained shards may still consume quota';
    } catch (error) { report.cleanup = `failed: ${error.name}`; }
    report.finishedAt = new Date().toISOString(); await save(); client.s3.destroy();
  }
  if (rows.length !== selected.length || rows.some(row => row.status !== 'passed') || report.cleanup.startsWith('failed')) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  const [configPath, output, ...names] = process.argv.slice(2);
  assert(configPath && output, 'Usage: node tests/e2e/s3-benchmark.mjs /private/credentials.json /path/results.json [exact scenario names...]');
  await run(configPath, output, names);
}
