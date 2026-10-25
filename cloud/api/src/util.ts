import { b64urlEncode } from "./jwt";

const enc = new TextEncoder();

export async function sha256Hex(s: string): Promise<string> {
	const d = await crypto.subtle.digest("SHA-256", enc.encode(s));
	return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256B64url(s: string): Promise<string> {
	return b64urlEncode(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s))));
}

export function randomB64url(bytes: number): string {
	return b64urlEncode(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** Constant-time string equality (length is not secret for our fixed-size hashes). */
export function timingSafeEqual(a: string, b: string): boolean {
	const x = enc.encode(a);
	const y = enc.encode(b);
	let diff = x.length ^ y.length;
	const n = Math.max(x.length, y.length);
	for (let i = 0; i < n; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
	return diff === 0;
}

/** Uniform 6-digit code, rejection-sampled. */
export function randomCode6(): string {
	const limit = 4294000000; // largest multiple of 1e6 below 2^32
	for (;;) {
		const v = crypto.getRandomValues(new Uint32Array(1))[0]!;
		if (v < limit) return String(v % 1_000_000).padStart(6, "0");
	}
}
