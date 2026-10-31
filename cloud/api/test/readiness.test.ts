import { describe, expect, it, vi } from "vitest";
import { makeWorld, signIn } from "./helpers";
import { DAY } from "../src/ctx";
import { provisionDrive } from "../src/users";
import { rpcContext } from "../src/control-plane";

const json = async (r: Response) => await r.json() as any;

describe("trial begins with usable storage", () => {
  it("does not spend a trial on failed provisioning and returns the activated date in the successful retry response", async () => {
    const w = await makeWorld();
    w.dp.failCreate = true;
    const s = await signIn(w);
    const orgs = () => w.call("/orgs", { token: s.accessToken }).then(json);
    const before = (await orgs()).orgs[0];
    expect(before).toMatchObject({ trialPending: true, trialEndsAt: null });
    expect(before.drives[0].status).toBe("provisioning_failed");
    expect(await json(await w.call(`/orgs/${before.id}/billing`, { token: s.accessToken }))).toMatchObject({ state: "provisioning", trialPending: true, writable: false });
    w.clock.t += 120_000;
    const readyAt = w.clock.t + 25_000;
    w.dp.createDrive = async (driveId) => { w.clock.t = readyAt; w.dp.created.push(driveId); return { driveId, placement: null, createdAt: readyAt }; };
    const ready = (await orgs()).orgs[0];
    expect(ready).toMatchObject({ trialPending: false, trialEndsAt: readyAt + 7 * DAY });
    expect(ready.drives[0].status).toBe("ready");
    expect((await orgs()).orgs[0].trialEndsAt).toBe(readyAt + 7 * DAY);
    expect(w.dp.created).toEqual([before.drives[0].id]);
  });

  it("concurrent successful/already-created retries activate one trial without extending it", async () => {
    const w = await makeWorld(); w.dp.failCreate = true;
    const s = await signIn(w);
    w.clock.t += 60_000;
    let arrivals = 0;
    let unblock!: () => void;
    const bothStarted = new Promise<void>((resolve) => { unblock = resolve; });
    w.dp.createDrive = vi.fn(async (driveId) => {
      arrivals++;
      if (arrivals === 2) unblock();
      await bothStarted;
      if (w.dp.created.includes(driveId)) throw new Error("drive_exists");
      w.dp.created.push(driveId);
      return { driveId, placement: null, createdAt: w.clock.t };
    });
    const responses = await Promise.all([w.call("/orgs", { token: s.accessToken }), w.call("/orgs", { token: s.accessToken })]);
    const first = (await json(responses[0])).orgs[0]; const second = (await json(responses[1])).orgs[0];
    expect(first.trialEndsAt).toBe(w.clock.t + 7 * DAY);
    expect(second.trialEndsAt).toBe(first.trialEndsAt);
    expect(w.dp.created).toHaveLength(1);
    expect(await w.env.DB.prepare("SELECT COUNT(*) AS n FROM orgs").first()).toEqual({ n: 1 });
    expect(await w.env.DB.prepare("SELECT COUNT(*) AS n FROM drives").first()).toEqual({ n: 1 });
    w.clock.t += 60_000;
    expect((await json(await w.call("/orgs", { token: s.accessToken }))).orgs[0].trialEndsAt).toBe(first.trialEndsAt);
  });

  it("never restarts old expired or null trials when storage is provisioned again", async () => {
    const w = await makeWorld(); const s = await signIn(w);
    const org = (await json(await w.call("/orgs", { token: s.accessToken }))).orgs[0];
    for (const trialEnd of [0, null]) {
      await w.env.DB.prepare("UPDATE orgs SET trial_ends_at = ?, trial_pending = 0 WHERE id = ?").bind(trialEnd, org.id).run();
      expect(await provisionDrive(rpcContext(w.env), org.drives[0].id, null)).toBe(true);
      expect(await w.env.DB.prepare("SELECT trial_ends_at,trial_pending FROM orgs WHERE id = ?").bind(org.id).first()).toEqual({ trial_ends_at: trialEnd, trial_pending: 0 });
    }
  });

  it("does not activate a trial for a drive deleted while its provisioning RPC was in flight", async () => {
    const w = await makeWorld(); w.dp.failCreate = true;
    const s = await signIn(w); const org = (await json(await w.call("/orgs", { token: s.accessToken }))).orgs[0];
    const id = org.drives[0].id;
    w.dp.createDrive = async (driveId) => { await w.env.DB.prepare("UPDATE drives SET status='deleted' WHERE id=?").bind(driveId).run(); return { driveId, placement: null, createdAt: w.clock.t }; };
    await provisionDrive(rpcContext(w.env), id, null);
    expect(await w.env.DB.prepare("SELECT trial_ends_at,trial_pending FROM orgs WHERE id=?").bind(org.id).first()).toEqual({ trial_ends_at: null, trial_pending: 1 });
  });
});
