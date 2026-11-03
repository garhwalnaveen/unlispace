import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { edited, median, pool, scenarios } from './s3-benchmark.mjs';

test('all 49 supplied scenarios have unique names and the documented sizes', () => {
  const rows = scenarios();
  assert.equal(rows.length, 49);
  assert.equal(new Set(rows.map(row => row.name)).size, 49);
  assert.equal(rows.filter(row => row.kind.startsWith('fanout')).length, 6);
  assert.equal(rows.filter(row => row.kind.includes('insert') || row.kind.includes('delete')).length, 12);
  assert.equal(median([30, 10, 20]), 20);
  assert.equal(median([10, 30]), 20);
});

test('targeted retests select exact names and reject unknown or duplicate cases', () => {
  assert.deepEqual(scenarios(['head', 'stream get 256 MiB']).map(row => row.name), ['stream get 256 MiB', 'head']);
  assert.throws(() => scenarios(['stream get 256 MB']), /Unknown scenario/);
  assert.throws(() => scenarios(['head', 'head']), /unique/);
});

test('edit oracle preserves exact bytes at splice, write, patch and truncate boundaries', () => {
  const source = Buffer.alloc(1024 * 1024, 7), data = Buffer.alloc(4096, 9);
  for (const kind of ['append', 'truncate', 'write', 'patch', 'insert-start', 'insert-middle', 'delete-start', 'delete-middle']) {
    const expected = [...source], offset = kind.endsWith('start') ? 0 : source.length / 2;
    if (kind === 'append') expected.push(...data);
    else if (kind === 'truncate') expected.splice(-data.length);
    else if (kind === 'write') expected.splice(4096, data.length, ...data);
    else if (kind === 'patch') for (let i = 0; i < 16; i++) expected.splice(Math.floor(i * (source.length - data.length) / 15), data.length, ...data);
    else expected.splice(offset, kind.startsWith('delete') ? data.length : 0, ...(kind.startsWith('insert') ? data : []));
    assert(edited(kind, source, data).equals(Buffer.from(expected)), kind);
    assert(source.equals(Buffer.alloc(source.length, 7)));
  }
});

test('pool bounds concurrency and waits for in-flight operations before rejecting', async () => {
  let active = 0, peak = 0, finished = 0;
  await assert.rejects(pool(20, 3, async i => {
    active++; peak = Math.max(peak, active);
    try { await new Promise(resolve => setTimeout(resolve, 5)); if (i === 0) throw new Error('failure'); }
    finally { active--; finished++; }
  }), AggregateError);
  assert.equal(active, 0); assert.equal(peak, 3); assert.equal(finished, 20);
});

test('a write refusal stops before the 49 workloads and saves a credential-free failure report', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'orbit-benchmark-test-'));
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ method: request.method, url: request.url });
    request.resume();
    response.writeHead(403, { 'content-type': 'application/xml' });
    response.end('<Error><Code>QuotaExceeded</Code><Message>Writes disabled</Message></Error>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const credentials = join(directory, 'credentials.json'), output = join(directory, 'results.json');
    const secret = 'test-secret-must-not-be-recorded';
    await writeFile(credentials, JSON.stringify({ endpoint: `http://127.0.0.1:${server.address().port}`, bucket: 'test-bucket', accessKeyId: 'TESTKEY', secretAccessKey: secret }), { mode: 0o600 });
    const child = spawn(process.execPath, [new URL('./s3-benchmark.mjs', import.meta.url).pathname, credentials, output], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = ''; child.stderr.on('data', data => { stderr += data; });
    const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
    assert.equal(code, 1, stderr);
    const raw = await readFile(output, 'utf8'), result = JSON.parse(raw);
    assert.equal(result.preflight, 'failed'); assert.deepEqual(result.rows, []);
    assert.equal(result.error.code, 'QuotaExceeded'); assert(!raw.includes(secret));
    assert.equal(requests.filter(request => request.method === 'PUT').length, 1);
    assert(requests.every(request => request.url.includes('orbit-benchmark-')));
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
