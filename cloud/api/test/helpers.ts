import { env as rawEnv } from "cloudflare:workers";
import { handle } from "../src/index";
import type { AppEnv, DataPlaneAdmin } from "../src/env";
import type { EmailSender } from "../src/email";
import type { Jwk } from "../src/jwt";
import { b64urlEncode } from "../src/jwt";
import type { DodoPayments } from "../src/dodo";

export const ORIGIN = "http://127.0.0.1:5173";
const BASE = "http://127.0.0.1:8788";

export async function genKey(kid: string): Promise<{ priv: Jwk; pub: Jwk }> {
	const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
	const priv = { ...((await crypto.subtle.exportKey("jwk", kp.privateKey)) as Jwk), kid };
	const { d: _d, ...pub } = priv;
	return { priv, pub };
}

export class FakeDataPlane implements DataPlaneAdmin {
	created: string[] = [];
	deleted: string[] = [];
	failCreate = false;
	stats = new Map<string, number>();
	failStats = false;
	async createDrive(driveId: string) {
		if (this.failCreate) throw new Error("data plane down");
		this.created.push(driveId);
		return { driveId, placement: null, createdAt: Date.now() };
	}
	async deleteDrive(driveId: string) {
		this.deleted.push(driveId);
		return { ok: true as const };
	}
	async driveStats(driveId: string) {
		if (this.failStats) throw new Error("data plane down");
		return { headSeq: 0, fileCount: 0, bytes: this.stats.get(driveId) ?? 0 };
	}
}

export class MemSender implements EmailSender {
	sent: { to: string; subject: string; text: string }[] = [];
	async send(to: string, subject: string, text: string) {
		this.sent.push({ to, subject, text });
	}
	code(to?: string): string {
		const m = [...this.sent].reverse().find((s) => !to || s.to === to);
		return /(\d{6})/.exec(m!.text)![1]!;
	}
}

export interface World {
	env: AppEnv;
	dp: FakeDataPlane;
	mail: MemSender;
	keys: { priv: Jwk; pub: Jwk };
	clock: { t: number };
	fetchImpl: { fn: typeof fetch };
	dodoImpl: { client?: DodoPayments };
	call(path: string, init?: RequestInit & { json?: unknown; token?: string | null; ip?: string; origin?: string }): Promise<Response>;
}

export async function makeWorld(extra: Partial<AppEnv> = {}): Promise<World> {
	const keys = await genKey("test-key-1");
	const dp = new FakeDataPlane();
	const mail = new MemSender();
	const clock = { t: Date.now() };
	const fetchImpl = { fn: (async () => new Response("no fetch stub", { status: 500 })) as typeof fetch };
	const dodoImpl: { client?: DodoPayments } = {};
	const base = rawEnv as unknown as AppEnv;
	const env: AppEnv = {
		...base,
		DB: base.DB,
		DATA_PLANE: dp,
		ULS_ISSUER: BASE,
		ULS_DATA_ENDPOINT: "http://127.0.0.1:8787",
		ULS_WEB_ORIGIN: ORIGIN,
		ULS_JWT_PRIVATE_JWK: JSON.stringify(keys.priv),
		ULS_JWT_PUBLIC_JWKS: JSON.stringify({ keys: [keys.pub] }),
		...extra,
	};
	return {
		env,
		dp,
		mail,
		keys,
		clock,
		fetchImpl,
		dodoImpl,
		call(path, init = {}) {
			const { json, token, ip, origin, ...rest } = init;
			const headers = new Headers(rest.headers);
			if (token) headers.set("authorization", `Bearer ${token}`);
			if (ip) headers.set("cf-connecting-ip", ip);
			if (origin) headers.set("origin", origin);
			if (json !== undefined) {
				headers.set("content-type", "application/json");
				rest.body = JSON.stringify(json);
				rest.method ??= "POST";
			}
			return handle(new Request(BASE + path, { ...rest, headers, redirect: "manual" }), env, {
				now: () => clock.t,
				email: mail,
				fetch: ((...a: Parameters<typeof fetch>) => fetchImpl.fn(...a)) as typeof fetch,
				dodo: dodoImpl.client,
			});
		},
	};
}

export interface SessionBody {
	accessToken: string;
	refreshToken: string;
	expiresIn: number;
	user: { id: string; email: string };
	accountCreated: boolean;
}

export async function signIn(w: World, email = "a@example.com"): Promise<SessionBody> {
	await w.call("/auth/otp/start", { json: { email } });
	const res = await w.call("/auth/otp/verify", { json: { email, code: w.mail.code(email) } });
	if (res.status !== 200) throw new Error("signIn failed " + res.status);
	return (await res.json()) as SessionBody;
}

export const pkce = async (verifier: string) => b64urlEncode(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
