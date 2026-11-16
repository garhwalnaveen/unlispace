import { describe, expect, it } from "vitest";
import { control } from "../src/control-plane";
import { DataPlane } from "../src/data-plane";

describe("control-plane errors crossing Worker RPC", () => {
    it.each([
        ["drive_has_forks", 409, "DriveHasForks"],
        ["no_such_bucket", 404, "NoSuchBucket"],
        ["access_denied", 403, "AccessDenied"],
        ["upstream failed: no_such_bucket", 503, "ServiceUnavailable"],
        ["__proto__", 503, "ServiceUnavailable"],
    ])("maps exact serialized message %s", async (message, status, code) => {
        await expect(control(async () => { throw new Error(message); })).rejects.toMatchObject({ status, code });
    });
});

it("preserves bounded input-validation reasons without exposing upstream auth or server messages", async () => {
    const make = (status: number, error: string, message: unknown) => new DataPlane({
        fetch: async () => Response.json({ error, message }, { status }),
    }, { mint: async () => "test-token" }, { keyId: "key", subject: "user", orgId: "org", scope: "write" }, "drive");
    await expect(make(400, "bad_request", "ops[0]: path has an empty segment").commit([{ op: "delete", path: "folder//file" }]))
        .rejects.toMatchObject({ status: 400, code: "InvalidArgument", message: "ops[0]: path has an empty segment" });
    await expect(make(400, "bad_path", "x".repeat(1000)).stat("file")).rejects.toHaveProperty("message", "x".repeat(512));
    for (const [status, code] of [[401, "unauthorized"], [500, "internal_error"]] as const) {
        await expect(make(status, code, "private upstream details").stat("file")).rejects.not.toHaveProperty("message", "private upstream details");
    }
    await expect(make(400, "bad_request", { secret: "not text" }).stat("file")).rejects.toHaveProperty("message", "InvalidArgument");
});

it("reuses stored chunks and resolves concurrent R2 duplicate-upload races", async () => {
    const hash = "a".repeat(64), shard = { h: hash, n: 1 };
    for (const mode of ["stored", "new", "race", "busy", "invalid"] as const) {
        let uploads = 0, probes = 0;
        const dp = new DataPlane({ fetch: async request => {
            if (new URL(request.url).pathname.endsWith("shards/missing")) {
                probes++;
                return Response.json({ missing: mode === "stored" || (mode === "race" && probes > 1) ? [] : [hash] });
            }
            uploads++;
            return mode === "new" ? Response.json({ stored: true }) : Response.json({ error: "bad_request", message: mode === "invalid" ? "bad Content-Length" : "upload failed: put: Reduce your concurrent request rate for the same object. (10058)" }, { status: 400 });
        } }, { mint: async () => "test-token" }, { keyId: "key", subject: "user", orgId: "org", scope: "write" }, "drive");
        const operation = dp.putShard(shard, new Uint8Array([1]));
        if (mode === "busy") await expect(operation).rejects.toMatchObject({ status: 503, code: "SlowDown" });
        else if (mode === "invalid") await expect(operation).rejects.toMatchObject({ status: 400, code: "InvalidArgument", message: "bad Content-Length" });
        else await operation;
        expect(uploads).toBe(mode === "stored" ? 0 : 1);
        expect(probes).toBe(mode === "race" || mode === "busy" ? 2 : 1);
    }
});
