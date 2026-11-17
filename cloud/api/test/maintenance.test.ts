import { describe, expect, it } from "vitest";
import { rpcContext } from "../src/control-plane";
import { pruneExpired, ROTATED_SESSION_RETENTION_MS } from "../src/maintenance";
import { makeWorld, signIn, type SessionBody } from "./helpers";

const DAY = 86_400_000;
const count = async (db: D1Database, table: string) => (await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())!.n;

describe("pruneExpired", () => {
	it("drops rotated sessions after retention and keeps the live session working", async () => {
		const w = await makeWorld();
		let s = await signIn(w);
		for (let i = 0; i < 3; i++) s = (await (await w.call("/auth/refresh", { json: { refreshToken: s.refreshToken } })).json()) as SessionBody;
		expect(await count(w.env.DB, "sessions")).toBe(4);

		const ctx = () => ({ ...rpcContext(w.env), now: w.clock.t });
		await pruneExpired(ctx());
		expect(await count(w.env.DB, "sessions")).toBe(4);

		w.clock.t += ROTATED_SESSION_RETENTION_MS + 1;
		await pruneExpired(ctx());
		expect(await count(w.env.DB, "sessions")).toBe(1);
		expect((await w.call("/auth/refresh", { json: { refreshToken: s.refreshToken } })).status).toBe(200);
	});

	it("drops expired sessions, rate-limit windows, codes, webhook receipts and old AI usage", async () => {
		const w = await makeWorld();
		await signIn(w);
		const db = w.env.DB, now = w.clock.t;
		await db.batch([
			db.prepare("INSERT INTO dodo_events VALUES('old','x',?)").bind(now - 91 * DAY),
			db.prepare("INSERT INTO dodo_events VALUES('recent','x',?)").bind(now - DAY),
			db.prepare("INSERT INTO ai_usage(user_id,day,requests) VALUES('u','2000-01-01',1)"),
			db.prepare("INSERT INTO ai_usage(user_id,day,requests) VALUES('u',?,1)").bind(new Date(now).toISOString().slice(0, 10)),
			db.prepare("INSERT INTO otp_codes VALUES('stale@example.com','h',?,0)").bind(now - 2 * 3_600_000),
			db.prepare("INSERT INTO one_time_codes(code_hash,kind,expires_at) VALUES('h','handoff',?)").bind(now - 2 * 3_600_000),
		]);
		expect(await count(db, "rate_limits")).toBeGreaterThan(0);

		w.clock.t += 31 * DAY;
		await pruneExpired({ ...rpcContext(w.env), now: w.clock.t });
		for (const table of ["sessions", "rate_limits", "otp_codes", "one_time_codes"]) expect(await count(db, table), table).toBe(0);
		expect((await db.prepare("SELECT id FROM dodo_events").all()).results).toEqual([{ id: "recent" }]);
		expect(await count(db, "ai_usage")).toBe(1);
	});
});
