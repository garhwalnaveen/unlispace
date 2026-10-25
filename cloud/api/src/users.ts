import type { Ctx } from "./ctx";
import { DAY, ulid } from "./ctx";
import type { Placement } from "./env";
import type { UserRow } from "./session";

export async function setDriveStatus(ctx: Ctx, driveId: string, status: "ready" | "provisioning_failed"): Promise<void> {
	await ctx.env.DB.prepare("UPDATE drives SET status = ? WHERE id = ? AND status != 'deleted'").bind(status, driveId).run();
}

/**
 * Call the data plane and record the outcome. The drive row exists beforehand as
 * `provisioning_failed`, so a crash between the RPC and the update is repaired by the lazy retry.
 * A `drive_exists` answer means an earlier attempt already succeeded.
 */
export async function provisionDrive(ctx: Ctx, driveId: string, placement: string | null): Promise<boolean> {
	try {
		await ctx.env.DATA_PLANE.createDrive(driveId, (placement as Placement | null) ?? undefined);
	} catch (e) {
		if (!String((e as Error)?.message ?? e).includes("drive_exists")) {
			console.error("createDrive failed", driveId, String((e as Error)?.message ?? e));
			return false;
		}
	}
	await setDriveStatus(ctx, driveId, "ready");
	return true;
}

export function newDriveId(): string {
	return "d-" + ulid().toLowerCase();
}

/** Find the user by email, or create user + "My Space" org + owner membership + "Space" drive. */
export async function findOrCreateUser(ctx: Ctx, email: string): Promise<{ user: UserRow; created: boolean }> {
	const find = () => ctx.env.DB.prepare("SELECT id, email, display_name, created_at FROM users WHERE email = ?").bind(email).first<UserRow>();
	const existing = await find();
	if (existing) return { user: existing, created: false };

	const userId = "u_" + ulid();
	const orgId = "o_" + ulid();
	const driveId = newDriveId();
	const db = ctx.env.DB;
	try {
		await db.batch([
			db.prepare("INSERT INTO users(id, email, display_name, created_at) VALUES(?,?,NULL,?)").bind(userId, email, ctx.now),
			db.prepare("INSERT INTO orgs(id, name, tier, trial_ends_at, created_at) VALUES(?,?,?,?,?)").bind(orgId, "My Space", "individual", ctx.now + 7 * DAY, ctx.now),
			db.prepare("INSERT INTO memberships(org_id, user_id, role, created_at) VALUES(?,?,?,?)").bind(orgId, userId, "owner", ctx.now),
			db.prepare("INSERT INTO drives(id, org_id, name, placement, status, created_at) VALUES(?,?,?,?,?,?)").bind(driveId, orgId, "Space", null, "provisioning_failed", ctx.now),
		]);
	} catch (e) {
		// Lost a race with a concurrent first sign-in for the same email.
		const again = await find();
		if (again) return { user: again, created: false };
		throw e;
	}
	await provisionDrive(ctx, driveId, null);
	return { user: { id: userId, email, display_name: null, created_at: ctx.now }, created: true };
}
