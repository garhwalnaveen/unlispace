import { digest } from "./crypto";
import { MAX_SIZE, cut } from "../../shared/fastcdc";

export { MIN_SIZE, AVG_SIZE, MAX_SIZE, cut } from "../../shared/fastcdc";
export interface Shard { h: string; n: number }

/** One max-shard buffer regardless of the size or framing of the input stream. */
export async function* chunkStream(source: AsyncIterable<Uint8Array>, fixed = false): AsyncGenerator<Uint8Array> {
  const buffer = new Uint8Array(MAX_SIZE);
  let filled = 0;
  for await (const input of source) {
    let offset = 0;
    while (offset < input.length) {
      const take = Math.min(buffer.length - filled, input.length - offset);
      buffer.set(input.subarray(offset, offset + take), filled);
      offset += take; filled += take;
      if (filled === MAX_SIZE) {
        const n = fixed ? filled : cut(buffer);
        yield buffer.slice(0, n);
        buffer.copyWithin(0, n, filled);
        filled -= n;
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
  for await (const bytes of chunkStream(source, fixed)) {
    const shard = { h: await digest(bytes), n: bytes.length };
    await store(shard, bytes);
    shards.push(shard);
  }
  return shards;
}
