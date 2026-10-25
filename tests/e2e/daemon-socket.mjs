import assert from 'node:assert/strict';
import { createConnection } from 'node:net';

// The mount error text only exists in binaries compiled with the optional SMB adapter.
export function smbEnabled(setting, binary) {
  assert(setting === undefined || ['0', '1'].includes(setting), 'E2E_SMB must be 0 or 1');
  return setting === undefined ? binary.includes(Buffer.from('cannot mount loopback SMB share')) : setting === '1';
}

export class DaemonSocket {
  events = [];
  pending = new Map();
  nextId = 0;
  buffer = '';

  constructor(path) {
    this.socket = createConnection(path);
    this.ready = new Promise((resolve, reject) => {
      this.socket.once('connect', resolve);
      this.socket.once('error', reject);
    });
    this.socket.setEncoding('utf8');
    this.socket.on('data', chunk => {
      this.buffer += chunk;
      try {
        assert(this.buffer.length < 1024 * 1024, 'daemon frame exceeded 1 MiB');
        let end;
        while ((end = this.buffer.indexOf('\n')) !== -1) {
          const line = this.buffer.slice(0, end);
          this.buffer = this.buffer.slice(end + 1);
          if (!line.trim()) continue;
          const frame = JSON.parse(line);
          if (frame.event) this.events.push(frame);
          else {
            const request = this.pending.get(frame.id);
            if (!request) continue;
            this.pending.delete(frame.id);
            clearTimeout(request.timer);
            // Do not echo response bodies: auth requests carry credentials.
            if (frame.error) {
              const error = new Error(`daemon request rejected: ${frame.error.code}`);
              error.daemonMessage = frame.error.message;
              request.reject(error);
            }
            else request.resolve(frame.result);
          }
        }
      } catch { this.fail(new Error('invalid daemon frame')); this.socket.destroy(); }
    });
    this.socket.on('error', () => this.fail(new Error('daemon socket error')));
    this.socket.on('close', () => this.fail(new Error('daemon socket closed')));
  }

  fail(error) {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
  }

  async call(method, params = {}, timeout = 35000) {
    await this.ready;
    assert(!this.socket.destroyed, 'daemon socket is closed');
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`daemon ${method} timed out`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }

  close() { this.fail(new Error('daemon connection closed')); this.socket.destroy(); }
}
