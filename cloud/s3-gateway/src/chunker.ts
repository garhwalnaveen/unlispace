import { digest } from "./crypto";
import { GEAR_HI, GEAR_LO } from "./gear";

export const MIN_SIZE = 262_144, AVG_SIZE = 2_097_152, MAX_SIZE = 16_777_216;
export interface Shard { h: string; n: number }
// Two 32-bit lanes preserve wrapping u64 arithmetic without BigInt in the hot loop.
const SHIFT_HI = Uint32Array.from(GEAR_HI, (h, i) => (h << 1) | (GEAR_LO[i]! >>> 31));
const SHIFT_LO = Uint32Array.from(GEAR_LO, l => l << 1);
export function cut(bytes: Uint8Array): number {
  const remaining = Math.min(bytes.length, MAX_SIZE);
  if (remaining <= MIN_SIZE) return remaining;
  const center = Math.min(remaining, AVG_SIZE);
  let hi = 0, lo = 0, index = MIN_SIZE / 2;
  while (index < Math.floor(remaining / 2)) {
    const a = index * 2, small = index < Math.floor(center / 2);
    // MASKS[22] / MASKS[20], normalization level 1 for log2(avg)=21.
    const maskHi = small ? 0x0000d937 : 0x0000d917;
    const maskLo = small ? 0x67537000 : 0x47537000;
    const v = bytes[a]!;
    hi = ((hi << 2) | (lo >>> 30)) >>> 0;
    lo = (lo << 2) >>> 0;
    let sum = lo + SHIFT_LO[v]!;
    hi = (hi + SHIFT_HI[v]! + (sum > 0xffffffff ? 1 : 0)) >>> 0;
    lo = sum >>> 0;
    if ((hi & ((maskHi << 1) | (maskLo >>> 31))) === 0 && (lo & (maskLo << 1)) === 0) return a;
    const w = bytes[a + 1]!;
    sum = lo + GEAR_LO[w]!;
    hi = (hi + GEAR_HI[w]! + (sum > 0xffffffff ? 1 : 0)) >>> 0;
    lo = sum >>> 0;
    if ((hi & maskHi) === 0 && (lo & maskLo) === 0) return a + 1;
    index++;
  }
  return remaining;
}

/** One max-shard buffer regardless of the size or framing of the input stream. */
export async function* chunkStream(source: AsyncIterable<Uint8Array>): AsyncGenerator<Uint8Array> {
  const buffer = new Uint8Array(MAX_SIZE);
  let filled = 0;
  for await (const input of source) {
    let offset = 0;
    while (offset < input.length) {
      const take = Math.min(buffer.length - filled, input.length - offset);
      buffer.set(input.subarray(offset, offset + take), filled);
      offset += take; filled += take;
      if (filled === MAX_SIZE) {
        const n = cut(buffer);
        yield buffer.slice(0, n);
        buffer.copyWithin(0, n, filled);
        filled -= n;
      }
    }
  }
  let offset = 0;
  while (offset < filled) {
    const n = cut(buffer.subarray(offset, filled));
    yield buffer.slice(offset, offset + n);
    offset += n;
  }
}
export async function chunkManifest(source: AsyncIterable<Uint8Array>, store: (shard: Shard, bytes: Uint8Array) => Promise<void>): Promise<Shard[]> {
  const shards: Shard[] = [];
  for await (const bytes of chunkStream(source)) {
    const shard = { h: await digest(bytes), n: bytes.length };
    await store(shard, bytes);
    shards.push(shard);
  }
  return shards;
}
