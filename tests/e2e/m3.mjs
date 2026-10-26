import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { constants } from 'node:fs';
import { access, readFile, writeFile, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { otpFromLog } from './helpers.mjs';

export function patch(offset, bytes) {
  const header = Buffer.alloc(28);
  header.write('S3SP'); header[4] = 1; header.writeUInt32BE(1, 8);
  header.writeBigUInt64BE(BigInt(offset), 12); header.writeBigUInt64BE(BigInt(bytes.length), 20);
  return Buffer.concat([header, bytes]);
}
async function objectFiles(path) {
  const files = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) files.push(...await objectFiles(child));
    else files.push(child);
  }
  return files.sort();
}

export async function m3Checks(h) {
  const { root, work, api, endpoint, s3, drive, apiWorker, binary, cacheSandbox, wrangler, check, command, request, json, until, secrets } = h;
  const require = createRequire(join(root, 'cloud/s3-gateway/package.json'));
  const { SignatureV4 } = require('@smithy/signature-v4');
  const signerRequire = createRequire(require.resolve('@smithy/signature-v4'));
  const { HttpRequest } = signerRequire('@smithy/core/protocols');
  class sha256 {
    constructor(secret) { this.hash = secret ? createHmac('sha256', secret) : createHash('sha256'); }
    update(bytes) { this.hash.update(bytes); return this; }
    async digest() { return this.hash.digest(); }
  }
  const sdk = require('@aws-sdk/client-s3');
  let session, parent, child, org, forkId, nestedId, initialVersion;
  const bucket = 'e2e-m3-parent', fork = 'e2e-m3-fork', nested = 'e2e-m3-nested';
  const payload = randomBytes(8 * 1024 * 1024);
  let expected = payload;
  const input = join(work, 'm3-input.bin'), output = join(work, 'm3-output.bin');
  let aws;
  for (const dir of (process.env.PATH ?? '').split(':')) {
    try { const candidate = join(dir, 'aws'); await access(candidate, constants.X_OK); aws = candidate; break; } catch { /* next PATH entry */ }
  }
  const credentials = key => ({ accessKeyId: key.accessKeyId, secretAccessKey: key.secretAccessKey });
  const remember = key => { secrets.push(key.accessKeyId, key.secretAccessKey); return key; };
  async function signed(method, path, { body = Buffer.alloc(0), headers = {}, key = parent, hash } = {}) {
    assert(key, 'requires M3 key');
    const url = new URL(s3 + path);
    assert.equal(url.origin, s3);
    const signer = new SignatureV4({ credentials: credentials(key), region: 'auto', service: 's3', sha256, uriEscapePath: false });
    const query = Object.fromEntries(url.searchParams);
    const req = await signer.sign(new HttpRequest({ protocol: url.protocol, hostname: url.hostname, port: Number(url.port), path: url.pathname, query, method,
      headers: { host: url.host, 'x-amz-content-sha256': hash ?? createHash('sha256').update(body).digest('hex'), ...(!['GET', 'HEAD'].includes(method) ? { 'content-length': String(body.length) } : {}), ...headers }, body }));
    const response = await fetch(url, { method, headers: req.headers, body: ['GET', 'HEAD'].includes(method) ? undefined : body, signal: AbortSignal.timeout(20000), redirect: 'error' });
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(response.headers.get('x-uls-protocol'), '1');
    return { status: response.status, bytes, headers: response.headers, text: bytes.toString() };
  }
  async function ok(method, path, options) {
    const result = await signed(method, path, options);
    assert(result.status >= 200 && result.status < 300, `${method} ${path.split('?')[0]} HTTP ${result.status}: ${result.text.slice(0, 160)}`);
    return result;
  }
  async function matches(b, bytes, key = parent) {
    assert((await ok('GET', `/${b}/m3.bin`, { key })).bytes.equals(bytes), `${b} bytes differ`);
  }
  async function standard(op, args) {
    assert(parent, 'requires parent key');
    if (aws) {
      const result = await command(aws, ['--endpoint-url', s3, '--region', 'auto', '--no-cli-pager', 's3api', op, ...args], {
        AWS_ACCESS_KEY_ID: parent.accessKeyId, AWS_SECRET_ACCESS_KEY: parent.secretAccessKey,
        AWS_SESSION_TOKEN: '', AWS_MAX_ATTEMPTS: '1', AWS_EC2_METADATA_DISABLED: 'true', AWS_CONFIG_FILE: join(work, 'aws-config'), AWS_SHARED_CREDENTIALS_FILE: join(work, 'no-credentials'),
      }, 30000);
      assert.equal(result.code, 0, `AWS CLI ${op} failed: ${result.stderr}`);
      return result.stdout.trim() ? JSON.parse(result.stdout) : {};
    }
    const client = new sdk.S3Client({ endpoint: s3, region: 'auto', forcePathStyle: true, credentials: credentials(parent), maxAttempts: 1 });
    try {
      if (op === 'list-buckets') return await client.send(new sdk.ListBucketsCommand({}));
      if (op === 'put-object') return await client.send(new sdk.PutObjectCommand({ Bucket: bucket, Key: 'm3.bin', Body: payload }));
      const result = await client.send(new sdk.GetObjectCommand({ Bucket: bucket, Key: 'm3.bin' }));
      await writeFile(output, await result.Body.transformToByteArray()); return {};
    } finally { client.destroy(); }
  }
  await check('m3 session key + ListBuckets alias (official AWS client)', async () => {
    assert(drive && h.session, 'requires cloud session');
    const email = h.session.user.email, offset = apiWorker.stdout.length;
    await json(api, '/auth/otp/start', { body: { email } });
    let code;
    await until(() => { code = otpFromLog(apiWorker.stdout.slice(offset), email); return !!code; }, 5000, 'M3 OTP missing');
    secrets.push(code);
    session = await json(api, '/auth/otp/verify', { body: { email, code } });
    secrets.push(session.accessToken, session.refreshToken);
    org = (await json(api, '/orgs', { token: session.accessToken })).orgs[0].id;
    const renamed = await request(api, `/drives/${drive}`, { token: session.accessToken, method: 'PATCH', body: { alias: bucket } });
    assert.equal(renamed.status, 200);
    const minted = await request(api, '/keys', { token: session.accessToken, body: { workspaceId: org, access: 'admin', label: 'E2E M3' } });
    if (minted.data?.secretAccessKey) parent = remember(minted.data);
    assert.equal(minted.status, 201, `key mint HTTP ${minted.status}: ${minted.data?.error ?? 'non-JSON'}`); assert(parent);
    await writeFile(join(work, 'aws-config'), '[default]\ns3 =\n    addressing_style = path\n');
    await ok('GET', '/');
    if (aws) {
      const version = await command(aws, ['--version']);
      assert.equal(version.code, 0); assert.match(version.stdout + version.stderr, /aws-cli\/2\./, 'aws on PATH must be AWS CLI v2');
    }
    assert((await standard('list-buckets', [])).Buckets.some(b => b.Name === bucket));
    return aws ? 'AWS CLI v2; real D1 access key' : 'installed @aws-sdk/client-s3; real D1 access key';
  });
  await check('m3 PutObject/GetObject random 8 MiB + aws-chunked', async () => {
    await writeFile(input, payload);
    await standard('put-object', ['--bucket', bucket, '--key', 'm3.bin', '--body', input]);
    await standard('get-object', ['--bucket', bucket, '--key', 'm3.bin', output]);
    assert((await readFile(output)).equals(payload), 'AWS download differs');
    await unlink(input); await unlink(output);
    const checksum = createHash('sha256').update(payload).digest('base64');
    const framed = Buffer.concat([Buffer.from(`${payload.length.toString(16)}\r\n`), payload, Buffer.from(`\r\n0\r\nx-amz-checksum-sha256:${checksum}\r\n\r\n`)]);
    const result = await ok('PUT', `/${bucket}/m3.bin`, { body: framed, hash: 'STREAMING-UNSIGNED-PAYLOAD-TRAILER', headers: { 'content-encoding': 'aws-chunked', 'x-amz-decoded-content-length': String(payload.length), 'x-amz-trailer': 'x-amz-checksum-sha256' } });
    initialVersion = result.headers.get('x-amz-version-id'); assert(initialVersion);
    await matches(bucket, payload);
    return '8388608 random bytes compared; explicit aws-chunked SHA256 trailer verified';
  });
  await check('m3 write + patch + splice exact bytes, ordered versions + restore', async () => {
    assert(initialVersion, 'requires initial upload');
    const versions = [initialVersion];
    for (const [extension, method, body, headers, apply] of [
      ['write', 'PUT', Buffer.from('WRITE'), { 'x-uls-offset': '17' }, b => { b.set(Buffer.from('WRITE'), 17); return b; }],
      ['patch', 'POST', patch(100, Buffer.from('PATCH')), { 'content-type': 'application/vnd.s3sdk.patch' }, b => { b.set(Buffer.from('PATCH'), 100); return b; }],
      ['splice', 'PUT', Buffer.from('SPLICE'), { 'x-uls-offset': '200', 'x-uls-remove': '3' }, b => Buffer.concat([b.subarray(0, 200), Buffer.from('SPLICE'), b.subarray(203)])],
    ]) {
      const result = await ok(method, `/${bucket}/m3.bin?x-uls-${extension}`, { body, headers });
      versions.push(result.headers.get('x-amz-version-id'));
      expected = apply(Buffer.from(expected)); await matches(bucket, expected);
    }
    const history = JSON.parse((await ok('GET', `/${bucket}/m3.bin?x-uls-versions`)).text);
    const rows = history.versions ?? history;
    assert.deepEqual(rows.slice(-4).map(v => v.versionId), versions);
    const restored = await ok('POST', `/${bucket}/m3.bin?x-uls-restore&versionId=${initialVersion}`);
    assert.equal(restored.headers.get('x-uls-restored-from'), initialVersion);
    assert(!versions.includes(restored.headers.get('x-amz-version-id')));
    await matches(bucket, payload); expected = payload;
  });
  await check('m3 fork snapshot + zero R2 growth + fork of fork + lineage guard', async () => {
    assert(initialVersion, 'requires upload');
    const before = await objectFiles(join(work, 'dp-state/v3/r2'));
    const created = await ok('PUT', `/${fork}`, { headers: { 'x-uls-fork-source': bucket } });
    forkId = created.headers.get('x-uls-drive-id'); assert(forkId);
    await matches(fork, payload);
    const next = await ok('PUT', `/${nested}`, { headers: { 'x-uls-fork-source': fork } });
    nestedId = next.headers.get('x-uls-drive-id'); assert(nestedId);
    await matches(nested, payload);
    assert.deepEqual(await objectFiles(join(work, 'dp-state/v3/r2')), before, 'fork created R2 objects');
    const parentInfo = JSON.parse((await ok('GET', `/${bucket}?x-uls-drive`)).text);
    const forkInfo = JSON.parse((await ok('GET', `/${fork}?x-uls-drive`)).text);
    assert(parentInfo.forks.includes(forkId)); assert.equal(forkInfo.forkOf.driveId, drive); assert(forkInfo.forks.includes(nestedId));
    const denied = await signed('DELETE', `/${bucket}`, { headers: { 'x-uls-hard-delete': 'true' } });
    assert.equal(denied.status, 409); assert.match(denied.text, /<Code>DriveHasForks<\/Code>/);
    return 'two fork levels; R2 file set unchanged; lineage and hard-delete guard verified';
  });
  await check('m3 fork and parent writes remain isolated', async () => {
    assert(forkId && nestedId, 'requires forks');
    await ok('PUT', `/${fork}/m3.bin`, { body: Buffer.from('fork only') });
    await matches(bucket, payload); await matches(nested, payload);
    await ok('PUT', `/${bucket}/m3.bin`, { body: Buffer.from('parent only') });
    await matches(fork, Buffer.from('fork only')); await matches(bucket, Buffer.from('parent only'));
  });
  await check('m3 child SigV4 mint + read scope + hidden bucket + write denied', async () => {
    assert(forkId, 'requires fork');
    const body = Buffer.from(JSON.stringify({ drives: [forkId], access: 'read', label: 'E2E child' }));
    const result = await ok('POST', '/_uls/keys', { body, headers: { 'content-type': 'application/json' } });
    const minted = JSON.parse(result.text); child = remember({ ...minted.key, secretAccessKey: minted.secretAccessKey });
    assert.equal(child.parent, parent.accessKeyId);
    await matches(fork, Buffer.from('fork only'), child);
    const hidden = await signed('GET', `/${bucket}/m3.bin`, { key: child });
    assert.equal(hidden.status, 404); assert.match(hidden.text, /<Code>NoSuchBucket<\/Code>/);
    const denied = await signed('PUT', `/${fork}/m3.bin`, { key: child, body: Buffer.from('denied') });
    assert.equal(denied.status, 403); assert.match(denied.text, /<Code>AccessDenied<\/Code>/);
    const unsigned = await signed('POST', '/_uls/keys', { body, hash: 'UNSIGNED-PAYLOAD' });
    assert.equal(unsigned.status, 400);
  });
  await check('m3 native daemon-less CLI fork + get', async () => {
    assert(session && forkId, 'requires session and fork');
    const prefix = cacheSandbox.length ? cacheSandbox : [binary];
    const result = await command(prefix[0], [...prefix.slice(1), '--json', 'fork', forkId, 'e2e-cli-fork'], { ULS_API: api, ULS_ACCESS_TOKEN: session.accessToken, ULS_ENDPOINT: endpoint, ULS_SOCKET: join(work, 'must-not-start-daemon.sock') });
    assert.equal(result.code, 0, `daemon-less uls fork unavailable: ${result.stderr}`);
    const id = JSON.parse(result.stdout).id; assert(id);
    const token = (await json(api, `/drives/${id}/token`, { token: session.accessToken, body: { access: 'read' } })).token; secrets.push(token);
    const get = await command(prefix[0], [...prefix.slice(1), 'get', id, 'm3.bin', output], { ULS_ENDPOINT: endpoint, ULS_DEV_TOKEN: token });
    assert.equal(get.code, 0); assert((await readFile(output)).equals(Buffer.from('fork only'))); await unlink(output);
  });
  await check('m3 quota rejects writes + tokens; reads and deletes survive', async () => {
    assert(session && parent && forkId, 'requires keys and fork');
    assert.match(drive, /^d-[a-z0-9]{26}$/);
    const sql = `INSERT OR REPLACE INTO drive_usage(drive_id,logical_bytes,own_bytes,measured_at) VALUES('${drive}',1,9000000000000000,${Date.now()})`;
    const changed = await command(process.execPath, [wrangler, 'd1', 'execute', 'DB', '--local', '--persist-to', join(work, 'api-state'), '--config', join(work, 'api/wrangler.json'), '--command', sql]);
    assert.equal(changed.code, 0, 'isolated local D1 quota setup failed');
    const billing = await json(api, `/orgs/${org}/billing`, { token: session.accessToken }); assert.equal(billing.overQuota, true);
    const denied = await signed('PUT', `/${fork}/m3.bin`, { body: Buffer.from('denied') });
    assert.equal(denied.status, 403); assert.match(denied.text, /<Code>QuotaExceeded<\/Code>/);
    const token = await request(api, `/drives/${forkId}/token`, { token: session.accessToken, body: { access: 'write' } });
    assert.equal(token.status, 403); assert.equal(token.data.error, 'over_quota');
    assert.equal((await request(api, `/drives/${forkId}/token`, { token: session.accessToken, body: { access: 'read' } })).status, 200);
    await matches(fork, Buffer.from('fork only'));
    await ok('DELETE', `/${fork}/m3.bin`);
    assert.equal((await signed('GET', `/${fork}/m3.bin`)).status, 404);
  });
  await check('m3 parent revocation kills warmed child within 35 s', async () => {
    assert(child && parent && session, 'requires parent and child');
    await ok('GET', `/${fork}?x-uls-drive`, { key: child });
    const started = performance.now();
    const revoked = await request(api, `/keys/${parent.accessKeyId}`, { token: session.accessToken, method: 'DELETE' });
    assert([200, 204].includes(revoked.status));
    await until(async () => {
      const result = await signed('GET', `/${fork}?x-uls-drive`, { key: child });
      assert([200, 403].includes(result.status), `unexpected revocation HTTP ${result.status}`);
      return result.status === 403;
    }, 35000, 'child remained valid beyond 35 s');
    return `${(performance.now() - started).toFixed(1)} ms after revocation; warmed child denied`;
  });
}
