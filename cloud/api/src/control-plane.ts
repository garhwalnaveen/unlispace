import { WorkerEntrypoint } from "cloudflare:workers";
import type { AppEnv } from "./env";
import type { Ctx } from "./ctx";
import { selectSender } from "./email";
import { HttpError } from "./http";
import { createKey, recordAccessKeyUse, resolveAccessKey, type PublicKey } from "./access-keys";
import * as R from "./resources";
import { entitlements, storageUsage } from "./entitlements";
import { mintDriveToken } from "./session";

export function rpcContext(env: AppEnv): Ctx {
	const req = new Request("https://internal/");
	const f = fetch.bind(globalThis);
	return { env, req, url: new URL(req.url), now: Date.now(), fetch: f, email: selectSender(env, f) };
}
type Key = NonNullable<Awaited<ReturnType<ControlPlane["resolveKey"]>>>;
type Options = Record<string, unknown>;
const rank = { read: 0, write: 1, admin: 2 };

export class ControlPlane extends WorkerEntrypoint<AppEnv> {
	#context() { return rpcContext(this.env); }
	async resolveKey(id: string) {
		try {
			const k = await resolveAccessKey(this.#context(), id);
			return { accessKeyId: k.accessKeyId, orgId: k.workspaceId, userId: k.userId, access: k.access, drives: k.drives, secretAccessKey: k.secretAccessKey, parent: k.parent };
		} catch (e) {
			if (e instanceof HttpError && [401, 404].includes(e.status)) return null;
			throw e;
		}
	}
	async #key(id: string) {
		const k = await this.resolveKey(id);
		if (!k) throw new HttpError(403, "access_denied");
		return k;
	}
	#admin(k: Key) { if (k.access !== "admin") throw new HttpError(403, "access_denied"); }
	async #bucket(ctx: Ctx, k: Key, bucket: string) {
		const byId = /^d-[0-9a-z]{26}$/.test(bucket);
		const row = await ctx.env.DB.prepare(`SELECT d.*,m.role,o.tier FROM drives d JOIN memberships m ON m.org_id=d.org_id AND m.user_id=? JOIN orgs o ON o.id=d.org_id WHERE d.org_id=? AND d.${byId ? "id" : "alias"}=? AND d.status!='deleted'`).bind(k.userId, k.orgId, bucket).first<R.DriveRow>();
		if (!row || (k.drives !== null && !k.drives.includes(row.id))) throw new HttpError(404, "no_such_bucket");
		return row;
	}
	async #info(ctx: Ctx, k: Key, d: R.DriveRow) {
		const e = await entitlements(ctx, k.orgId);
		return { driveId: d.id, alias: d.alias, displayName: d.name, placement: d.placement, createdAt: d.created_at, access: k.access, writable: k.access !== "read" && e.writable && await storageUsage(ctx, k.orgId) <= e.quotaBytes };
	}
	#authed(k: Key) { return { userId: k.userId, email: "", sid: k.accessKeyId }; }
	#body(ctx: Ctx, body: Options, hard = false) {
		ctx.req = new Request(`https://internal/${hard ? "?hard=1" : ""}`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
		ctx.url = new URL(ctx.req.url);
	}
	async #mutation<T>(fn: () => Promise<T>): Promise<T> {
		try { return await fn(); } catch (e) {
			if (e instanceof HttpError) {
				const code = ({ alias_taken: "bucket_exists", bad_request: "invalid_argument", forbidden: "access_denied", no_such_drive: "no_such_bucket", no_such_org: "access_denied", drive_not_ready: "access_denied", invalid_key: "access_denied" } as Record<string, string>)[e.code];
				if (code) throw new HttpError(e.status, code);
			}
			throw e;
		}
	}
	async recordKeyUse(id: string): Promise<void> {
		await this.#key(id);
		await recordAccessKeyUse(this.#context(), id);
	}
	async listDrives(id: string) {
		const k = await this.#key(id), ctx = this.#context();
		const rows = (await ctx.env.DB.prepare("SELECT d.*,m.role,o.tier FROM drives d JOIN memberships m ON m.org_id=d.org_id AND m.user_id=? JOIN orgs o ON o.id=d.org_id WHERE d.org_id=? AND d.status!='deleted' ORDER BY d.created_at,d.id").bind(k.userId, k.orgId).all<R.DriveRow>()).results;
		return Promise.all(rows.filter(d => k.drives === null || k.drives.includes(d.id)).map(d => this.#info(ctx, k, d)));
	}
	async resolveBucket(id: string, bucket: string) {
		const k = await this.#key(id), ctx = this.#context();
		return this.#info(ctx, k, await this.#bucket(ctx, k, bucket));
	}
	async createDrive(id: string, opts: { alias: string; displayName?: string; placement?: string }) {
		const k = await this.#key(id), ctx = this.#context(); this.#admin(k);
		// A scoped key cannot create a new drive outside its own reach.
		if (k.drives !== null) throw new HttpError(403, "access_denied");
		return this.#mutation(async () => {
			this.#body(ctx, { name: opts.displayName ?? opts.alias, alias: opts.alias, placement: opts.placement });
			R.validateAlias(opts.alias);
			const d = await (await R.createDrive(ctx, this.#authed(k), k.orgId)).json() as { id: string };
			return this.#info(ctx, k, await R.loadDrive(ctx, this.#authed(k), d.id));
		});
	}
	async forkDrive(id: string, opts: { source: string; alias: string }) {
		const k = await this.#key(id), ctx = this.#context(); this.#admin(k);
		const source = await this.#bucket(ctx, k, opts.source);
		return this.#mutation(async () => {
			R.validateAlias(opts.alias);
			this.#body(ctx, { name: opts.alias, alias: opts.alias });
			const d = await (await R.forkDrive(ctx, this.#authed(k), source.id)).json() as { id: string; forkOf: { forkPoint: number } };
			return { ...await this.#info(ctx, k, await R.loadDrive(ctx, this.#authed(k), d.id)), forkPoint: d.forkOf.forkPoint };
		});
	}
	async deleteDrive(id: string, bucket: string, opts: { hard?: boolean }) {
		const k = await this.#key(id), ctx = this.#context(); this.#admin(k);
		const d = await this.#bucket(ctx, k, bucket);
		this.#body(ctx, {}, opts.hard === true);
		await this.#mutation(() => R.deleteDrive(ctx, this.#authed(k), d.id));
	}
	async describeDrive(id: string, bucket: string) {
		const k = await this.#key(id), ctx = this.#context(), d = await this.#bucket(ctx, k, bucket);
		const j = await R.driveJson(ctx, d);
		return { driveId: d.id, alias: d.alias, displayName: d.name, createdAt: new Date(d.created_at).toISOString(), forkOf: j.forkOf ? { driveId: j.forkOf.driveId, forkPoint: new Date(j.forkOf.forkPoint!).toISOString() } : null, forks: j.forks, usageBytes: j.usageBytes };
	}
	async mintChildKey(id: string, opts: { drives: string[]; access?: "read" | "write" | "admin"; label?: string; workspaceId?: string; orgId?: string }) {
		const k = await this.#key(id), ctx = this.#context();
		if ((opts.workspaceId !== undefined && opts.workspaceId !== k.orgId) || (opts.orgId !== undefined && opts.orgId !== k.orgId)) throw new HttpError(403, "access_denied");
		const access = opts.access === undefined ? k.access : opts.access;
		if (!Object.hasOwn(rank, access)) throw new HttpError(400, "invalid_argument");
		if (rank[access] > rank[k.access]) throw new HttpError(403, "access_denied");
		if (!Array.isArray(opts.drives) || opts.drives.length === 0 || opts.drives.length > 100 || opts.drives.some(d => typeof d !== "string") || new Set(opts.drives).size !== opts.drives.length) throw new HttpError(400, "invalid_argument");
		for (const d of opts.drives) await this.#bucket(ctx, k, d);
		return this.#mutation(async () => {
			this.#body(ctx, { workspaceId: k.orgId, access, drives: opts.drives, label: opts.label, parent: id });
			const { secretAccessKey, ...key } = await (await createKey(ctx, this.#authed(k))).json() as PublicKey & { secretAccessKey: string };
			return { key, secretAccessKey };
		});
	}
	async mintMountToken(id: string, bucket: string) {
		const k = await this.#key(id), ctx = this.#context(), d = await this.#bucket(ctx, k, bucket);
		const info = await this.#info(ctx, k, d);
		if (d.status !== "ready") throw new HttpError(403, "access_denied");
		const grant = await mintDriveToken(ctx, { sub: k.userId, sid: k.accessKeyId, org: k.orgId, drives: [{ id: d.id, access: info.writable ? "write" : "read" }] });
		return { driveId: d.id, alias: d.alias, displayName: d.name, workspaceId: k.orgId, canWrite: info.writable, endpoint: ctx.env.ULS_DATA_ENDPOINT, ...grant };
	}
}
