import { describe, expect, it } from "vitest";
import { b64urlEncode, JwtError, signJwt, verifyJwt } from "../src/jwt";
import { genKey } from "./helpers";

const ISS = "http://127.0.0.1:8788";
const now = 1_800_000_000_000;
const claims = (over: Record<string, unknown> = {}) => ({ iss: ISS, sub: "u_1", typ: "access", iat: now / 1000, exp: now / 1000 + 900, ...over });
const code = async (p: Promise<unknown>) => ((await p.then(() => null, (e) => e)) as JwtError | null)?.code;

describe("jwt", () => {
	it("round-trips and sets alg/kid", async () => {
		const k = await genKey("k1");
		const t = await signJwt(k.priv, claims({ extra: 1 }));
		const hdr = JSON.parse(atob(t.split(".")[0]!.replace(/-/g, "+").replace(/_/g, "/")));
		expect(hdr).toEqual({ alg: "EdDSA", typ: "JWT", kid: "k1" });
		const c = await verifyJwt(t, { keys: [k.pub] }, { issuer: ISS, typ: "access", now });
		expect(c.sub).toBe("u_1");
		expect(c.extra).toBe(1);
	});

	it("supports multiple keys and rejects an unknown kid", async () => {
		const a = await genKey("a");
		const b = await genKey("b");
		const tb = await signJwt(b.priv, claims());
		await verifyJwt(tb, JSON.stringify({ keys: [a.pub, b.pub] }), { issuer: ISS, typ: "access", now });
		expect(await code(verifyJwt(tb, { keys: [a.pub] }, { issuer: ISS, typ: "access", now }))).toBe("unknown_kid");
	});

	it("rejects a valid kid with the wrong key material", async () => {
		const a = await genKey("same");
		const b = await genKey("same");
		const t = await signJwt(a.priv, claims());
		expect(await code(verifyJwt(t, { keys: [b.pub] }, { issuer: ISS, typ: "access", now }))).toBe("bad_signature");
	});

	it("rejects expired tokens, honouring 30 s leeway", async () => {
		const k = await genKey("k");
		const t = await signJwt(k.priv, claims());
		const o = { issuer: ISS, typ: "access" };
		await verifyJwt(t, { keys: [k.pub] }, { ...o, now: now + 900_000 + 29_000 });
		expect(await code(verifyJwt(t, { keys: [k.pub] }, { ...o, now: now + 900_000 + 30_000 }))).toBe("expired");
	});

	it("rejects wrong typ and wrong issuer", async () => {
		const k = await genKey("k");
		const t = await signJwt(k.priv, claims({ typ: "drive" }));
		expect(await code(verifyJwt(t, { keys: [k.pub] }, { issuer: ISS, typ: "access", now }))).toBe("bad_typ");
		const t2 = await signJwt(k.priv, claims({ iss: "https://evil.example" }));
		expect(await code(verifyJwt(t2, { keys: [k.pub] }, { issuer: ISS, typ: "access", now }))).toBe("bad_issuer");
	});

	it("rejects tampered payload, tampered signature, alg none and junk", async () => {
		const k = await genKey("k");
		const t = await signJwt(k.priv, claims());
		const [h, p, s] = t.split(".") as [string, string, string];
		const forged = b64urlEncode(new TextEncoder().encode(JSON.stringify(claims({ sub: "u_admin" }))));
		const o = { issuer: ISS, typ: "access", now };
		expect(await code(verifyJwt(`${h}.${forged}.${s}`, { keys: [k.pub] }, o))).toBe("bad_signature");
		expect(await code(verifyJwt(`${h}.${p}.${s.slice(0, -2)}AA`, { keys: [k.pub] }, o))).toBe("bad_signature");
		const none = b64urlEncode(new TextEncoder().encode(JSON.stringify({ alg: "none", kid: "k" })));
		expect(await code(verifyJwt(`${none}.${p}.`, { keys: [k.pub] }, o))).toBe("bad_header");
		expect(await code(verifyJwt("not.a.jwt!", { keys: [k.pub] }, o))).toBeTruthy();
		expect(await code(verifyJwt("abc", { keys: [k.pub] }, o))).toBe("malformed");
	});
});
