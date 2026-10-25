import { describe, expect, it } from "vitest";
import { makeWorld, signIn, pkce, type SessionBody } from "./helpers";

const json = async <T>(r: Response) => (await r.json()) as T;

describe("OTP", () => {
	it("happy path creates a session and provisions the account", async () => {
		const w = await makeWorld();
		const start = await w.call("/auth/otp/start", { json: { email: "A@Example.com" } });
		expect(start.status).toBe(200);
		expect(await json(start)).toEqual({ ok: true });
		const res = await w.call("/auth/otp/verify", { json: { email: "a@example.com", code: w.mail.code() } });
		expect(res.status).toBe(200);
		const s = await json<SessionBody>(res);
		expect(s.accountCreated).toBe(true);
		expect(s.expiresIn).toBe(900);
		expect(s.refreshToken).toMatch(/^rt_[A-Za-z0-9_-]{43}$/);
		expect(s.user.email).toBe("a@example.com");
		// second sign-in is not a creation
		const s2 = await signIn(w, "a@example.com");
		expect(s2.accountCreated).toBe(false);
		expect(w.dp.created).toHaveLength(1);
	});

	it("rejects a wrong code, and the code is single-use", async () => {
		const w = await makeWorld();
		await w.call("/auth/otp/start", { json: { email: "a@example.com" } });
		const good = w.mail.code();
		const bad = good === "000000" ? "000001" : "000000";
		const r = await w.call("/auth/otp/verify", { json: { email: "a@example.com", code: bad } });
		expect(r.status).toBe(400);
		expect(await json(r)).toEqual({ error: "invalid_code" });
		expect((await w.call("/auth/otp/verify", { json: { email: "a@example.com", code: good } })).status).toBe(200);
		expect((await w.call("/auth/otp/verify", { json: { email: "a@example.com", code: good } })).status).toBe(400);
	});

	it("locks out after 5 attempts even with the right code", async () => {
		const w = await makeWorld();
		await w.call("/auth/otp/start", { json: { email: "a@example.com" } });
		const good = w.mail.code();
		const bad = good === "000000" ? "000001" : "000000";
		for (let i = 0; i < 5; i++) expect((await w.call("/auth/otp/verify", { json: { email: "a@example.com", code: bad } })).status).toBe(400);
		expect((await w.call("/auth/otp/verify", { json: { email: "a@example.com", code: good } })).status).toBe(400);
	});

	it("expires after 10 minutes", async () => {
		const w = await makeWorld();
		await w.call("/auth/otp/start", { json: { email: "a@example.com" } });
		const code = w.mail.code();
		w.clock.t += 10 * 60_000 + 1;
		expect((await w.call("/auth/otp/verify", { json: { email: "a@example.com", code } })).status).toBe(400);
	});

	it("rate limits starts: 5 per email per hour, then 429; window resets", async () => {
		const w = await makeWorld();
		for (let i = 0; i < 5; i++) expect((await w.call("/auth/otp/start", { json: { email: "a@example.com" }, ip: "1.1.1.1" })).status).toBe(200);
		const r = await w.call("/auth/otp/start", { json: { email: "a@example.com" }, ip: "1.1.1.1" });
		expect(r.status).toBe(429);
		expect(await json(r)).toEqual({ error: "rate_limited" });
		w.clock.t += 60 * 60_000 + 1;
		expect((await w.call("/auth/otp/start", { json: { email: "a@example.com" }, ip: "1.1.1.1" })).status).toBe(200);
	});

	it("rate limits per IP (20/hour)", async () => {
		const w = await makeWorld();
		for (let i = 0; i < 20; i++) expect((await w.call("/auth/otp/start", { json: { email: `u${i}@example.com` }, ip: "9.9.9.9" })).status).toBe(200);
		expect((await w.call("/auth/otp/start", { json: { email: "other@example.com" }, ip: "9.9.9.9" })).status).toBe(429);
		expect((await w.call("/auth/otp/start", { json: { email: "other@example.com" }, ip: "8.8.8.8" })).status).toBe(200);
	});

	it("does not reveal whether an account exists", async () => {
		const w = await makeWorld();
		await signIn(w, "known@example.com");
		const a = await w.call("/auth/otp/start", { json: { email: "known@example.com" } });
		const b = await w.call("/auth/otp/start", { json: { email: "stranger@example.com" } });
		expect(a.status).toBe(b.status);
		expect(await a.text()).toBe(await b.text());
		// verify failure is identical for unknown email
		const v1 = await w.call("/auth/otp/verify", { json: { email: "nobody@example.com", code: "123456" } });
		const v2 = await w.call("/auth/otp/verify", { json: { email: "known@example.com", code: "123456" } });
		expect(v1.status).toBe(v2.status);
		expect(await v1.text()).toBe(await v2.text());
	});

	it("stores only a hash of the code", async () => {
		const w = await makeWorld();
		await w.call("/auth/otp/start", { json: { email: "a@example.com" } });
		const row = await w.env.DB.prepare("SELECT code_hash FROM otp_codes").first<{ code_hash: string }>();
		expect(row!.code_hash).toMatch(/^[0-9a-f]{64}$/);
		expect(row!.code_hash).not.toContain(w.mail.code());
	});
});

describe("provisioning", () => {
	it("creates user, My Space org, owner membership and Space drive", async () => {
		const w = await makeWorld();
		const s = await signIn(w);
		const orgs = await json<{ orgs: any[] }>(await w.call("/orgs", { token: s.accessToken }));
		expect(orgs.orgs).toHaveLength(1);
		const o = orgs.orgs[0];
		expect(o).toMatchObject({ name: "My Space", role: "owner", tier: "individual" });
		expect(o.trialEndsAt).toBeGreaterThan(Date.now() + 6 * 86_400_000);
		expect(o.drives).toHaveLength(1);
		expect(o.drives[0]).toMatchObject({ name: "Space", status: "ready", access: "admin", orgId: o.id });
		expect(o.drives[0].id).toMatch(/^d-[0-9a-z]{26}$/);
		expect(w.dp.created).toEqual([o.drives[0].id]);
	});

	it("marks provisioning_failed when createDrive fails, and retries lazily on GET /orgs", async () => {
		const w = await makeWorld();
		w.dp.failCreate = true;
		const s = await signIn(w);
		let orgs = await json<{ orgs: any[] }>(await w.call("/orgs", { token: s.accessToken }));
		expect(orgs.orgs[0].drives[0].status).toBe("provisioning_failed");
		// token minting refuses a drive that is not ready
		const id = orgs.orgs[0].drives[0].id;
		expect((await w.call(`/drives/${id}/token`, { json: {}, token: s.accessToken })).status).toBe(409);
		w.dp.failCreate = false;
		orgs = await json<{ orgs: any[] }>(await w.call("/orgs", { token: s.accessToken }));
		expect(orgs.orgs[0].drives[0].status).toBe("ready");
		expect(w.dp.created).toEqual([id]);
		const row = await w.env.DB.prepare("SELECT status FROM drives WHERE id = ?").bind(id).first<{ status: string }>();
		expect(row!.status).toBe("ready");
	});
});

describe("refresh / logout", () => {
	it("rotates the refresh token", async () => {
		const w = await makeWorld();
		const s = await signIn(w);
		const r = await w.call("/auth/refresh", { json: { refreshToken: s.refreshToken } });
		expect(r.status).toBe(200);
		const s2 = await json<SessionBody>(r);
		expect(s2.refreshToken).not.toBe(s.refreshToken);
		expect((await w.call("/me", { token: s2.accessToken })).status).toBe(200);
	});

	it("reuse of a rotated token revokes the whole family", async () => {
		const w = await makeWorld();
		const s1 = await signIn(w);
		const s2 = await json<SessionBody>(await w.call("/auth/refresh", { json: { refreshToken: s1.refreshToken } }));
		const reuse = await w.call("/auth/refresh", { json: { refreshToken: s1.refreshToken } });
		expect(reuse.status).toBe(401);
		expect(await json(reuse)).toEqual({ error: "invalid_refresh" });
		// the legitimately rotated token is dead too, and so is its access token
		expect((await w.call("/auth/refresh", { json: { refreshToken: s2.refreshToken } })).status).toBe(401);
		expect((await w.call("/me", { token: s2.accessToken })).status).toBe(401);
	});

	it("does not touch other sessions of the same user", async () => {
		const w = await makeWorld();
		const a = await signIn(w);
		const b = await signIn(w);
		await w.call("/auth/refresh", { json: { refreshToken: a.refreshToken } });
		await w.call("/auth/refresh", { json: { refreshToken: a.refreshToken } });
		expect((await w.call("/me", { token: b.accessToken })).status).toBe(200);
	});

	it("rejects garbage and expired refresh tokens", async () => {
		const w = await makeWorld();
		const s = await signIn(w);
		expect((await w.call("/auth/refresh", { json: { refreshToken: "rt_nope" } })).status).toBe(401);
		expect((await w.call("/auth/refresh", { json: {} })).status).toBe(401);
		w.clock.t += 31 * 86_400_000;
		expect((await w.call("/auth/refresh", { json: { refreshToken: s.refreshToken } })).status).toBe(401);
	});

	it("logout revokes the session", async () => {
		const w = await makeWorld();
		const s = await signIn(w);
		const r = await w.call("/auth/logout", { json: { refreshToken: s.refreshToken } });
		expect(await json(r)).toEqual({ ok: true });
		expect((await w.call("/auth/refresh", { json: { refreshToken: s.refreshToken } })).status).toBe(401);
		expect((await w.call("/me", { token: s.accessToken })).status).toBe(401);
		// logout of unknown token is still ok (no oracle)
		expect((await w.call("/auth/logout", { json: { refreshToken: "rt_x" } })).status).toBe(200);
	});
});

describe("desktop PKCE flow", () => {
	const verifier = "v".repeat(60);
	const state = "s".repeat(32);

	it("start redirects to the web app", async () => {
		const w = await makeWorld();
		const ch = await pkce(verifier);
		const r = await w.call(`/auth/desktop/start?state=${state}&code_challenge=${ch}&code_challenge_method=S256`);
		expect(r.status).toBe(302);
		const loc = new URL(r.headers.get("location")!);
		expect(loc.origin + loc.pathname).toBe("http://127.0.0.1:5173/desktop");
		expect(loc.searchParams.get("state")).toBe(state);
		expect(loc.searchParams.get("code_challenge")).toBe(ch);
		expect((await w.call(`/auth/desktop/start?state=${state}&code_challenge=${ch}&code_challenge_method=plain`)).status).toBe(400);
	});

	it("end to end, single use", async () => {
		const w = await makeWorld();
		const s = await signIn(w);
		const ch = await pkce(verifier);
		const c = await w.call("/auth/desktop/code", { json: { state, codeChallenge: ch }, token: s.accessToken });
		expect(c.status).toBe(200);
		const { code } = await json<{ code: string }>(c);
		const ex = await w.call("/auth/desktop/exchange", { json: { code, codeVerifier: verifier } });
		expect(ex.status).toBe(200);
		const ds = await json<SessionBody>(ex);
		expect(ds.user.email).toBe("a@example.com");
		expect((await w.call("/me", { token: ds.accessToken })).status).toBe(200);
		expect((await w.call("/auth/desktop/exchange", { json: { code, codeVerifier: verifier } })).status).toBe(400);
	});

	it("rejects a PKCE mismatch and burns the code", async () => {
		const w = await makeWorld();
		const s = await signIn(w);
		const { code } = await json<{ code: string }>(await w.call("/auth/desktop/code", { json: { state, codeChallenge: await pkce(verifier) }, token: s.accessToken }));
		expect((await w.call("/auth/desktop/exchange", { json: { code, codeVerifier: "w".repeat(60) } })).status).toBe(400);
		expect((await w.call("/auth/desktop/exchange", { json: { code, codeVerifier: verifier } })).status).toBe(400);
	});

	it("code needs auth and expires after 120 s", async () => {
		const w = await makeWorld();
		expect((await w.call("/auth/desktop/code", { json: { state, codeChallenge: await pkce(verifier) } })).status).toBe(401);
		const s = await signIn(w);
		const { code } = await json<{ code: string }>(await w.call("/auth/desktop/code", { json: { state, codeChallenge: await pkce(verifier) }, token: s.accessToken }));
		w.clock.t += 121_000;
		expect((await w.call("/auth/desktop/exchange", { json: { code, codeVerifier: verifier } })).status).toBe(400);
	});
});
