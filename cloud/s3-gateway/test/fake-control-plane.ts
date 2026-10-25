import type { BucketInfo, ControlPlane } from "../src/control-plane";
import type { Access, KeyResolver } from "../src/auth";
import type { FakeDataPlane } from "./fake-data-plane";
const fail = (code: string): never => { throw Object.assign(new Error(code), { code }); };
export class FakeControlPlane implements ControlPlane {
    buckets = new Map<string, BucketInfo>();
    forks = new Map<string, {
        driveId: string;
        forkPoint: number;
    }>();
    uses: string[] = [];
    constructor(readonly dp: FakeDataPlane, readonly resolver: KeyResolver) { }
    async resolveKey(id: string) {
        const k = await this.resolver.resolve(id);
        return k ? { accessKeyId: k.keyId, userId: k.subject, orgId: k.orgId, access: k.scope, drives: k.drives ?? null, secretAccessKey: k.secretAccessKey, parent: null } : null;
    }
    async recordKeyUse(id: string) { this.uses.push(id); }
    async listDrives(id: string) {
        const key = await this.resolveKey(id);
        if (!key)
            return fail("access_denied");
        if (key.orgId !== "org-1")
            return [];
        return [...this.buckets.values()].filter(b => !key.drives || key.drives.includes(b.driveId)).map(b => this.effective(b, key.access));
    }
    private effective(b: BucketInfo, access: Access): BucketInfo { return { ...b, access, writable: b.writable && access !== "read" }; }
    async resolveBucket(id: string, bucket: string) {
        const key = await this.resolveKey(id);
        if (!key)
            return fail("access_denied");
        const b = [...this.buckets.values()].find(b => b.driveId === bucket || b.alias === bucket);
        if (!b || key.orgId !== "org-1" || (key.drives && !key.drives.includes(b.driveId)))
            return fail("no_such_bucket");
        return this.effective(b, key.access);
    }
    register(driveId: string, alias = driveId, placement: string | null = null) {
        const b: BucketInfo = { driveId, alias, displayName: alias, placement, createdAt: Date.now(), access: "admin", writable: true };
        this.buckets.set(driveId, b);
        return b;
    }
    private async admin(id: string) { const key = await this.resolveKey(id); if (key?.access !== "admin")
        fail("access_denied"); }
    async createDrive(id: string, opts: {
        alias: string;
        displayName?: string;
        placement?: string;
    }) {
        await this.admin(id);
        if ([...this.buckets.values()].some(b => b.alias === opts.alias))
            return fail("bucket_exists");
        const key = await this.resolveKey(id);
        if (key?.drives)
            return fail("access_denied");
        const driveId = `d-${crypto.randomUUID().replaceAll("-", "").slice(0, 26)}`;
        this.dp.createDrive(driveId);
        const b = this.register(driveId, opts.alias, opts.placement);
        b.displayName = opts.displayName ?? opts.alias;
        return b;
    }
    async forkDrive(id: string, opts: {
        source: string;
        alias: string;
    }) {
        const source = await this.resolveBucket(id, opts.source);
        let depth = 0, ancestor = source.driveId;
        while (this.forks.has(ancestor)) {
            ancestor = this.forks.get(ancestor)!.driveId;
            depth++;
        }
        if (depth >= 8)
            return fail("fork_depth_exceeded");
        const b = await this.createDrive(id, { alias: opts.alias, ...(source.placement ? { placement: source.placement } : {}) });
        this.dp.drives.set(b.driveId, structuredClone(this.dp.drives.get(source.driveId)!));
        for (const [key, bytes] of this.dp.shards)
            if (key.startsWith(source.driveId + "/"))
                this.dp.shards.set(b.driveId + key.slice(source.driveId.length), bytes);
        const forkPoint = this.dp.now;
        this.forks.set(b.driveId, { driveId: source.driveId, forkPoint });
        return { ...b, forkPoint };
    }
    async deleteDrive(id: string, bucket: string, opts: {
        hard: boolean;
    }) {
        await this.admin(id);
        const b = await this.resolveBucket(id, bucket);
        if (opts.hard && [...this.forks].some(([child, f]) => f.driveId === b.driveId && this.buckets.has(child)))
            fail("drive_has_forks");
        this.buckets.delete(b.driveId);
        this.dp.drives.delete(b.driveId);
    }
    async describeDrive(id: string, bucket: string) {
        const b = await this.resolveBucket(id, bucket), f = this.forks.get(b.driveId);
        return { ...b, createdAt: new Date(b.createdAt).toISOString(), forkOf: f ? { driveId: f.driveId, forkPoint: new Date(f.forkPoint).toISOString() } : null,
            forks: [...this.forks].filter(([child, f]) => f.driveId === b.driveId && this.buckets.has(child)).map(([child]) => child), usageBytes: 0 };
    }
    async mintChildKey(id: string, opts: {
        drives: string[];
        access?: Access;
        label?: string;
    }) {
        const key = await this.resolveKey(id);
        if (!key)
            return fail("access_denied");
        const rank = { read: 0, write: 1, admin: 2 };
        if (!opts.drives.length || (opts.access && rank[opts.access] > rank[key.access]))
            return fail("access_denied");
        for (const d of opts.drives) {
            const b = await this.resolveBucket(id, d);
            if (b.driveId !== d)
                return fail("access_denied");
        }
        return { key: { accessKeyId: "child", parent: id, drives: opts.drives, access: opts.access ?? key.access }, secretAccessKey: "child-secret" };
    }
    async mintMountToken(id: string, bucket: string) { const b = await this.resolveBucket(id, bucket); return { ...b, workspaceId: "org-1", canWrite: b.writable, endpoint: "https://data.test", token: "scoped-token", expiresAt: Date.now() + 900000 }; }
}
