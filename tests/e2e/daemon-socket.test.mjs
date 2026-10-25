import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { DaemonSocket, smbEnabled } from './daemon-socket.mjs';

test('SMB detection follows compiled adapter and explicit overrides', () => {
  const smb = Buffer.from('prefix cannot mount loopback SMB share suffix');
  assert(smbEnabled(undefined, smb));
  assert(!smbEnabled(undefined, Buffer.from('NFS only')));
  assert(!smbEnabled('0', smb));
  assert(smbEnabled('1', Buffer.alloc(0)));
  assert.throws(() => smbEnabled('yes', smb));
});

test('socket handles fragmented frames, events, pipelined replies, errors and deadlines', async () => {
  const work = await mkdtemp('/tmp/uls-e2e-socket.');
  const path = join(work, 's');
  const peers = new Set();
  const server = createServer(peer => {
    peers.add(peer);
    peer.on('close', () => peers.delete(peer));
    let buffer = '';
    const requests = [];
    peer.on('data', chunk => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf('\n')) !== -1) {
        const request = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        requests.push(request);
        if (request.method === 'first') peer.write('\n{"event":"sta');
        if (request.method === 'second') {
          peer.write('te","data":{"state":"idle"}}\n');
          peer.write(JSON.stringify({ id: request.id, result: { value: 'two' } }) + '\n');
          peer.write(JSON.stringify({ id: requests[0].id, result: { value: 'one' } }) + '\n');
        }
        if (request.method === 'bad') peer.write(JSON.stringify({ id: request.id, error: { code: 'bad_request', message: 'secret must not be echoed' } }) + '\n');
      }
    });
  });
  let client;
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(path, resolve); });
    client = new DaemonSocket(path);
    const results = await Promise.all([client.call('first'), client.call('second')]);
    assert.deepEqual(results, [{ value: 'one' }, { value: 'two' }]);
    assert.deepEqual(client.events, [{ event: 'state', data: { state: 'idle' } }]);
    await assert.rejects(client.call('bad'), { message: 'daemon request rejected: bad_request' });
    await assert.rejects(client.call('ignored', {}, 20), /timed out/);
    assert.equal(client.pending.size, 0);
    const pending = client.call('ignored');
    await new Promise(resolve => setImmediate(resolve));
    client.close();
    await assert.rejects(pending, /connection closed/);
    assert.equal(client.pending.size, 0);
  } finally {
    client?.close();
    for (const peer of peers) peer.destroy();
    await new Promise(resolve => server.close(resolve));
    await rm(work, { recursive: true, force: true });
  }
});
