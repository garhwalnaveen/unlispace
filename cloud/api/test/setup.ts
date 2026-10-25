import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach } from "vitest";

const e = env as unknown as { DB: D1Database; TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] };
let migrated = false;

beforeEach(async () => {
	if (!migrated) {
		await applyD1Migrations(e.DB, e.TEST_MIGRATIONS);
		migrated = true;
	}
	for (const t of ["drive_usage", "access_keys", "billing_checkouts", "billing", "dodo_events", "users", "orgs", "memberships", "drives", "sessions", "otp_codes", "one_time_codes", "rate_limits"]) {
		await e.DB.prepare(`DELETE FROM ${t}`).run();
	}
});
