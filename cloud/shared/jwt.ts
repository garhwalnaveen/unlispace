// EdDSA (Ed25519) JWT sign/verify using WebCrypto only, shared by the control plane (cloud/api),
// the data plane's drive-token check and the S3 gateway's token minter.

import { b64urlDecode, b64urlEncode, utf8 } from "./bytes";

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
	/** Claim that rejects a token from the future: `iat` (control plane, default) or `nbf` (data plane). */
	notBefore?: "iat" | "nbf";
	/** Require the raw signature to be exactly this many bytes (the data plane requires 64). */
	sigLength?: number;
	/** Compare times against fractional seconds instead of whole seconds (the data plane's behavior). */
	fractionalNow?: boolean;
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

const dec = new TextDecoder();
const MAX_TOKEN_CHARS = 8192;
const KEY_CACHE_MAX = 32;

export { b64urlEncode };

/** base64url → bytes, throwing JwtError("malformed") on bad input. */
export function b64urlDecodeOrThrow(s: string): Uint8Array {
	const out = b64urlDecode(s);
	if (!out) throw new JwtError("malformed", "bad base64url");
	return out;
}

// Imported keys are cached per isolate, keyed by kid + key bytes so a rotated JWKS never serves a stale key. Bounded.
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
		if (cache.size > KEY_CACHE_MAX) cache.delete(cache.keys().next().value!);
	}
	return p;
}

let parsedJwks: { raw: string; keys: Jwk[] } | null = null;
function jwksKeys(jwks: Jwks | string): Jwk[] {
	if (typeof jwks !== "string") return jwks.keys;
	if (parsedJwks?.raw === jwks) return parsedJwks.keys;
	let keys: Jwk[] = [];
	try {
		const v = JSON.parse(jwks) as { keys?: unknown };
		if (Array.isArray(v.keys)) keys = v.keys.filter((k): k is Jwk => k !== null && typeof k === "object");
	} catch {
		// malformed JWKS: no keys, every token fails closed
	}
	parsedJwks = { raw: jwks, keys };
	return keys;
}

/** Sign claims with an Ed25519 private JWK. The JWK must carry a `kid`. */
export async function signJwt(privateJwk: Jwk, claims: JwtClaims): Promise<string> {
	if (!privateJwk.kid) throw new Error("private JWK has no kid");
	const header = { alg: "EdDSA", typ: "JWT", kid: privateJwk.kid };
	const input = b64urlEncode(utf8.encode(JSON.stringify(header))) + "." + b64urlEncode(utf8.encode(JSON.stringify(claims)));
	const key = await importEd25519(privateJwk, "sign");
	const sig = await crypto.subtle.sign({ name: "Ed25519" }, key, utf8.encode(input));
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
 * Checks: alg == EdDSA, signature, iss, typ claim, exp and iat/nbf with leeway. Throws JwtError.
 */
export async function verifyJwt(token: string, jwks: Jwks | string, opts: VerifyOptions): Promise<JwtClaims> {
	const parts = token.split(".");
	if (parts.length !== 3 || token.length > MAX_TOKEN_CHARS) throw new JwtError("malformed");
	const [h, p, s] = parts as [string, string, string];
	const header = parseJson(b64urlDecodeOrThrow(h));
	if (header.alg !== "EdDSA" || typeof header.kid !== "string") throw new JwtError("bad_header");

	const jwk = jwksKeys(jwks).find((k) => k.kid === header.kid && k.kty === "OKP" && k.crv === "Ed25519" && typeof k.x === "string");
	if (!jwk) throw new JwtError("unknown_kid");

	const sig = b64urlDecodeOrThrow(s);
	if (opts.sigLength !== undefined && sig.length !== opts.sigLength) throw new JwtError("bad_signature");
	const key = await importEd25519(jwk, "verify");
	const ok = await crypto.subtle.verify({ name: "Ed25519" }, key, sig, utf8.encode(h + "." + p));
	if (!ok) throw new JwtError("bad_signature");

	const claims = parseJson(b64urlDecodeOrThrow(p)) as JwtClaims;
	if (claims.iss !== opts.issuer) throw new JwtError("bad_issuer");
	if (claims.typ !== opts.typ) throw new JwtError("bad_typ");
	const nowMs = opts.now ?? Date.now();
	const nowSec = opts.fractionalNow ? nowMs / 1000 : Math.floor(nowMs / 1000);
	const leeway = opts.leewaySec ?? 30;
	if (typeof claims.exp !== "number" || !Number.isFinite(claims.exp) || claims.exp + leeway <= nowSec) throw new JwtError("expired");
	const nb = claims[opts.notBefore ?? "iat"];
	if (typeof nb === "number" && nb - leeway > nowSec) throw new JwtError("not_yet_valid");
	if (typeof claims.sub !== "string" || !claims.sub) throw new JwtError("malformed", "missing sub");
	return claims;
}
