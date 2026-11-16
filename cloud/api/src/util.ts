import { b64urlEncode, utf8 } from "../../shared/bytes";

export { sha256Hex, timingSafeEqual } from "../../shared/bytes";

/** base64url SHA-256 PKCE challenges and 32-byte random tokens (43 chars). */
export const TOKEN43_RE = /^[A-Za-z0-9_-]{43}$/;
/** RFC 7636 PKCE code verifiers. */
export const PKCE_VERIFIER_RE = /^[A-Za-z0-9_-]{43,128}$/;
/** Opaque base64url values from clients (OAuth state, desktop code challenge). */
export const B64URL_RE = /^[A-Za-z0-9_-]{16,256}$/;

export async function sha256B64url(s: string): Promise<string> {
	return b64urlEncode(new Uint8Array(await crypto.subtle.digest("SHA-256", utf8.encode(s))));
}

export function randomB64url(bytes: number): string {
	return b64urlEncode(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** Uniform 6-digit code, rejection-sampled. */
export function randomCode6(): string {
	const limit = 4294000000; // largest multiple of 1e6 below 2^32
	for (;;) {
		const v = crypto.getRandomValues(new Uint32Array(1))[0]!;
		if (v < limit) return String(v % 1_000_000).padStart(6, "0");
	}
}
