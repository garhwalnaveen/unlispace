import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { DriveAuthority } from "../src/drive";
import { DRIVE_RECOVERY_MS } from "../src/drive";
import type { DataPlaneAdmin } from "../src/index";
import { api, newDrive, putFile } from "./helpers";

const admin = (exports as unknown as { DataPlaneAdmin: Pick<DataPlaneAdmin, "deleteDrive" | "restoreDrive"> }).DataPlaneAdmin;
const stubFor = (id: string) => env.DRIVE_AUTHORITY.get(env.DRIVE_AUTHORITY.idFromName(id)) as DurableObjectStub<DriveAuthority>;

describe("soft-deleted drive retention", () => {
	it("restores exact history and content while permanently deleted drives remain unavailable", async () => {
		const drive = await newDrive();
		await putFile(drive, "clip", "first");
		const versions = await (await api(`/v0/drives/${drive}/versions?path=clip`)).json();
		await admin.deleteDrive(drive);
		expect((await api(`/v0/drives/${drive}/stat?path=clip`)).status).toBe(404);
		await admin.restoreDrive(drive);
		expect((await api(`/v0/drives/${drive}/stat?path=clip`)).status).toBe(200);
		expect(await (await api(`/v0/drives/${drive}/versions?path=clip`)).json()).toEqual(versions);
		await admin.restoreDrive(drive);
		await admin.deleteDrive(drive, { hard: true });
		expect(await stubFor(drive).restoreDrive()).toMatchObject({ ok: false, status: 404, body: { error: "no_such_drive" } });
	});

	it("refuses recovery at the retention boundary", async () => {
		const drive = await newDrive();
		await admin.deleteDrive(drive);
		await runInDurableObject(stubFor(drive), (_instance, ctx) => {
			ctx.storage.sql.exec("UPDATE meta SET v=? WHERE k='deleted_at'", String(Date.now() - DRIVE_RECOVERY_MS));
		});
		expect(await stubFor(drive).restoreDrive()).toMatchObject({ ok: false, status: 410, body: { error: "recovery_expired" } });
	});
});
