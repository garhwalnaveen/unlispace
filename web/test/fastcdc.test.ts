import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { chunkRanges, chunkLength, MIN_CHUNK, MAX_CHUNK } from "../src/fastcdc";
const vector = (name: string) => JSON.parse(readFileSync(resolve(process.cwd(), `../engine/uls-chunk/tests/${name}.json`), "utf8")) as { inputLength: number; inputSha256: string; chunks: { n: number; h: string }[] };
const sha = async (bytes: Uint8Array<ArrayBuffer>) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) => byte.toString(16).padStart(2, "0")).join("");
for (const name of ["golden", "golden_prng"]) {
  it(`matches Rust ${name} boundaries and SHA-256`, async () => {
    const golden = vector(name);
    const bytes = new Uint8Array(golden.inputLength);
    if (name === "golden") {
      // Only product bits 13..20 enter a byte; imul preserves them exactly.
      for (let i = 0; i < bytes.length; i++) bytes[i] = (Math.imul(i, 2654435761) >>> 13) & 255;
    } else {
      let state = 0x756c73n;
      const wrap = (n: bigint) => BigInt.asUintN(64, n);
      const view = new DataView(bytes.buffer);
      for (let i = 0; i < bytes.length; i += 8) {
        state = wrap(state + 0x9e3779b97f4a7c15n);
        let z = state;
        z = wrap((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n);
        z = wrap((z ^ (z >> 27n)) * 0x94d049bb133111ebn);
        z ^= z >> 31n;
        view.setBigUint64(i, z, true);
      }
    }
    expect(await sha(bytes)).toBe(golden.inputSha256);
    const chunks = [];
    for (const { offset, length } of chunkRanges(bytes)) chunks.push({ n: length, h: await sha(bytes.subarray(offset, offset + length)) });
    expect(chunks).toEqual(golden.chunks);
  }, 30_000);
}
it("handles empty, tiny, odd-sized and maximum-sized data", () => {
  for (const size of [0, 1, MIN_CHUNK, MIN_CHUNK + 1, MAX_CHUNK, MAX_CHUNK + 1]) {
    const bytes = new Uint8Array(size);
    const ranges = chunkRanges(bytes);
    expect(ranges.reduce((sum, c) => sum + c.length, 0)).toBe(size);
    expect(ranges.every((c) => c.length <= MAX_CHUNK && c.length > 0)).toBe(true);
  }
  expect(chunkLength(new Uint8Array(0))).toBe(0);
});
