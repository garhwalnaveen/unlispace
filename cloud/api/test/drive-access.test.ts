import { createExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ControlPlane } from "../src/control-plane";
import { verifyJwt } from "../src/jwt";
import { makeWorld, signIn } from "./helpers";

describe("drive access advertised to S3 clients", () => {
	it("refuses writable access before provisioning and caps renewed mounts to current membership", async () => {
		const w = await makeWorld({ ULS_ACCESS_KEY_MASTERS: JSON.stringify({ "1": btoa("test master key for access keys!!") }) });
		const session = await signIn(w);
		const { orgs } = await (await w.call("/orgs", { token: session.accessToken })).json() as { orgs: { id: string; drives: { id: string }[] }[] };
		const org = orgs[0]!, driveId = org.drives[0]!.id;
		const { accessKeyId } = await (await w.call("/keys", { token: session.accessToken, json: { workspaceId: org.id, access: "admin" } })).json() as { accessKeyId: string };
		const cp = new ControlPlane(createExecutionContext(), w.env);
		expect((await cp.resolveBucket(accessKeyId, driveId)).writable).toBe(true);
		for (const status of ["provisioning_failed", "forking"]) {
			await w.env.DB.prepare("UPDATE drives SET status=? WHERE id=?").bind(status, driveId).run();
			expect((await cp.resolveBucket(accessKeyId, driveId)).writable).toBe(false);
			expect((await cp.listDrives(accessKeyId))[0]!.writable).toBe(false);
			await expect(cp.mintMountToken(accessKeyId, driveId)).rejects.toMatchObject({ code: "access_denied" });
		}
		await w.env.DB.prepare("UPDATE drives SET status='ready' WHERE id=?").bind(driveId).run();
		expect((await cp.mintMountToken(accessKeyId, driveId)).canWrite).toBe(true);
		await w.env.DB.prepare("UPDATE memberships SET role='viewer' WHERE org_id=? AND user_id=?").bind(org.id, session.user.id).run();
		const mount = await cp.mintMountToken(accessKeyId, driveId);
		expect(mount.canWrite).toBe(false);
		const claims = await verifyJwt(mount.token, w.env.ULS_JWT_PUBLIC_JWKS, { issuer: w.env.ULS_ISSUER, typ: "drive", now: Date.now() });
		expect(claims.drives).toEqual([{ id: driveId, access: "read" }]);
	});
});
