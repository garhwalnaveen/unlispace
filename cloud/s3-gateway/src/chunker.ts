import { digest } from "./crypto";
import { MIN_SIZE, MAX_SIZE, cut } from "../../shared/fastcdc";

export { MIN_SIZE, AVG_SIZE, MAX_SIZE, cut } from "../../shared/fastcdc";
export interface Shard { h: string; n: number }

/** Grow only when no content-defined boundary is available yet. */
export async function* chunkStream(source: AsyncIterable<Uint8Array>, fixed = false): AsyncGenerator<Uint8Array> {
  let buffer = new Uint8Array(fixed ? MAX_SIZE : MIN_SIZE);
  let filled = 0;
  for await (const input of source) {
    let offset = 0;
    while (offset < input.length) {
      const take = Math.min(buffer.length - filled, input.length - offset);
      buffer.set(input.subarray(offset, offset + take), filled);
      offset += take; filled += take;
      if (filled === buffer.length) {
        const n = fixed ? filled : cut(buffer);
        if (filled === MAX_SIZE || (!fixed && n < filled)) {
          yield buffer.slice(0, n);
          buffer.copyWithin(0, n, filled);
          filled -= n;
        } else {
          const bigger = new Uint8Array(Math.min(MAX_SIZE, buffer.length * 2));
          bigger.set(buffer); buffer = bigger;
        }
      }
    }
  }
  let offset = 0;
  while (offset < filled) {
    const n = fixed ? filled - offset : cut(buffer.subarray(offset, filled));
    yield buffer.slice(offset, offset + n);
    offset += n;
  }
}
export async function chunkManifest(source: AsyncIterable<Uint8Array>, store: (shard: Shard, bytes: Uint8Array) => Promise<void>, fixed = false): Promise<Shard[]> {
  const shards: Shard[] = [];
  const pending: { n: number; done: Promise<void> }[] = [];
  let buffered = 0, failed = false, failure: unknown;
  const drain = async () => {
    const upload = pending.shift()!;
    await upload.done; buffered -= upload.n;
    if (failed) throw failure;
  };
  try {
    for await (const bytes of chunkStream(source, fixed)) {
      while (pending.length && (pending.length >= 4 || buffered + bytes.length > MAX_SIZE)) await drain();
      if (failed) throw failure;
      const shard = { h: await digest(bytes), n: bytes.length };
      pending.push({ n: bytes.length, done: store(shard, bytes).catch(error => { if (!failed) failure = error; failed = true; }) });
      buffered += bytes.length;
      shards.push(shard);
    }
    while (pending.length) await drain();
  } finally { await Promise.all(pending.map(upload => upload.done)); }
  return shards;
}
