import { expect, it } from "vitest";
import { api, commit, newDrive, putFile } from "./helpers";

it("atomically enforces create-only restore and validates its condition", async () => {
  const drive = await newDrive();
  await putFile(drive, "record", "historical");
  const manifest = await (await api(`/v0/drives/${drive}/manifest?path=record`)).json() as { versionId: string };
  await commit(drive, [{ op: "delete", path: "record" }]);
  const restore = (ifAbsent: unknown) => api(`/v0/drives/${drive}/restore`, { json: { path: "record", versionId: manifest.versionId, ifAbsent } });
  expect((await restore("true")).status).toBe(400);
  const results = await Promise.all([restore(true), restore(true)]);
  expect(results.map(response => response.status).sort()).toEqual([200, 412]);
  const head = await (await api(`/v0/drives/${drive}/manifest?path=record`)).json() as { versionId: string };
  expect(head.versionId).not.toBe(manifest.versionId);
  expect((await restore(true)).status).toBe(412);
  expect((await (await api(`/v0/drives/${drive}/manifest?path=record`)).json() as { versionId: string }).versionId).toBe(head.versionId);
});
