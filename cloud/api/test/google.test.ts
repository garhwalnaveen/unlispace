import { describe, expect, it } from "vitest";
import { b64urlEncode } from "../src/jwt";
import { makeWorld, ORIGIN, type SessionBody, type World } from "./helpers";

const CLIENT_ID = "client-123.apps.googleusercontent.com";
const enc = new TextEncoder();
const j = (o: unknown) => b64urlEncode(enc.encode(JSON.stringify(o)));

async function googleKey() {
	const kp = (await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
	const pub = (await crypto.subtle.exportKey("jwk", kp.publicKey)) as JsonWebKey;
	return { kp, jwks: { keys: [{ ...pub, kid: "g1", alg: "RS256", use: "sig" }] } };
}

async function idToken(key: CryptoKeyPair, claims: Record<string, unknown>, kid = "g1") {
	const input = j({ alg: "RS256", kid, typ: "JWT" }) + "." + j(claims);
	const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key.privateKey, enc.encode(input));
	return input + "." + b64urlEncode(new Uint8Array(sig));
}

async function setup(over: Record<string, unknown> = {}, tokenKey?: CryptoKeyPair) {
	const w = await makeWorld({ GOOGLE_CLIENT_ID: CLIENT_ID, GOOGLE_CLIENT_SECRET: "shh" });
	const g = await googleKey();
	const start = await w.call(`/auth/google/start?return=${encodeURIComponent(ORIGIN + "/app")}`);
	expect(start.status).toBe(302);
	const loc = new URL(start.headers.get("location")!);
	const nonce = loc.searchParams.get("nonce")!;
	const state = loc.searchParams.get("state")!;
	let tokenReq: URLSearchParams | null = null;
	const claims = { iss: "https://accounts.google.com", aud: CLIENT_ID, exp: Math.floor(w.clock.t / 1000) + 600, nonce, email: "g@example.com", email_verified: true, ...over };
	const id = await idToken(tokenKey ?? g.kp, claims);
	w.fetchImpl.fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input instanceof Request ? input.url : input);
		if (url === "https://oauth2.googleapis.com/token") {
			tokenReq = new URLSearchParams(String(init?.body));
			return Response.json({ id_token: id });
		}
		if (url === "https://www.googleapis.com/oauth2/v3/certs") return Response.json(g.jwks);
		return new Response("unexpected " + url, { status: 500 });
	}) as typeof fetch;
	return { w, loc, state, nonce, getTokenReq: () => tokenReq };
}

const callback = (w: World, state: string, extra = "code=abc") => w.call(`/auth/google/callback?state=${state}&${extra}`);
const fragOf = (r: Response) => new URL(r.headers.get("location")!).hash.slice(1);

describe("google oidc", () => {
	it("501 when not configured", async () => {
		const w = await makeWorld();
		expect((await w.call("/auth/google/start")).status).toBe(501);
		expect((await w.call("/auth/google/callback?state=x")).status).toBe(501);
	});

	it("start redirects with PKCE, state and nonce; return is allow-listed", async () => {
		const { loc } = await setup();
		expect(loc.origin + loc.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
		const q = loc.searchParams;
		expect(q.get("client_id")).toBe(CLIENT_ID);
		expect(q.get("response_type")).toBe("code");
		expect(q.get("code_challenge_method")).toBe("S256");
		expect(q.get("code_challenge")).toBeTruthy();
		expect(q.get("scope")).toBe("openid email");
		expect(q.get("redirect_uri")).toBe("http://127.0.0.1:8788/auth/google/callback");
		const w = await makeWorld({ GOOGLE_CLIENT_ID: CLIENT_ID, GOOGLE_CLIENT_SECRET: "s" });
		for (const bad of ["https://evil.example/", "http://127.0.0.1:5173.evil.example/", "javascript:alert(1)", "//evil.example", "http://user@127.0.0.1:5173@evil.example/"]) {
			expect((await w.call(`/auth/google/start?return=${encodeURIComponent(bad)}`)).status, bad).toBe(400);
		}
	});

	it("happy path: handoff in the fragment, exchange once, PKCE verifier sent", async () => {
		const { w, state, getTokenReq, loc } = await setup();
		const r = await callback(w, state);
		expect(r.status).toBe(302);
		expect(r.headers.get("location")!.startsWith(ORIGIN + "/app#handoff=")).toBe(true);
		const tr = getTokenReq()!;
		expect(tr.get("grant_type")).toBe("authorization_code");
		expect(tr.get("client_secret")).toBe("shh");
		const verifier = tr.get("code_verifier")!;
		const chal = b64urlEncode(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(verifier))));
		expect(chal).toBe(loc.searchParams.get("code_challenge"));

		const handoff = fragOf(r).replace("handoff=", "");
		const ex = await w.call("/auth/handoff/exchange", { json: { handoff } });
		expect(ex.status).toBe(200);
		const s = (await ex.json()) as SessionBody;
		expect(s).toMatchObject({ accountCreated: true, user: { email: "g@example.com" } });
		expect((await w.call("/auth/handoff/exchange", { json: { handoff } })).status).toBe(400);
		expect(w.dp.created).toHaveLength(1);
	});

	it("handoff expires after 60 s", async () => {
		const { w, state } = await setup();
		const handoff = fragOf(await callback(w, state)).replace("handoff=", "");
		w.clock.t += 61_000;
		expect((await w.call("/auth/handoff/exchange", { json: { handoff } })).status).toBe(400);
	});

	it("state is single use and unknown state is rejected", async () => {
		const { w, state } = await setup();
		expect((await callback(w, state)).status).toBe(302);
		expect((await callback(w, state)).status).toBe(400);
		expect((await callback(w, "bogus")).status).toBe(400);
	});

	it.each([
		["bad nonce", { nonce: "wrong" }, "invalid_nonce"],
		["bad aud", { aud: "someone-else" }, "invalid_audience"],
		["bad iss", { iss: "https://evil.example" }, "invalid_issuer"],
		["unverified email", { email_verified: false }, "email_not_verified"],
		["expired", { exp: 1 }, "token_expired"],
	])("rejects %s", async (_n, over, err) => {
		const { w, state } = await setup(over);
		const r = await callback(w, state);
		expect(r.status).toBe(302);
		expect(fragOf(r)).toBe(`error=${err}`);
		const u = await w.env.DB.prepare("SELECT COUNT(*) AS n FROM users").first<{ n: number }>();
		expect(u!.n).toBe(0);
	});

	it("rejects an id_token signed by a key that is not in Google's JWKS", async () => {
		const other = await googleKey();
		const { w, state } = await setup({}, other.kp);
		expect(fragOf(await callback(w, state))).toBe("error=invalid_token");
	});

	it("passes through user denial", async () => {
		const { w, state } = await setup();
		expect(fragOf(await callback(w, state, "error=access_denied"))).toBe("error=access_denied");
	});
});
