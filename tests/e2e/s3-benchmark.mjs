import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { arch, platform, release } from 'node:os';
import { resolve } from 'node:path';
import { addAbortSignal } from 'node:stream';
import { Agent } from 'node:https';
import { s3Signer } from './s3-sign.mjs';

const require = createRequire(new URL('../../cloud/s3-gateway/package.json', import.meta.url));
const aws = require('@aws-sdk/client-s3');
const { NodeHttpHandler } = require('@smithy/node-http-handler');
const { S3SDKClient } = await import(new URL('../../cloud/s3-gateway/node_modules/@spacefs/s3sdk/dist/index.js', import.meta.url));
const KiB = 1024, MiB = 1024 * KiB;
const REQUEST_DEADLINE_MS = 300000;
const sizes = [4 * KiB, MiB, 32 * MiB, 64 * MiB];
const label = n => n < MiB ? `${n / KiB} KiB` : `${n / MiB} MiB`;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export function requestHandler(timeoutMs = REQUEST_DEADLINE_MS) {
  const handler = new NodeHttpHandler({ connectionTimeout: 15000, requestTimeout: timeoutMs,
    // An explicit agent keeps Expect: 100-continue from waiting out the entire request deadline.
    throwOnRequestTimeout: true, socketTimeout: timeoutMs, httpsAgent: new Agent({ maxSockets: 64, keepAlive: true }) });
  return {
    metadata: handler.metadata,
    async handle(request, options = {}) {
      const deadline = AbortSignal.timeout(timeoutMs);
      const signal = options.abortSignal ? AbortSignal.any([options.abortSignal, deadline]) : deadline;
      const result = await handler.handle(request, { ...options, abortSignal: signal });
      if (result.response.body) addAbortSignal(signal, result.response.body);
      return result;
    },
    destroy() { handler.destroy(); },
  };
}

export function verifyBytes(actual, expected, key) {
  const actualSHA256 = hash(actual), expectedSHA256 = hash(expected);
  if (actual.length !== expected.length || actualSHA256 !== expectedSHA256) {
    const error = new Error(`Content verification failed: ${key}`);
    error.name = 'ContentVerificationError';
    Object.assign(error, { receivedBytes: actual.length, expectedBytes: expected.length, actualSHA256, expectedSHA256 });
    throw error;
  }
}

export function errorDetails(error) {
  const details = { name: error.name, code: error.code, status: error.status ?? error.$metadata?.httpStatusCode, requestId: error.requestId ?? error.$metadata?.requestId };
  if (error.code === 'InvalidArgument' && typeof error.message === 'string') details.message = error.message.slice(0, 512);
  if (error.code === 'InvalidResponse' && /^missing [a-z0-9-]+ header$/i.test(error.message)) details.message = error.message;
  if (error.name === 'ContentVerificationError') {
    for (const field of ['receivedBytes', 'expectedBytes', 'actualSHA256', 'expectedSHA256']) details[field] = error[field];
  }
  if (error.name === 'AssertionError') {
    for (const field of ['actual', 'expected']) {
      const value = error[field];
      if (typeof value === 'number' || (typeof value === 'string' && /^[a-f0-9]{64}$/.test(value))) details[field] = value;
    }
  }
  if (error instanceof AggregateError) details.causes = error.errors.map(errorDetails);
  return details;
}
export const median = values => {
  assert(values.length > 0);
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

export async function cleanupTree(config, prefix, fetcher = fetch) {
  assert(/^orbit-benchmark-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/$/.test(prefix), 'Cleanup requires the exact generated benchmark root');
  const mount = new URL(`/${encodeURIComponent(config.bucket)}?x-uls-mount`, config.endpoint);
  const sign = s3Signer(new URL('../../', import.meta.url).pathname);
  const response = await fetcher(mount, {headers:await sign(mount,{method:'GET',key:config}),signal:AbortSignal.timeout(120000)});
  assert(response.ok, 'Cleanup token request failed');
  const grant = await response.json(), endpoint = new URL(grant.endpoint);
  assert(grant.canWrite && typeof grant.token === 'string' && /^d-[0-9a-z]{26}$/.test(grant.driveId));
  assert.equal(/^d-[0-9a-z]{26}$/.test(config.bucket) ? grant.driveId : grant.alias,config.bucket);
  assert((endpoint.protocol === 'https:' || (endpoint.protocol === 'http:' && ['localhost','127.0.0.1'].includes(endpoint.hostname))) && !endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash);
  const base = new URL(`/v0/drives/${grant.driveId}/`, endpoint);
  const stat = new URL('stat', base); stat.searchParams.set('path',prefix);
  const request = (url, init = {}) => fetcher(url, {...init,headers:{authorization:`Bearer ${grant.token}`,...init.headers},signal:AbortSignal.timeout(120000)});
  const before = await request(stat);
  if (before.status === 404) { assert.equal((await before.json()).error,'no_such_path'); return; }
  assert(before.ok, 'Cleanup stat failed');
  const entry = await before.json();
  assert.equal(entry.type, 'folder');
  const deleted = await request(new URL('commit',base),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({ops:[{op:'delete',path:prefix,ifVersion:entry.versionId}],requestId:randomUUID()})});
  assert(deleted.ok, 'Benchmark tree deletion failed'); await deleted.arrayBuffer();
  const after = await request(stat);
  assert.equal(after.status,404); assert.equal((await after.json()).error,'no_such_path');
}

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
    s3: { maxAttempts: 1, requestHandler: requestHandler() },
    fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(REQUEST_DEADLINE_MS) }),
  });
  const prefix = `orbit-benchmark-${randomUUID()}/`, rows = [];
  const report = { startedAt: new Date().toISOString(), endpoint, bucket, prefix,
    host: { platform: platform(), release: release(), arch: arch(), node: process.version },
    method: { rounds: 2, warmups: 3, samplesPerRound: 8, concurrency: 8, maxSockets: 64, awsMaxAttempts: 1, extension503Retries: 4, requestDeadlineMs: REQUEST_DEADLINE_MS, selectedScenarios: selected.map(row => row.name),
      figure: 'Median of round p50s; fanout rows use individual request latencies',
      cache: 'No client object cache; server caches uncontrolled', verification: 'SHA-256 after timing; streaming digest during timing',
      limitation: 'Reconstructed from the pasted scenario table; original sample count and harness unavailable. Not the original same-bucket experiment.' }, rows };
  const save = () => writeFile(output, JSON.stringify(report, null, 2) + '\n');
  const put = (key, body) => client.putObject(bucket, key, body);
  const get = async key => Buffer.from((await client.getObject(bucket, key)).body);
  const send = command => client.s3.send(command, { abortSignal: AbortSignal.timeout(REQUEST_DEADLINE_MS) });
  async function verify(key, expected) { verifyBytes(await get(key), expected, key); }
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
    const health = await fetch(new URL('/healthz', endpoint), { redirect: 'error', signal: AbortSignal.timeout(15000) });
    if (!health.ok || health.headers.get('x-s3sdk-protocol') !== '1') {
      const error = new Error('The deployed gateway does not advertise the SDK protocol required by this benchmark');
      error.name = 'IncompatibleGateway'; throw error;
    }
    // Refuse the expensive workload immediately if this account cannot publish and retrieve.
    const probe = randomBytes(4 * KiB);
    await put(`${prefix}preflight`, probe); await verify(`${prefix}preflight`, probe);
    report.preflight = 'passed'; await save();
    for (const [index, scenario] of selected.entries()) {
      const base = `${prefix}${index}/`, source = randomBytes(scenario.size), data = randomBytes(4 * KiB);
      const row = { ...scenario, rounds: [], status: 'running', phase: 'setup', fixtureSHA256: hash(source) }; rows.push(row);
      await save();
      let serial = 0;
      const fanout = scenario.kind.startsWith('fanout');
      async function prepare(i) {
        const key = `${base}operation-${serial++}`;
        const { kind, size } = scenario;
        let expected = source, perform, check;
        if (kind === 'get' || kind === 'fanout-get') {
          perform = () => get(`${base}read-${fanout ? i : 0}`);
          check = result => verifyBytes(result, source, `${base}read-${fanout ? i : 0}`);
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
          row.phase = 'warmup';
          await save();
          for (let warm = 0; warm < 3; warm++) {
            const operation = await prepare(warm);
            await operation.check(await operation.perform());
          }
          const samples = [];
          const roundResult = { samplesMs: samples, complete: false };
          row.rounds.push(roundResult);
          const count = scenario.count ?? 8, concurrency = scenario.concurrency ?? 8;
          // Prepare and verify whole waves outside timing, keeping their traffic out of samples.
          for (let start = 0; start < count; start += concurrency) {
            const operations = [], results = [];
            row.phase = 'prepare';
            await save();
            await pool(Math.min(concurrency, count - start), concurrency, async n => { operations[n] = await prepare(start + n); });
            row.phase = 'measure';
            await save();
            await pool(operations.length, concurrency, async n => {
              const measured = await timed(operations[n].perform);
              samples.push(measured.ms); results[n] = measured.result;
            });
            row.phase = 'verify';
            await save();
            await pool(operations.length, concurrency, n => operations[n].check(results[n]));
          }
          Object.assign(roundResult, { p50Ms: median(samples), complete: true });
          await save();
        }
        row.medianMs = median(row.rounds.map(r => r.p50Ms)); row.status = 'passed';
      } catch (error) {
        row.status = 'failed'; row.error = errorDetails(error);
      }
      await save(); console.log(`${index + 1}/${selected.length} ${row.status} ${row.name}${row.medianMs ? `: ${row.medianMs.toFixed(1)} ms` : ''}`);
    }
  } catch (error) {
    report.preflight = 'failed'; report.error = errorDetails(error);
  } finally {
    if (report.error?.name === 'IncompatibleGateway') report.cleanup = 'No benchmark writes attempted';
    else try {
      const uploads = await send(new aws.ListMultipartUploadsCommand({Bucket:bucket,Prefix:prefix}));
      assert(!uploads.IsTruncated, 'Too many incomplete benchmark uploads');
      for (const upload of uploads.Uploads ?? []) {
        assert(upload.Key?.startsWith(prefix) && upload.UploadId);
        await send(new aws.AbortMultipartUploadCommand({Bucket:bucket,Key:upload.Key,UploadId:upload.UploadId}));
      }
      await cleanupTree(config,prefix);
      assert.equal((await send(new aws.ListMultipartUploadsCommand({Bucket:bucket,Prefix:prefix}))).Uploads?.length ?? 0,0);
      report.cleanup = 'Benchmark tree soft-deleted and verified absent; no incomplete multipart uploads; immutable history and retained shards may still consume quota';
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
