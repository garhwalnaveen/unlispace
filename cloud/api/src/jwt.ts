// EdDSA (Ed25519) JWT sign/verify using WebCrypto only.
// No Worker-specific imports: this file is meant to be copied verbatim into the data plane
// (and runs unchanged on Node 20+ / browsers).

export interface Jwk {
	kty: string;
	crv?: string;
	x?: string;
	d?: string;
	kid?: string;
	alg?: string;
	use?: string;
	[k: string]: unknown;
}
export interface Jwks {
	keys: Jwk[];
}
export interface JwtClaims {
	iss: string;
	sub: string;
	typ: string;
	iat: number; // seconds
	exp: number; // seconds
	[k: string]: unknown;
}
export interface VerifyOptions {
	issuer: string;
	/** Required value of the `typ` claim, e.g. "access" or "drive". */
	typ: string;
	/** Override "now" (epoch milliseconds). Default Date.now(). */
	now?: number;
	/** Clock leeway in seconds. Default 30. */
	leewaySec?: number;
}

export type JwtErrorCode =
	| "malformed"
	| "bad_header"
	| "unknown_kid"
	| "bad_signature"
	| "bad_issuer"
	| "bad_typ"
	| "expired"
	| "not_yet_valid";

export class JwtError extends Error {
	constructor(public code: JwtErrorCode, message?: string) {
		super(message ?? code);
		this.name = "JwtError";
	}
}

const enc = new TextEncoder();
const dec = new TextDecoder();

export function b64urlEncode(bytes: Uint8Array): string {
	let s = "";
	for (const b of bytes) s += String.fromCharCode(b);
	return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecode(s: string): Uint8Array {
	if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new JwtError("malformed", "bad base64url");
	const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4));
	const out = new Uint8Array(b.length);
	for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
	return out;
}

const signKeyCache = new Map<string, Promise<CryptoKey>>();
const verifyKeyCache = new Map<string, Promise<CryptoKey>>();

function importEd25519(jwk: Jwk, usage: "sign" | "verify"): Promise<CryptoKey> {
	const cache = usage === "sign" ? signKeyCache : verifyKeyCache;
	const id = JSON.stringify([jwk.kid, jwk.x, usage === "sign" ? jwk.d : undefined]);
	let p = cache.get(id);
	if (!p) {
		// Strip kid/alg/use so engines don't reject on metadata mismatches.
		const clean: JsonWebKey = { kty: jwk.kty, crv: jwk.crv, x: jwk.x };
		if (usage === "sign") clean.d = jwk.d;
		p = crypto.subtle.importKey("jwk", clean, { name: "Ed25519" }, false, [usage]);
		p.catch(() => cache.delete(id));
		cache.set(id, p);
	}
	return p;
}

/** Sign claims with an Ed25519 private JWK. The JWK must carry a `kid`. */
export async function signJwt(privateJwk: Jwk, claims: JwtClaims): Promise<string> {
	if (!privateJwk.kid) throw new Error("private JWK has no kid");
	const header = { alg: "EdDSA", typ: "JWT", kid: privateJwk.kid };
	const input = b64urlEncode(enc.encode(JSON.stringify(header))) + "." + b64urlEncode(enc.encode(JSON.stringify(claims)));
	const key = await importEd25519(privateJwk, "sign");
	const sig = await crypto.subtle.sign({ name: "Ed25519" }, key, enc.encode(input));
	return input + "." + b64urlEncode(new Uint8Array(sig));
}

function parseJson(bytes: Uint8Array): Record<string, unknown> {
	let v: unknown;
	try {
		v = JSON.parse(dec.decode(bytes));
	} catch {
		throw new JwtError("malformed", "bad json");
	}
	if (typeof v !== "object" || v === null || Array.isArray(v)) throw new JwtError("malformed", "not an object");
	return v as Record<string, unknown>;
}

/**
 * Verify a compact JWT. `jwks` is the public key set ({keys:[...]}, or its JSON string); the key is
 * selected by the header `kid`, so several keys can be live at once (rotation).
 * Checks: alg == EdDSA, signature, iss, typ claim, exp/nbf with leeway. Throws JwtError.
 */
export async function verifyJwt(token: string, jwks: Jwks | string, opts: VerifyOptions): Promise<JwtClaims> {
	const parts = token.split(".");
	if (parts.length !== 3 || token.length > 8192) throw new JwtError("malformed");
	const [h, p, s] = parts as [string, string, string];
	const header = parseJson(b64urlDecode(h));
	if (header.alg !== "EdDSA" || typeof header.kid !== "string") throw new JwtError("bad_header");

	const set: Jwks = typeof jwks === "string" ? (JSON.parse(jwks) as Jwks) : jwks;
	const jwk = set.keys.find((k) => k.kid === header.kid && k.kty === "OKP" && k.crv === "Ed25519");
	if (!jwk) throw new JwtError("unknown_kid");

	const key = await importEd25519(jwk, "verify");
	const sig = b64urlDecode(s);
	const ok = await crypto.subtle.verify({ name: "Ed25519" }, key, sig, enc.encode(h + "." + p));
	if (!ok) throw new JwtError("bad_signature");

	const claims = parseJson(b64urlDecode(p)) as JwtClaims;
	if (claims.iss !== opts.issuer) throw new JwtError("bad_issuer");
	if (claims.typ !== opts.typ) throw new JwtError("bad_typ");
	const nowSec = Math.floor((opts.now ?? Date.now()) / 1000);
	const leeway = opts.leewaySec ?? 30;
	if (typeof claims.exp !== "number" || claims.exp + leeway <= nowSec) throw new JwtError("expired");
	if (typeof claims.iat === "number" && claims.iat - leeway > nowSec) throw new JwtError("not_yet_valid");
	if (typeof claims.sub !== "string" || !claims.sub) throw new JwtError("malformed", "missing sub");
	return claims;
}
