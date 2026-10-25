import type { Access, KeyResolver, ResolvedKey } from "./auth";
import type { FetchBinding } from "./data-plane";
import { S3Error } from "./errors";
export interface BucketInfo {
    driveId: string;
    alias: string | null;
    displayName: string;
    placement: string | null;
    createdAt: number;
    access: Access;
    writable: boolean;
}
export interface ControlPlane {
    resolveKey(id: string): Promise<{
        accessKeyId: string;
        orgId: string;
        userId: string;
        access: Access;
        drives: string[] | null;
        secretAccessKey: string;
        parent: string | null;
    } | null>;
    recordKeyUse(id: string): Promise<void>;
    listDrives(id: string): Promise<BucketInfo[]>;
    resolveBucket(id: string, bucket: string): Promise<BucketInfo>;
    createDrive(id: string, opts: {
        alias: string;
        displayName?: string;
        placement?: string;
    }): Promise<BucketInfo>;
    forkDrive(id: string, opts: {
        source: string;
        alias: string;
    }): Promise<BucketInfo & {
        forkPoint: number;
    }>;
    deleteDrive(id: string, bucket: string, opts: {
        hard: boolean;
    }): Promise<void>;
    describeDrive(id: string, bucket: string): Promise<{
        driveId: string;
        alias: string | null;
        displayName: string;
        createdAt: string;
        forkOf: {
            driveId: string;
            forkPoint: string;
        } | null;
        forks: string[];
        usageBytes: number;
    }>;
    mintChildKey(id: string, opts: {
        drives: string[];
        access?: Access;
        label?: string;
    }): Promise<unknown>;
    mintMountToken(id: string, bucket: string): Promise<unknown>;
}
/** One resolver per service binding per isolate; cached authority expires within 30 seconds. */
export class ControlPlaneKeyResolver implements KeyResolver {
    private cache = new Map<string, {
        until: number;
        key: ResolvedKey | null;
    }>();
    constructor(private readonly cp: ControlPlane, private readonly now = Date.now) { }
    async resolve(id: string): Promise<ResolvedKey | null> {
        const cached = this.cache.get(id);
        if (cached && cached.until > this.now())
            return cached.key;
        const record = await control(() => this.cp.resolveKey(id));
        const key = record ? { keyId: record.accessKeyId, subject: record.userId, orgId: record.orgId,
            scope: record.access, ...(record.drives ? { drives: record.drives } : {}), secretAccessKey: record.secretAccessKey } : null;
        // Keep attacker-chosen unknown ids from growing the isolate indefinitely.
        for (const [id, entry] of this.cache)
            if (entry.until <= this.now())
                this.cache.delete(id);
        if (this.cache.size >= 1000)
            this.cache.delete(this.cache.keys().next().value!);
        this.cache.set(id, { until: this.now() + 30000, key });
        return key;
    }
    recordUse(id: string): Promise<void> { return control(() => this.cp.recordKeyUse(id)); }
}
const resolvers = new WeakMap<ControlPlane, ControlPlaneKeyResolver>();
export function keyResolver(cp: ControlPlane): ControlPlaneKeyResolver {
    let resolver = resolvers.get(cp);
    if (!resolver) {
        resolver = new ControlPlaneKeyResolver(cp);
        resolvers.set(cp, resolver);
    }
    return resolver;
}
export async function control<T>(call: () => Promise<T>): Promise<T> {
    try {
        return await call();
    }
    catch (error) {
        const code = (error as {
            code?: string;
        }).code;
        const errors: Record<string, [
            number,
            string
        ]> = {
            no_such_bucket: [404, "NoSuchBucket"], access_denied: [403, "AccessDenied"],
            bucket_exists: [409, "BucketAlreadyOwnedByYou"], drive_has_forks: [409, "DriveHasForks"],
            invalid_argument: [400, "InvalidArgument"], plan_limit: [403, "AccessDenied"],
            over_quota: [403, "QuotaExceeded"], fork_depth_exceeded: [400, "ForkDepthExceeded"], slow_down: [503, "SlowDown"],
        };
        const [status, name] = errors[code ?? ""] ?? [503, "ServiceUnavailable"];
        throw new S3Error(status, name, undefined, name === "SlowDown" ? { "retry-after": "1" } : {});
    }
}
export type SessionAPI = FetchBinding;
