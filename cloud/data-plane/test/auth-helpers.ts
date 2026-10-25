import { env } from "cloudflare:workers";

const enc = new TextEncoder();
export const ISS = "http://127.0.0.1:8788";

const b64u = (b: ArrayBuffer | Uint8Array): string => {
	const u = b instanceof Uint8Array ? b : new Uint8Array(b);
	let s = "";
	for (const c of u) s += String.fromCharCode(c);
	return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const b64uJson = (v: unknown): string => b64u(enc.encode(JSON.stringify(v)));

export interface TestKey {
	kid: string;
	priv: CryptoKey;
	publicJwk: JsonWebKey & { kid: string };
}

export async function genKey(kid: string): Promise<TestKey> {
	const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
	const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
	return { kid, priv: pair.privateKey, publicJwk: { kty: "OKP", crv: "Ed25519", x: jwk.x, kid } };
}

export function installJwks(...keys: TestKey[]): void {
	(env as unknown as Record<string, string>).ULS_JWT_PUBLIC_JWKS = JSON.stringify({ keys: keys.map((k) => k.publicJwk) });
	(env as unknown as Record<string, string>).ULS_ISSUER = ISS;
}

export interface SignOpts {
	sub?: string;
	iss?: string;
	typ?: string;
	exp?: number;
	drives?: { id: string; access: string }[];
	kid?: string;
	alg?: string;
}

export async function signToken(key: TestKey, o: SignOpts = {}): Promise<string> {
	const now = Math.floor(Date.now() / 1000);
	const header = b64uJson({ alg: o.alg ?? "EdDSA", typ: "JWT", kid: o.kid ?? key.kid });
	const payload = b64uJson({
		iss: o.iss ?? ISS,
		sub: o.sub ?? "u_TESTUSER",
		sid: "s_TEST",
		org: "o_TEST",
		typ: o.typ ?? "drive",
		drives: o.drives ?? [],
		jti: crypto.randomUUID(),
		iat: now,
		exp: o.exp ?? now + 600,
	});
	const sig = await crypto.subtle.sign({ name: "Ed25519" }, key.priv, enc.encode(`${header}.${payload}`));
	return `${header}.${payload}.${b64u(sig)}`;
}

export const setAllowDev = (v: string | undefined): void => {
	(env as unknown as Record<string, string | undefined>).ULS_ALLOW_DEV_TOKEN = v;
};
