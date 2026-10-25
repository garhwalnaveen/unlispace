import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { generateKeyPairSync, createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { access, mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { otpFromLog, uploadResult, watchHas, fixture } from './helpers.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const work = process.argv[2];
assert(work?.startsWith('/private/tmp/unlispace-e2e.') || work?.startsWith('/tmp/unlispace-e2e.'), 'run through tests/e2e/run.sh');
const apiPort = Number(process.env.E2E_API_PORT ?? 8788);
const dpPort = Number(process.env.E2E_DATA_PORT ?? 8787);
const inspectorPort = Number(process.env.E2E_INSPECTOR_PORT ?? 9230);
const api = `http://127.0.0.1:${apiPort}`;
const endpoint = `http://127.0.0.1:${dpPort}`;
const mountpoint = join(work, 'mount');
const binary = join(root, 'engine/target/debug/ulsd');
const wrangler = join(root, 'cloud/api/node_modules/wrangler/bin/wrangler.js');
const rows = [];
const children = new Set();
const secrets = [];
const env = {
  ...process.env, CI: '1', NO_COLOR: '1', FORCE_COLOR: '0',
  WRANGLER_SEND_METRICS: 'false', WRANGLER_REGISTRY_PATH: join(work, 'registry'),
  WRANGLER_HIDE_BANNER: 'true',
  XDG_CONFIG_HOME: join(work, 'config'), XDG_CACHE_HOME: join(work, 'cache'),
  WRANGLER_LOG_PATH: join(work, 'wrangler.log'), TMPDIR: work,
  CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false',
};
// Do not inherit credentials or experimental remote-binding switches from a developer shell.
for (const key of Object.keys(env)) {
  if (/^(CLOUDFLARE_|CF_|ULS_|RESEND_|GOOGLE_)/.test(key)) delete env[key];
}
env.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV = 'false';
env.CLOUDFLARE_CF_FETCH_ENABLED = 'false';
let writeToken, readToken, session, drive, code, apiWorker, dpWorker, watcher, nfs;
let original, initial, duplicate, edited, restored;
let cacheSandbox = [];
let cleanupPromise;

function safe(message) {
  let result = String(message);
  for (const secret of secrets) if (secret) result = result.replaceAll(secret, '[redacted]');
  return result.replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted JWT]').replaceAll('\n', ' ').slice(0, 400);
}

async function check(name, action) {
  try {
    const detail = await action();
    rows.push({ status: 'PASS', check: name, detail: detail ?? '' });
  } catch (error) {
    rows.push({ status: 'FAIL', check: name, detail: safe(error.message) });
  }
  const row = rows.at(-1);
  console.log(`${row.status}  ${row.check}${row.detail ? `: ${row.detail}` : ''}`);
}

function start(command, args, extraEnv = {}) {
  const child = spawn(command, args, { cwd: work, env: { ...env, ...extraEnv }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const record = { child, stdout: '', stderr: '', lines: [] };
  record.done = new Promise(resolveDone => {
    child.once('error', error => resolveDone({ code: -1, error }));
    child.once('close', (code, signal) => resolveDone({ code, signal }));
  });
  for (const stream of ['stdout', 'stderr']) child[stream].on('data', chunk => {
    record[stream] += chunk.toString();
    if (record[stream].length > 2 * 1024 * 1024) record[stream] = record[stream].slice(-1024 * 1024);
  });
  children.add(record);
  return record;
}

function signal(record, value) {
  if (!record?.child.pid) return;
  try { process.kill(-record.child.pid, value); } catch (error) { if (error.code !== 'ESRCH') throw error; }
}

async function stop(record) {
  if (!record) return;
  signal(record, 'SIGINT');
  const stopped = await Promise.race([record.done.then(() => true), delay(3000).then(() => false)]);
  // Kill the whole owned group, including a runtime orphaned by its wrapper.
  signal(record, 'SIGKILL');
  if (!stopped) await record.done;
  children.delete(record);
}

async function command(executable, args, extraEnv, timeout = 30000) {
  const child = start(executable, args, extraEnv);
  let timer;
  try {
    const result = await Promise.race([
      child.done,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`command timed out after ${timeout} ms`)), timeout); }),
    ]);
    return { ...result, stdout: child.stdout, stderr: child.stderr };
  } finally {
    clearTimeout(timer);
    await stop(child);
  }
}

async function cli(args, { token = writeToken, allowFailure = false } = {}) {
  assert(token && drive, 'requires a provisioned drive and token');
  const prefix = cacheSandbox.length ? cacheSandbox : [binary];
  const result = await command(prefix[0], [...prefix.slice(1), ...args], { ULS_ENDPOINT: endpoint, ULS_DEV_TOKEN: token, RUST_LOG: 'warn' });
  assert(allowFailure || result.code === 0, `CLI ${args[0]} exited ${result.code}: ${safe(result.stderr)}`);
  return result;
}

async function request(base, path, { token, body, method = body === undefined ? 'GET' : 'POST' } = {}) {
  assert(base === api || base === endpoint, 'only local Worker requests are allowed');
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined && !Buffer.isBuffer(body)) headers['content-type'] = 'application/json';
  const response = await fetch(base + path, {
    method, headers, body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body),
    signal: AbortSignal.timeout(10000), redirect: 'error',
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = null; }
  return { status: response.status, data };
}

async function json(base, path, options) {
  const result = await request(base, path, options);
  assert.equal(result.status, 200, `${path.split('?')[0]} HTTP ${result.status} (${result.data?.error ?? 'non-JSON response'})`);
  assert(result.data, 'expected a JSON response');
  return result.data;
}

function dp(path, options = {}) {
  assert(drive && writeToken, 'requires a provisioned drive and token');
  return json(endpoint, `/v0/drives/${drive}${path}`, { token: writeToken, ...options });
}

async function until(predicate, milliseconds, message) {
  const deadline = performance.now() + milliseconds;
  do {
    if (await predicate()) return;
    await delay(20);
  } while (performance.now() < deadline);
  throw new Error(message);
}

async function freePort(port) {
  assert(Number.isInteger(port) && port > 1024 && port <= 65535, 'ports must be integers in 1025..65535');
  await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', () => reject(new Error(`127.0.0.1:${port} is occupied or unavailable; existing processes were left alone`)));
    server.listen(port, '127.0.0.1', () => server.close(resolvePort));
  });
}

async function setup() {
  assert.equal(new Set([apiPort, dpPort, inspectorPort, inspectorPort + 1]).size, 4, 'HTTP and inspector ports must be distinct');
  for (const port of [apiPort, dpPort, inspectorPort, inspectorPort + 1]) await freePort(port);
  await access(binary);
  const require = createRequire(join(root, 'cloud/api/package.json'));
  const installed = require('wrangler/package.json').version;
  assert(installed.startsWith('4.'), 'install the pinned cloud/api Wrangler v4 dependency first');
  const ts = require('typescript');
  for (const service of ['api', 'data-plane']) {
    const path = join(root, 'cloud', service, 'wrangler.jsonc');
    const parsed = ts.parseConfigFileTextToJson(path, await readFile(path, 'utf8'));
    assert(!parsed.error, `cannot parse ${service} Wrangler config`);
    const config = parsed.config;
    assert(!config.build?.command, 'custom build commands are outside the local harness scope');
    assert(!config.env, 'review environment-specific bindings before using this harness');
    config.main = resolve(dirname(path), config.main);
    delete config.$schema;
    delete config.observability;
    config.dev = { ip: '127.0.0.1', port: service === 'api' ? apiPort : dpPort, inspector_port: service === 'api' ? inspectorPort + 1 : inspectorPort };
    for (const bindings of [config.r2_buckets, config.d1_databases, config.kv_namespaces, config.services]) {
      for (const binding of bindings ?? []) {
        assert(binding.remote !== true, 'remote bindings are forbidden');
        if (binding.migrations_dir) binding.migrations_dir = resolve(dirname(path), binding.migrations_dir);
      }
    }
    assert(!config.ai && !config.vectorize && !config.browser && !config.hyperdrive, 'external service binding is forbidden');
    config.vars = { ...config.vars, ULS_ISSUER: api };
    if (service === 'api') Object.assign(config.vars, { ULS_DEV_LOG_OTP: '1', ULS_DATA_ENDPOINT: endpoint });
    else config.vars.ULS_ALLOW_DEV_TOKEN = '0';
    await mkdir(join(work, service));
    await writeFile(join(work, service, 'wrangler.json'), JSON.stringify(config));
  }
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const attributes = { kid: 'local-e2e', alg: 'EdDSA', use: 'sig' };
  const privateJwk = JSON.stringify({ ...privateKey.export({ format: 'jwk' }), ...attributes });
  const blockKey = randomBytes(32).toString('hex');
  secrets.push(privateJwk, blockKey);
  const jwks = JSON.stringify({ keys: [{ ...publicKey.export({ format: 'jwk' }), ...attributes }] });
  await writeFile(join(work, 'api/.dev.vars'), `ULS_JWT_PRIVATE_JWK=${privateJwk}\nULS_JWT_PUBLIC_JWKS=${jwks}\n`, { mode: 0o600 });
  await writeFile(join(work, 'data-plane/.dev.vars'), `ULS_JWT_PUBLIC_JWKS=${jwks}\nULS_BLOCK_KEY=${blockKey}\n`, { mode: 0o600 });
  await mkdir(mountpoint);
  // On an ordinary Mac, prevent the CLI from writing its hard-coded per-user cache.
  // A managed filesystem sandbox already blocks that path but cannot nest sandbox-exec.
  if (process.platform === 'darwin') {
    const profile = '(version 1)(allow default)(deny file-write* (regex #"/Library/Caches/com\\\\.unlispace(/|$)"))';
    const probe = await command('/usr/bin/sandbox-exec', ['-p', profile, '/usr/bin/true']);
    if (probe.code === 0) cacheSandbox = ['/usr/bin/sandbox-exec', '-p', profile, binary];
    else assert.equal(process.env.E2E_MANAGED_SANDBOX, '1', 'sandbox-exec unavailable; set E2E_MANAGED_SANDBOX=1 only when the parent sandbox denies writes to ~/Library/Caches/com.unlispace');
  }
  const configArgs = service => ['--config', join(work, service, 'wrangler.json')];
  console.log('SETUP applying local D1 migrations (120 s deadline)');
  const migrate = await command(process.execPath, [wrangler, 'd1', 'migrations', 'apply', 'DB', '--local', '--persist-to', join(work, 'api-state'), ...configArgs('api')], {}, 120000);
  assert.equal(migrate.code, 0, `D1 migrations failed: ${safe(migrate.stderr)}`);
  console.log('SETUP starting isolated local Workers (45 s deadline)');
  dpWorker = start(process.execPath, [wrangler, 'dev', '--local', '--port', String(dpPort), '--inspector-port', String(inspectorPort), '--persist-to', join(work, 'dp-state'), ...configArgs('data-plane')]);
  apiWorker = start(process.execPath, [wrangler, 'dev', '--local', '--port', String(apiPort), '--inspector-port', String(inspectorPort + 1), '--persist-to', join(work, 'api-state'), ...configArgs('api')]);
  for (const base of [endpoint, api]) await until(async () => {
    for (const worker of [apiWorker, dpWorker]) assert(worker.child.exitCode === null, `Worker exited: ${safe(worker.stderr)}`);
    try { return (await request(base, '/healthz')).status === 200; } catch { return false; }
  }, 45000, `Worker startup timed out at ${base}`);
  return `Wrangler ${installed}; api :${apiPort}, data :${dpPort}, inspector :${inspectorPort}; D1 migrated`;
}

async function cloudChecks() {
  const email = `e2e+${Date.now()}@example.com`;
  await check('cloud 01 otp start', async () => { assert.equal((await json(api, '/auth/otp/start', { body: { email } })).ok, true); });
  await check('cloud 02 dev OTP logged', async () => {
    assert(apiWorker, 'API did not start');
    await until(() => { code = otpFromLog(apiWorker.stdout + apiWorker.stderr, email); return !!code; }, 5000, 'OTP was not found in local email log');
    secrets.push(code);
  });
  await check('cloud 03 wrong code -> 400', async () => {
    assert(code, 'requires logged OTP');
    assert.equal((await request(api, '/auth/otp/verify', { body: { email, code: code === '000000' ? '000001' : '000000' } })).status, 400);
  });
  await check('cloud 04 verify -> session, accountCreated', async () => {
    assert(code, 'requires logged OTP');
    session = await json(api, '/auth/otp/verify', { body: { email, code } });
    secrets.push(session.accessToken, session.refreshToken);
    assert.equal(session.accountCreated, true);
    assert(session.accessToken && session.refreshToken && session.user.id.startsWith('u_'));
  });
  await check('cloud 05 My Space + ready drive via service binding', async () => {
    assert(session, 'requires session');
    const orgs = await json(api, '/orgs', { token: session.accessToken });
    const org = orgs.orgs[0];
    assert.equal(org.name, 'My Space');
    assert.equal(org.role, 'owner');
    assert.equal(org.drives[0].status, 'ready');
    drive = org.drives[0].id;
  });
  await check('cloud 06 write drive token minted', async () => {
    assert(drive, 'requires ready drive');
    const minted = await json(api, `/drives/${drive}/token`, { token: session.accessToken, body: { access: 'write' } });
    writeToken = minted.token;
    secrets.push(writeToken);
    assert(writeToken);
    assert.equal(minted.endpoint, endpoint);
  });
  await check('cloud 07 data plane accepts API-signed token', async () => { await dp(''); });
  const body = Buffer.from('hello unlispace');
  const hash = createHash('sha256').update(body).digest('hex');
  await check('cloud 08 shard PUT with drive token', async () => {
    assert(writeToken && drive, 'requires drive token');
    const result = await request(endpoint, `/v0/drives/${drive}/shards/${hash}`, { token: writeToken, method: 'PUT', body });
    assert([200, 201].includes(result.status), `shard PUT HTTP ${result.status}`);
  });
  await check('cloud 09 commit', async () => {
    const result = await dp('/commit', { body: { ops: [{ op: 'put', path: 'hello.txt', size: body.length, shards: [{ h: hash, n: body.length }] }] } });
    assert(result.results[0].versionId);
  });
  await check('cloud 10 version actor = token user id', async () => {
    assert.equal((await dp('/versions?path=hello.txt')).versions[0].actor, session.user.id);
  });
  await check('cloud 11 drive A token on B -> 404', async () => {
    assert(writeToken, 'requires drive token');
    assert.equal((await request(endpoint, '/v0/drives/some-other-drive', { token: writeToken })).status, 404);
  });
  await check('cloud 12 read token cannot commit -> 404', async () => {
    assert(drive, 'requires ready drive');
    readToken = (await json(api, `/drives/${drive}/token`, { token: session.accessToken, body: { access: 'read' } })).token;
    secrets.push(readToken);
    assert(readToken);
    assert.equal((await request(endpoint, `/v0/drives/${drive}/commit`, { token: readToken, body: { ops: [{ op: 'mkdir', path: 'forbidden/' }] } })).status, 404);
  });
  await check('cloud 13 API access token on data plane -> 401', async () => {
    assert(drive && session, 'requires ready drive and session');
    assert.equal((await request(endpoint, `/v0/drives/${drive}`, { token: session.accessToken })).status, 401);
  });
  let rotated;
  await check('cloud 14 refresh rotates', async () => {
    assert(session, 'requires session');
    rotated = await json(api, '/auth/refresh', { body: { refreshToken: session.refreshToken } });
    secrets.push(rotated.accessToken, rotated.refreshToken);
    assert(rotated.refreshToken && rotated.refreshToken !== session.refreshToken);
  });
  await check('cloud 15 reused old refresh token -> 401', async () => {
    assert(rotated, 'requires rotated session');
    assert.equal((await request(api, '/auth/refresh', { body: { refreshToken: session.refreshToken } })).status, 401);
  });
  await check('cloud 16 reuse revokes whole refresh family', async () => {
    assert(rotated, 'requires rotated session');
    assert.equal((await request(api, '/auth/refresh', { body: { refreshToken: rotated.refreshToken } })).status, 401);
  });
}

async function downloadMatches(expected, version) {
  const output = join(work, 'download.bin');
  try {
    await cli(['get', drive, 'engine.bin', output, ...(version ? ['--version', version] : [])], { token: readToken });
    assert.deepEqual(await readFile(output), expected, 'downloaded bytes differ');
  } finally { await unlink(output).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}

async function engineChecks() {
  const local = join(work, 'source.bin');
  await check('engine CLI put/get byte-identical', async () => {
    original = fixture();
    await writeFile(local, original);
    initial = uploadResult((await cli(['put', drive, local, 'engine.bin'])).stdout);
    assert(initial.uploaded > 1, 'fixture must exercise multiple shards');
    await downloadMatches(original);
    return `${initial.uploaded} unique shards uploaded; ${original.length} bytes compared`;
  });
  await check('engine dedup re-upload sends zero shards', async () => {
    assert(initial, 'requires initial upload');
    duplicate = uploadResult((await cli(['put', drive, local, 'engine.bin'])).stdout);
    assert.equal(duplicate.uploaded, 0);
    assert(duplicate.version !== initial.version);
    return `0 of ${duplicate.unique} shards uploaded`;
  });
  await check('engine 4 KiB edit uploads exactly one shard', async () => {
    assert(duplicate && original, 'requires dedup upload');
    const before = await dp('/manifest?path=engine.bin');
    const changed = Buffer.from(original);
    for (let i = changed.length - 4096; i < changed.length; i++) changed[i] ^= 255;
    await writeFile(local, changed);
    edited = uploadResult((await cli(['put', drive, local, 'engine.bin', '--if-version', duplicate.version])).stdout);
    const after = await dp('/manifest?path=engine.bin');
    const known = new Set(before.shards.map(shard => shard.h));
    assert.equal(new Set(after.shards.filter(shard => !known.has(shard.h)).map(shard => shard.h)).size, 1);
    assert.equal(edited.uploaded, 1);
    await downloadMatches(changed);
    return `4096 bytes edited; 1 of ${edited.unique} shards uploaded; bytes verified`;
  });
  await check('engine CLI versions + historical get', async () => {
    assert(initial && duplicate && edited, 'requires three puts');
    const versions = (await cli(['versions', drive, 'engine.bin'])).stdout.trim().split('\n').map(line => line.trim().split(/\s+/)[0]);
    assert.deepEqual(versions, [initial.version, duplicate.version, edited.version]);
    await downloadMatches(original, initial.version);
    return 'three ordered versions; first version bytes verified';
  });
  await check('engine CLI restore creates new head', async () => {
    assert(initial && edited, 'requires initial and edited versions');
    await cli(['restore', drive, 'engine.bin', initial.version]);
    const head = await dp('/stat?path=engine.bin');
    assert(head.versionId !== initial.version && head.versionId !== edited.version);
    restored = head.versionId;
    await downloadMatches(original);
    return 'new version; original bytes restored';
  });
  await check('engine concurrent ifVersion has exactly one winner', async () => {
    assert(restored, 'requires restored head');
    const first = Buffer.alloc(4096, 17), second = Buffer.alloc(4096, 33);
    const a = join(work, 'race-a.bin'), b = join(work, 'race-b.bin');
    await writeFile(a, first); await writeFile(b, second);
    const before = await dp('/versions?path=engine.bin');
    const results = await Promise.all([a, b].map(path => cli(['put', drive, path, 'engine.bin', '--if-version', restored], { allowFailure: true })));
    assert.deepEqual(results.map(result => result.code).sort(), [0, 2]);
    assert.match(results.find(result => result.code === 2).stderr, /precondition/i);
    const after = await dp('/versions?path=engine.bin');
    assert.equal(after.versions.length, before.versions.length + 1);
    const winner = results.findIndex(result => result.code === 0);
    await downloadMatches(winner === 0 ? first : second);
    return 'exit codes 0,2; one new version; winner bytes verified';
  });
  await check('engine second CLI client watches change in < 1 s', async () => {
    assert(readToken && drive, 'requires read token');
    const prefix = cacheSandbox.length ? cacheSandbox : [binary];
    watcher = start(prefix[0], [...prefix.slice(1), 'watch', drive, '--since', '0'], { ULS_ENDPOINT: endpoint, ULS_DEV_TOKEN: readToken });
    // Observe replay first; no arbitrary sleep to guess that the WebSocket is connected.
    await until(() => watchHas(watcher.stdout, 'hello.txt', '') || /\d+\s+put\s+hello\.txt\s+v_/.test(watcher.stdout), 5000, 'second client never received replay');
    const marker = join(work, 'watch.bin');
    await writeFile(marker, Buffer.from('watch latency marker'));
    let receivedAt;
    watcher.child.stdout.on('data', () => {
      if (/\d+\s+put\s+watched\.bin\s+v_/.test(watcher.stdout) && receivedAt === undefined) receivedAt = performance.now();
    });
    const started = performance.now();
    const result = uploadResult((await cli(['put', drive, marker, 'watched.bin'])).stdout);
    await until(() => watchHas(watcher.stdout, 'watched.bin', result.version), 5000, 'second client missed committed version');
    const latency = receivedAt - started;
    assert(Number.isFinite(latency) && latency < 1000, `watch latency ${latency.toFixed(1)} ms exceeds 1000 ms`);
    await stop(watcher); watcher = undefined;
    return `${latency.toFixed(1)} ms from writer invocation to exact version observed`;
  });
  await check('engine native read-only NFS mount + byte-identical read', async () => {
    assert.equal(process.platform, 'darwin', 'native mount requires macOS mount_nfs');
    assert(readToken && original && initial, 'requires read token and original fixture');
    // Restore the large file after the race so NFS traverses multiple shards.
    await cli(['restore', drive, 'engine.bin', initial.version]);
    const prefix = cacheSandbox.length ? cacheSandbox : [binary];
    nfs = start(prefix[0], [...prefix.slice(1), 'mount', drive, mountpoint], { ULS_ENDPOINT: endpoint, ULS_DEV_TOKEN: readToken });
    await until(() => {
      assert.equal(nfs.child.exitCode, null, `NFS mount exited: ${safe(nfs.stderr)}`);
      return nfs.stderr.includes(`mounted at ${mountpoint}`);
    }, 35000, `NFS mount timed out: ${safe(nfs.stderr)}`);
    const mounted = await command('/sbin/mount', []);
    const entry = mounted.stdout.split('\n').find(line => line.includes(` on ${mountpoint} (`));
    assert(entry?.includes('nfs') && entry.includes('read-only'), 'kernel mount table does not show a read-only NFS mount');
    // Child commands are bounded so an unresponsive filesystem cannot hang the runner.
    await writeFile(local, original);
    const compared = await command('/usr/bin/cmp', [local, join(mountpoint, 'engine.bin')]);
    assert.equal(compared.code, 0, 'native NFS bytes differ from original 8 MiB fixture');
    const writeProbe = await command('/usr/bin/touch', [join(mountpoint, 'must-not-write')]);
    assert.notEqual(writeProbe.code, 0, 'read-only mount accepted a write');
    return '8 MiB compared through kernel NFS; write rejected';
  });
}

async function cleanup() {
  return cleanupPromise ??= (async () => {
    if (watcher) await stop(watcher);
    let unmountError;
    try {
      const mounted = await command('/sbin/mount', []);
      if (mounted.stdout.includes(` on ${mountpoint} (`)) {
        let unmounted = await command('/sbin/umount', [mountpoint]);
        if (unmounted.code !== 0) unmounted = await command('/sbin/umount', ['-f', mountpoint]);
        assert.equal(unmounted.code, 0, `unmount failed: ${safe(unmounted.stderr)}`);
      }
    } catch (error) { unmountError = error; }
    for (const child of [...children]) await stop(child);
    if (unmountError) throw unmountError;
    const remaining = await command('/sbin/mount', []);
    assert(!remaining.stdout.includes(` on ${mountpoint} (`), 'NFS mount remains');
    return 'owned processes stopped; no NFS mount remains; shell trap removes temporary data';
  })();
}

let interrupted = false;
for (const signalName of ['SIGINT', 'SIGTERM']) process.once(signalName, () => {
  interrupted = true;
  cleanup().then(() => process.exit(130), error => { console.error(`FAIL  interrupted cleanup: ${safe(error.message)}`); process.exit(1); });
});

try {
  await check('setup local Workers + D1', setup);
  if (rows[0].status === 'PASS') {
    await cloudChecks();
    await engineChecks();
  }
} catch (error) {
  rows.push({ status: 'FAIL', check: 'harness', detail: safe(error.message) });
} finally {
  await check('cleanup', cleanup);
}
console.log('\nSTATUS | CHECK | DETAIL');
console.log('-------|-------|-------');
for (const row of rows) console.log(`${row.status} | ${row.check} | ${row.detail}`);
const passed = rows.filter(row => row.status === 'PASS').length;
const failed = rows.length - passed;
console.log(`RESULT: ${passed} passed, ${failed} failed`);
process.exitCode = failed || interrupted ? 1 : 0;
