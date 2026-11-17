import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { cleanupTree, edited, errorDetails, median, pool, requestHandler, scenarios, verifyBytes } from './s3-benchmark.mjs';

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

test('verification errors retain diagnostic digests without arbitrary payloads or messages', () => {
  let failure;
  try { assert.equal('a'.repeat(64), 'b'.repeat(64)); } catch (error) { failure = error; }
  const details = errorDetails(new AggregateError([failure], 'do not record this message'));
  assert.equal(details.causes[0].actual, 'a'.repeat(64));
  assert.equal(details.causes[0].expected, 'b'.repeat(64));
  assert(!JSON.stringify(details).includes('do not record'));
  failure.actual = 'private bytes'; failure.expected = ['private bytes'];
  assert.equal(errorDetails(failure).actual, undefined);
  assert.equal(errorDetails(failure).expected, undefined);
  failure.actual = ['a'.repeat(64)];
  assert.equal(errorDetails(failure).actual, undefined);
});

test('truncated and changed bodies retain byte counts and both digests', () => {
  const expected = Buffer.from('original bytes');
  verifyBytes(Buffer.from(expected), expected, 'fixture');
  for (const actual of [expected.subarray(0, 3), Buffer.from('modified bytes')]) {
    assert.throws(() => verifyBytes(actual, expected, 'fixture'), error => {
      const detail = errorDetails(error);
      assert.equal(detail.receivedBytes, actual.length);
      assert.equal(detail.expectedBytes, expected.length);
      assert.equal(detail.actualSHA256, createHash('sha256').update(actual).digest('hex'));
      assert.equal(detail.expectedSHA256, createHash('sha256').update(expected).digest('hex'));
      return true;
    });
  }
  assert.deepEqual(errorDetails({name:'S3SDKError',code:'InvalidArgument',status:400,message:'ops[0]: bad path',requestId:'request-123'}),
    {name:'S3SDKError',code:'InvalidArgument',status:400,message:'ops[0]: bad path',requestId:'request-123'});
  assert.equal(errorDetails({name:'S3SDKError',code:'InvalidResponse',message:'missing x-s3sdk-size header'}).message,'missing x-s3sdk-size header');
});

test('request deadline rejects both stalled headers and a stalled response body', async () => {
  for (const headersSent of [false, true]) {
    const server = createServer((_request, response) => {
      if (headersSent) { response.writeHead(200); response.write('partial body'); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const handler = requestHandler(150);
    try {
      await assert.rejects(async () => {
        const {response} = await handler.handle({protocol:'http:',hostname:'127.0.0.1',port:server.address().port,method:'GET',path:'/',headers:{}});
        for await (const _chunk of response.body) {}
      }, error => ['AbortError','TimeoutError'].includes(error.name));
    } finally {
      handler.destroy(); server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  }
});

test('uploads proceed when a server withholds 100 Continue', async () => {
  let received = 0;
  const server = createServer();
  server.on('checkContinue', (request, response) => {
    request.on('data', bytes => { received += bytes.length; });
    request.on('end', () => { response.writeHead(200); response.end('ok'); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const handler = requestHandler(500);
  try {
    const {response} = await handler.handle({protocol:'http:',hostname:'127.0.0.1',port:server.address().port,method:'PUT',path:'/',headers:{expect:'100-continue','content-length':'7'},body:Buffer.from('payload')});
    assert.equal(response.statusCode, 200);
    for await (const _chunk of response.body) {}
    assert.equal(received, 7);
  } finally {
    handler.destroy(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
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
  let compatible = true;
  const server = createServer((request, response) => {
    requests.push({ method: request.method, url: request.url });
    request.resume();
    if (request.url === '/healthz') {
      response.writeHead(200, {'content-type':'application/json',...(compatible ? {'x-s3sdk-protocol':'1'} : {'x-uls-protocol':'1'})});
      response.end('{"ok":true}'); return;
    }
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
    assert(requests.every(request => request.url === '/healthz' || request.url.includes('orbit-benchmark-')));
    compatible = false; requests.length = 0;
    const incompatible = spawn(process.execPath, [new URL('./s3-benchmark.mjs', import.meta.url).pathname, credentials, output], {stdio:'ignore'});
    assert.equal(await new Promise((resolve,reject)=>{incompatible.on('error',reject);incompatible.on('close',resolve);}),1);
    const refused = JSON.parse(await readFile(output,'utf8'));
    assert.equal(refused.error.name,'IncompatibleGateway');
    assert.equal(refused.cleanup,'No benchmark writes attempted');
    assert.deepEqual(requests,[{method:'GET',url:'/healthz'}]);
    assert.equal(requests.filter(request=>request.method==='PUT').length,0);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test('cleanup deletes only the exact generated tree and verifies absence', async () => {
  const prefix='orbit-benchmark-12345678-1234-1234-1234-123456789abc/';
  const config={endpoint:'https://s3.example',bucket:'d-00000000000000000000000000',accessKeyId:'TESTKEY',secretAccessKey:'test-secret'};
  let calls=0;
  await cleanupTree(config,prefix,async (url,init)=>{
    calls++;
    if(calls===1) { assert.equal(new URL(url).search,'?x-uls-mount'); return Response.json({canWrite:true,token:'test-token',driveId:config.bucket,endpoint:'https://data.example'}); }
    assert.equal(init.headers.authorization,'Bearer test-token');
    if(calls===2) { assert.equal(new URL(url).searchParams.get('path'),prefix); return Response.json({type:'folder',versionId:'v1'}); }
    if(calls===3) { const body=JSON.parse(init.body); assert.deepEqual(body.ops,[{op:'delete',path:prefix,ifVersion:'v1'}]); return Response.json({seq:1}); }
    assert.equal(new URL(url).searchParams.get('path'),prefix);
    return Response.json({error:'no_such_path'},{status:404});
  });
  assert.equal(calls,4);
  for (const unsafe of ['', 'unrelated/', `${prefix}nested/`]) await assert.rejects(cleanupTree(config,unsafe,async()=>{throw new Error('must not request');}),/exact generated/);
});
