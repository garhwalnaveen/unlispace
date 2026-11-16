// Byte/encoding helpers shared by the Workers. WebCrypto + globals only, no Worker imports.

export const utf8 = new TextEncoder();

export const toHex = (bytes: Uint8Array | ArrayBuffer): string =>
	Array.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");

export async function sha256Hex(data: Uint8Array | ArrayBuffer | string): Promise<string> {
	return toHex(await crypto.subtle.digest("SHA-256", typeof data === "string" ? utf8.encode(data) : data));
}

export const base64 = (bytes: Uint8Array): string => btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(""));

/** Standard base64 → bytes. Throws on invalid input (atob). */
export const fromBase64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** base64url without padding. */
export const b64urlEncode = (bytes: Uint8Array): string => base64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** base64url (padding optional) → bytes, or null for anything that is not base64url. */
export function b64urlDecode(s: string): Uint8Array | null {
	if (!/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1) return null;
	try {
		return fromBase64(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4));
	} catch {
		return null;
	}
}

/** Constant-time string equality via the runtime's native compare over SHA-256 digests (equal length, no length leak). */
export async function constantTimeEq(a: string, b: string): Promise<boolean> {
	const [da, db] = await Promise.all([crypto.subtle.digest("SHA-256", utf8.encode(a)), crypto.subtle.digest("SHA-256", utf8.encode(b))]);
	return crypto.subtle.timingSafeEqual(da, db);
}

/** Synchronous constant-time string equality (length is not secret for fixed-size hashes). */
export function timingSafeEqual(a: string, b: string): boolean {
	const x = utf8.encode(a);
	const y = utf8.encode(b);
	let diff = x.length ^ y.length;
	const n = Math.max(x.length, y.length);
	for (let i = 0; i < n; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
	return diff === 0;
}
