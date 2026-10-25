import { describe, expect, it } from "vitest";
import golden from "../../../engine/uls-chunk/tests/golden.json";
import prng from "../../../engine/uls-chunk/tests/golden_prng.json";
import { AVG_SIZE, MAX_SIZE, MIN_SIZE, chunkManifest } from "../src/chunker";
import { digest } from "../src/crypto";

const LEN = 33_554_432;
/** b[i] = ((i * 2654435761) >> 13) & 0xff with u64 wrapping (i < 2^25 so the product stays below 2^57 and BigInt-free math is exact enough: use BigInt for safety). */
function goldenInput(): Uint8Array {
	const out = new Uint8Array(LEN);
	for (let i = 0; i < LEN; i++) out[i] = Number(((BigInt(i) * 2654435761n) & 0xffffffffffffffffn) >> 13n) & 0xff;
	return out;
}
/** splitmix64 seeded 0x756c73, little-endian u64 stream truncated to LEN. */
function prngInput(): Uint8Array {
	const M = 0xffffffffffffffffn;
	let state = 0x756c73n;
	const out = new Uint8Array(LEN + 8), view = new DataView(out.buffer);
	for (let o = 0; o < LEN; o += 8) {
		state = (state + 0x9e3779b97f4a7c15n) & M;
		let z = state;
		z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & M;
		z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & M;
		z ^= z >> 31n;
		view.setBigUint64(o, z, true);
	}
	return out.subarray(0, LEN);
}
async function* feed(data: Uint8Array, piece: number): AsyncGenerator<Uint8Array> {
	for (let o = 0; o < data.length; o += piece) yield data.subarray(o, Math.min(data.length, o + piece));
}

describe("FastCDC port matches engine/uls-chunk golden vectors", () => {
	for (const [name, vector, make] of [["golden.json", golden, goldenInput], ["golden_prng.json", prng, prngInput]] as const) {
		it(`${name}: chunk lengths and hashes`, async () => {
			expect([vector.min, vector.avg, vector.max]).toEqual([MIN_SIZE, AVG_SIZE, MAX_SIZE]);
			const data = make();
			expect(data.length).toBe(vector.inputLength);
			expect(await digest(data)).toBe(vector.inputSha256);
			// Odd-sized feed pieces prove the result is independent of stream framing.
			const stored: { h: string; n: number }[] = [];
			const shards = await chunkManifest(feed(data, 1_000_003), async (s) => { stored.push(s); });
			expect(shards.map((s) => s.n)).toEqual(vector.chunks.map((c) => c.n));
			expect(shards.map((s) => s.h)).toEqual(vector.chunks.map((c) => c.h));
		});
	}
	it("chunking is independent of input framing", async () => {
		const data = prngInput().subarray(0, 9_000_000);
		const a = await chunkManifest(feed(data, 65_536), async () => {});
		const b = await chunkManifest(feed(data, data.length), async () => {});
		expect(a).toEqual(b);
		expect(a.reduce((n, s) => n + s.n, 0)).toBe(data.length);
	});
});
