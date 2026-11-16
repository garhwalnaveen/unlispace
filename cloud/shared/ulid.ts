// Minimal monotonic ULID generator (no dependency). 26 chars of Crockford base32:
// 10 chars of 48-bit ms timestamp + 16 chars of 80-bit randomness.
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function encodeTime(t: number): string {
	let s = "";
	for (let i = 0; i < 10; i++) {
		s = ALPHABET[t % 32]! + s;
		t = Math.floor(t / 32);
	}
	return s;
}

function encodeRandom(n: bigint): string {
	let s = "";
	for (let i = 0; i < 16; i++) {
		s = ALPHABET[Number(n & 31n)]! + s;
		n >>= 5n;
	}
	return s;
}

function randomBits80(): bigint {
	const b = crypto.getRandomValues(new Uint8Array(10));
	let n = 0n;
	for (const x of b) n = (n << 8n) | BigInt(x);
	return n;
}

const MAX80 = (1n << 80n) - 1n;

/** Returns a generator whose output is strictly increasing within one instance. */
export function createUlid(): (now?: number) => string {
	let lastTime = -1;
	let lastRand = 0n;
	return (now = Date.now()) => {
		if (now <= lastTime) {
			now = lastTime;
			lastRand = (lastRand + 1n) & MAX80;
		} else {
			lastTime = now;
			lastRand = randomBits80();
		}
		return encodeTime(now) + encodeRandom(lastRand);
	};
}
