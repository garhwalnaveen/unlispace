import { describe, expect, it } from "vitest";
import { control } from "../src/control-plane";

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
