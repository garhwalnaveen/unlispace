import assert from 'node:assert/strict';

export function otpFromLog(log, email) {
  // ConsoleSender currently uses to=; older Miniflare email output used To:.
  const escaped = email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const messages = [...log.matchAll(new RegExp(`(?:to=|To: )${escaped}(?=\\s|$)([^]*?)(?=\\[email:dev\\]|To: |$)`, 'g'))];
  const body = messages.at(-1)?.[1] ?? '';
  return body.match(/(?:code(?: is|:)?\s+)(\d{6})\b/i)?.[1];
}

export function uploadResult(output) {
  const version = output.match(/\bversion (\S+)\s+seq (\d+)/);
  const shards = output.match(/\((\d+) of (\d+) shards uploaded,/);
  assert(version && shards, 'CLI put output did not contain version/seq/upload counts');
  return { version: version[1], seq: Number(version[2]), uploaded: Number(shards[1]), unique: Number(shards[2]) };
}

export function watchHas(output, path, version) {
  return output.split('\n').some(line => {
    const fields = line.trim().split(/\s+/);
    return /^\d+$/.test(fields[0]) && fields[1] === 'put' && fields[2] === path && fields[3] === version;
  });
}

export function fixture() {
  const data = Buffer.alloc(8 * 1024 * 1024);
  let state = 0x12345678;
  for (let i = 0; i < data.length; i++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    data[i] = state & 255;
  }
  return data;
}
