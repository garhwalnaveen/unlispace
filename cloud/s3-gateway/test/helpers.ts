import { env } from "cloudflare:workers";
import type { HttpHandlerOptions, HttpRequest, HttpResponse } from "@smithy/types";
import { S3Client } from "@aws-sdk/client-s3";
import { createHash, createHmac } from "node:crypto";
import { MemoryKeyResolver, type KeyRecord } from "../src/auth";
import { Ed25519TokenMinter, type DriveAdmin } from "../src/data-plane";
import { handle, type Deps } from "../src/index";
import { BoundState } from "../src/state";
import { FakeDataPlane } from "./fake-data-plane";

/** Minimal SHA-256 / HMAC-SHA-256 for @smithy/signature-v4 (avoids a direct @aws-crypto dependency). */
class Sha256 {
	private chunks: Uint8Array[] = [];
	constructor(private readonly secret?: string | ArrayBuffer | ArrayBufferView) {}
	update(data: string | ArrayBuffer | ArrayBufferView): void { this.chunks.push(typeof data === "string" ? new TextEncoder().encode(data) : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data)); }
	async digest(): Promise<Uint8Array> {
		const h = this.secret === undefined ? createHash("sha256") : createHmac("sha256", typeof this.secret === "string" ? this.secret : ArrayBuffer.isView(this.secret) ? new Uint8Array(this.secret.buffer, this.secret.byteOffset, this.secret.byteLength) : new Uint8Array(this.secret));
		for (const c of this.chunks) h.update(c);
		return new Uint8Array(h.digest());
	}
	reset(): void { this.chunks = []; }
}

export const KEY_ID = "ULS1ABCDEFGHJKLMNPQR";
export const READ_KEY_ID = "ULS1READONLYREADONLY";
const MASTER = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
export const records: KeyRecord[] = [
	{ keyId: KEY_ID, subject: "user-1", orgId: "org-1", scope: "admin" },
	{ keyId: READ_KEY_ID, subject: "user-2", orgId: "org-1", scope: "read" },
];
export const resolver = new MemoryKeyResolver(MASTER, records);
export const secretOf = async (id: string): Promise<string> => (await resolver.resolve(id))!.secretAccessKey;

export interface Harness {
	deps: Deps;
	dp: FakeDataPlane;
	/** Raw JWTs the gateway presented to the data plane. */
	tokens: string[];
	now: { value: number };
}

let counter = 0;
/** A fresh drive id (bucket) per call: the S3State Durable Object is shared within a test file. */
export const bucketName = (prefix = "bkt"): string => `${prefix}-${Date.now().toString(36)}-${(counter++).toString(36)}`;

export async function harness(): Promise<Harness> {
	const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
	const jwk = { ...(await crypto.subtle.exportKey("jwk", pair.privateKey)), kid: "test-kid" } as JsonWebKey & { kid: string };
	const dp = new FakeDataPlane();
	const now = { value: Date.now() };
	const admin: DriveAdmin = {
		async createDrive(drive) {
			if (dp.drives.has(drive)) throw Object.assign(new Error(`drive_exists: ${drive}`), { name: "DriveExistsError" });
			dp.createDrive(drive);
			return { driveId: drive, placement: "", createdAt: 0 };
		},
		async deleteDrive(drive) { dp.drives.delete(drive); return { ok: true }; },
	};
	const deps: Deps = {
		resolver,
		tokens: new Ed25519TokenMinter(jwk, "http://issuer.test"),
		dataPlane: dp,
		admin,
		state: new BoundState(env.S3_STATE.get(env.S3_STATE.idFromName("test"))),
		host: "s3.test",
		now: () => now.value,
	};
	return { deps, dp, tokens: dp.tokens, now };
}

/** Routes SDK requests straight into the gateway's request handler. */
export function requestHandler(deps: Deps, observe?: (r: Request) => void) {
	return {
		metadata: { handlerProtocol: "http/1.1" },
		destroy() {},
		updateHttpClientConfig() {},
		httpHandlerConfigs: () => ({}),
		async handle(request: HttpRequest, _options: HttpHandlerOptions = {}): Promise<{ response: HttpResponse }> {
			const query = new URLSearchParams();
			for (const [k, v] of Object.entries(request.query ?? {})) for (const x of Array.isArray(v) ? v : [v]) query.append(k, x ?? "");
			const qs = query.size ? `?${query.toString().replace(/\+/g, "%20")}` : "";
			const body = request.body;
			const init: RequestInit & { duplex?: string } = { method: request.method, headers: request.headers as Record<string, string> };
			if (body !== undefined && body !== null && request.method !== "GET" && request.method !== "HEAD") {
				if (typeof body === "string" || body instanceof Uint8Array) init.body = body;
				else {
					// The SDK's aws-chunked encoder emits strings and byte arrays; a Request body stream may only carry bytes.
					const encoder = new TextEncoder();
					init.body = (body as ReadableStream<string | Uint8Array>).pipeThrough(new TransformStream<string | Uint8Array, Uint8Array>({ transform(chunk, controller) { controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk); } }));
					init.duplex = "half";
				}
			}
			const req = new Request(`${request.protocol}//${request.hostname}${request.path}${qs}`, init);
			observe?.(req);
			const res = await handle(req, deps);
			const headers: Record<string, string> = {};
			res.headers.forEach((v, k) => { headers[k] = v; });
			return { response: { statusCode: res.status, reason: res.statusText, headers, body: res.body ?? undefined } as unknown as HttpResponse };
		},
	};
}

export function client(deps: Deps, opts: { keyId?: string; secret?: string; protocol?: "http" | "https"; observe?: (r: Request) => void } = {}): Promise<S3Client> {
	return (async () => new S3Client({
		region: "auto",
		endpoint: `${opts.protocol ?? "https"}://s3.test`,
		forcePathStyle: true,
		credentials: { accessKeyId: opts.keyId ?? KEY_ID, secretAccessKey: opts.secret ?? await secretOf(opts.keyId ?? KEY_ID) },
		requestHandler: requestHandler(deps, opts.observe),
		maxAttempts: 1,
	}))();
}

export const text = (s: string): Uint8Array => new TextEncoder().encode(s);
export const readAll = async (body: { transformToByteArray(): Promise<Uint8Array> } | undefined): Promise<Uint8Array> => body!.transformToByteArray();
export const readText = async (body: { transformToString(): Promise<string> } | undefined): Promise<string> => body!.transformToString();

/** Creates a bucket directly in the fake (the CreateBucket route has its own test). */
export function makeBucket(h: Harness, name = bucketName()): string { h.dp.createDrive(name); return name; }

export function randomBytes(n: number, seed = 1): Uint8Array {
	const out = new Uint8Array(n);
	let s = seed >>> 0 || 1;
	for (let i = 0; i < n; i++) { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; out[i] = s & 255; }
	return out;
}

/** Signs a raw request (no SDK) so tests can build malformed bodies. */
export async function rawSigned(h: Harness, method: string, pathAndQuery: string, opts: { headers?: Record<string, string>; body?: BodyInit | null; payloadHash?: string; keyId?: string } = {}): Promise<Request> {
	const { SignatureV4 } = await import("@smithy/signature-v4");
	const keyId = opts.keyId ?? KEY_ID;
	const signer = new SignatureV4({ service: "s3", region: "auto", sha256: Sha256, credentials: { accessKeyId: keyId, secretAccessKey: await secretOf(keyId) }, uriEscapePath: false, applyChecksum: false });
	const u = new URL(`https://s3.test${pathAndQuery}`);
	const query: Record<string, string> = {};
	u.searchParams.forEach((v, k) => { query[k] = v; });
	const headers: Record<string, string> = { host: "s3.test", "x-amz-content-sha256": opts.payloadHash ?? "UNSIGNED-PAYLOAD", ...opts.headers };
	const signed = await signer.sign({ method, protocol: "https:", hostname: "s3.test", path: u.pathname, query, headers }, { signingDate: new Date(h.now.value) });
	const { host: _host, ...rest } = signed.headers as Record<string, string>;
	return new Request(u, { method, headers: rest, body: opts.body ?? null });
}
