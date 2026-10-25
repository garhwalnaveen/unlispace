// Drive-token verification: EdDSA (Ed25519) JWTs, WebCrypto only. See docs/design/m1-contract.md §2-§3.
//
// Wire format (what the issuer in cloud/api must produce):
//   token   = b64url(header) "." b64url(payload) "." b64url(signature)       (base64url, no padding)
//   header  = {"alg":"EdDSA","typ":"JWT","kid":"<key id>"}
//   payload = {"iss","sub","sid","org","typ":"drive","drives":[{"id","access"}],"jti","iat","exp"}  (iat/exp in seconds)
//   signature = Ed25519 over the ASCII bytes of  b64url(header) "." b64url(payload)  (raw 64-byte signature)
// The JWKS is {"keys":[{"kty":"OKP","crv":"Ed25519","kid":"...","x":"..."}, ...]}; the key is picked by header `kid`.

export type Access = "read" | "write" | "admin";
export const ACCESS_RANK: Record<Access, number> = { read: 1, write: 2, admin: 3 };

export interface DriveGrant {
	id: string;
	access: Access;
}
export interface DriveClaims {
	sub: string;
	exp: number; // seconds since epoch
	drives: DriveGrant[];
}

export const LEEWAY_SECONDS = 30;
const MAX_TOKEN_CHARS = 8192;
const B64URL_RE = /^[A-Za-z0-9_-]+$/;

interface Jwk {
	kty?: string;
	crv?: string;
	kid?: string;
	x?: string;
}

function b64urlDecode(s: string): Uint8Array | null {
	if (!B64URL_RE.test(s) || s.length % 4 === 1) return null;
	try {
		const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
		return Uint8Array.from(bin, (c) => c.charCodeAt(0));
	} catch {
		return null;
	}
}

function parseJsonPart(s: string): Record<string, unknown> | null {
	const bytes = b64urlDecode(s);
	if (!bytes) return null;
	try {
		const v: unknown = JSON.parse(new TextDecoder().decode(bytes));
		return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

// Imported keys are cached per isolate, keyed by kid + public key bytes so a rotated JWKS never serves a stale key.
const keyCache = new Map<string, Promise<CryptoKey | null>>();

async function importKey(jwk: Jwk): Promise<CryptoKey | null> {
	const cacheKey = `${jwk.kid}\n${jwk.x}`;
	let p = keyCache.get(cacheKey);
	if (!p) {
		p = crypto.subtle
			.importKey("jwk", { kty: "OKP", crv: "Ed25519", x: jwk.x! }, { name: "Ed25519" }, false, ["verify"])
			.catch(() => null);
		keyCache.set(cacheKey, p);
		if (keyCache.size > 32) keyCache.delete(keyCache.keys().next().value!);
	}
	return p;
}

let parsedJwks: { raw: string; keys: Jwk[] } | null = null;
function jwksKeys(raw: string): Jwk[] {
	if (parsedJwks?.raw === raw) return parsedJwks.keys;
	let keys: Jwk[] = [];
	try {
		const v = JSON.parse(raw) as { keys?: unknown };
		if (Array.isArray(v.keys)) keys = v.keys.filter((k): k is Jwk => k !== null && typeof k === "object");
	} catch {
		// malformed JWKS: no keys, every token fails closed
	}
	parsedJwks = { raw, keys };
	return keys;
}

export interface VerifyOptions {
	jwks: string | undefined;
	issuer: string | undefined;
	/** epoch milliseconds, injectable for tests */
	now?: number;
}

/** Returns the claims of a valid drive token, or null for any failure (callers answer 401). */
export async function verifyDriveToken(token: string, opts: VerifyOptions): Promise<DriveClaims | null> {
	if (!opts.jwks || !opts.issuer || token.length > MAX_TOKEN_CHARS) return null;
	const parts = token.split(".");
	if (parts.length !== 3) return null;
	const [h, p, s] = parts as [string, string, string];

	const header = parseJsonPart(h);
	if (!header || header.alg !== "EdDSA" || typeof header.kid !== "string") return null;
	const jwk = jwksKeys(opts.jwks).find((k) => k.kid === header.kid && k.kty === "OKP" && k.crv === "Ed25519" && typeof k.x === "string");
	if (!jwk) return null;
	const sig = b64urlDecode(s);
	if (!sig || sig.length !== 64) return null;
	const key = await importKey(jwk);
	if (!key) return null;
	let valid = false;
	try {
		valid = await crypto.subtle.verify({ name: "Ed25519" }, key, sig, new TextEncoder().encode(`${h}.${p}`));
	} catch {
		return null;
	}
	if (!valid) return null;

	const c = parseJsonPart(p);
	if (!c) return null;
	const nowSec = (opts.now ?? Date.now()) / 1000;
	if (c.iss !== opts.issuer || c.typ !== "drive") return null;
	if (typeof c.exp !== "number" || !Number.isFinite(c.exp) || c.exp + LEEWAY_SECONDS <= nowSec) return null;
	if (typeof c.nbf === "number" && c.nbf - LEEWAY_SECONDS > nowSec) return null;
	if (typeof c.sub !== "string" || c.sub === "" || c.sub.length > 128) return null;
	if (!Array.isArray(c.drives)) return null;
	const drives: DriveGrant[] = [];
	for (const d of c.drives as unknown[]) {
		const g = d as { id?: unknown; access?: unknown } | null;
		if (g && typeof g.id === "string" && (g.access === "read" || g.access === "write" || g.access === "admin")) {
			drives.push({ id: g.id, access: g.access });
		}
	}
	return { sub: c.sub, exp: c.exp, drives };
}
