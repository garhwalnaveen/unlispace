import { fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { drive, json, renderApp } from "./fixtures";
it("opens a file with a drive read token and shows its version history", async () => {
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith("/token")) {
      expect(init?.body).toBe(JSON.stringify({ access: "read" }));
      return json({
        token: "drive-only",
        expiresAt: Date.now() + 900_000,
        endpoint: "https://data.example",
        driveId: drive.id,
      });
    }
    if (parsed.origin === "https://data.example") {
      expect(new Headers(init?.headers).get("Authorization")).toBe(
        "Bearer drive-only",
      );
      expect(parsed.searchParams.get("path")).toBe("a #?.txt");
      if (parsed.pathname.endsWith("/versions"))
        return json({
          cursor: null,
          versions: [
            {
              versionId: "v_old",
              size: 3,
              seq: 1,
              ts: 1000,
              actor: "u_test",
              op: "put",
            },
          ],
        });
      return json({
        path: "a #?.txt",
        type: "file",
        versionId: "v_head",
        size: 3,
        contentType: "text/plain",
        mtimeMs: 2000,
        seq: 2,
      });
    }
    return json(drive);
  });
  vi.stubGlobal("fetch", fetcher);
  const user = userEvent.setup();
  renderApp("/drives/d-test/a%20%23%3F.txt");
  expect(await screen.findByText("v_head")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Your drives" })).toHaveClass("active");
  expect(screen.getByRole("link", { name: /Show in Finder/ })).toHaveAttribute(
    "href",
    "uls://open?drive=d-test&path=a+%23%3F.txt",
  );
  await user.click(screen.getByRole("button", { name: "Version history" }));
  expect(await screen.findByText("v_old")).toBeInTheDocument();
});
const versions = [
  { versionId: "v1", ts: new Date("2026-10-01T10:00:00").getTime(), seq: 1, op: "put", size: 3, actor: null },
  { versionId: "v2", ts: new Date("2026-10-02T10:00:00").getTime(), seq: 2, op: "put", size: 4, actor: null },
  { versionId: "v3", ts: new Date("2026-10-03T10:00:00").getTime(), seq: 3, op: "delete", size: 0, actor: null },
];
it("picks the actual head as of time across pages, downloads it and restores through a guarded confirmation", async () => {
  let restored = false;
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/token")) return json({ token: "token", expiresAt: Date.now() + 900000, endpoint: "https://data.example", driveId: drive.id });
    if (url.includes("/versions?")) return json(new URL(url).searchParams.has("cursor") ? { versions: versions.slice(1), cursor: null } : { versions: versions.slice(0, 1), cursor: "next" });
    if (url.includes("/stat?")) return json({ path: "note.txt", type: "file", versionId: restored ? "v_restored" : "v_head", size: 3, mtimeMs: 1000, seq: 4 });
    if (url.includes("/manifest?")) { expect(new URL(url).searchParams.get("versionId")).toBe("v2"); return json({ path: "note.txt", versionId: "v2", size: 0, shards: [] }); }
    if (url.endsWith("/restore")) { expect(JSON.parse(String(init?.body))).toEqual({ path: "note.txt", versionId: "v2", ifVersion: "v_head" }); restored = true; return json({ seq: 5 }); }
    return json(drive);
  });
  vi.stubGlobal("fetch", fetcher);
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:test"); vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  renderApp(`/drives/${drive.id}/note.txt?panel=versions`); const user = userEvent.setup();
  await screen.findByText("v1");
  const date = screen.getByLabelText("View as of…");
  fireEvent.change(date, { target: { value: "2026-10-02T12:00" } });
  expect(screen.getByRole("button", { name: "View as of" })).toBeDisabled();
  await user.click(screen.getByRole("button", { name: "Load more versions" })); await screen.findByText("v3");
  await user.click(screen.getByRole("button", { name: "View as of" }));
  expect(within(screen.getByRole("region", { name: "Version as of selected time" })).getByText("v2")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Download selected version" }));
  await screen.findByText(/Your file is ready/);
  await user.click(screen.getByRole("button", { name: "Restore selected version" }));
  expect(fetcher.mock.calls.some(([url]) => url.endsWith("/restore"))).toBe(false);
  await user.click(screen.getByRole("button", { name: "Confirm restore" }));
  expect(await screen.findByText("Version restored as the new head.")).toBeInTheDocument();
  expect(await screen.findByText("v_restored")).toBeInTheDocument();
  fireEvent.change(date, { target: { value: "2026-10-03T12:00" } });
  // Reloaded history must be fully read again after restoring.
  await screen.findByRole("button", { name: "Load more versions" });
  await user.click(screen.getByRole("button", { name: "Load more versions" }));
  await user.click(screen.getByRole("button", { name: "View as of" }));
  expect(await screen.findByText("This file was deleted at that time.")).toBeInTheDocument();
  fireEvent.change(date, { target: { value: "2026-09-01T12:00" } });
  await user.click(screen.getByRole("button", { name: "View as of" }));
  expect(await screen.findByText("This file did not exist at that time.")).toBeInTheDocument();
});
it("keeps failed restores in the confirmation", async () => {
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/token")) return json({ token: "token", expiresAt: Date.now() + 900000, endpoint: "https://data.example", driveId: drive.id });
    if (url.includes("/versions?")) return json({ versions: versions.slice(0, 1), cursor: null });
    if (url.includes("/stat?")) return json({ path: "note.txt", type: "file", versionId: "head", size: 3, mtimeMs: 1000, seq: 4 });
    if (url.endsWith("/restore")) { expect(JSON.parse(String(init?.body)).ifVersion).toBe("head"); return json({ error: "precondition_failed" }, 412); }
    return json(drive);
  });
  vi.stubGlobal("fetch", fetcher); renderApp(`/drives/${drive.id}/note.txt?panel=versions`); const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Restore version v1" }));
  await user.click(screen.getByRole("button", { name: "Confirm restore" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Your change was not committed");
  expect(screen.getByRole("dialog", { name: "Restore version" })).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Cancel" }));
});
it("keeps history readable without restore or drive management controls for read-only members", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.endsWith("/token")) return json({ token: "read", expiresAt: Date.now() + 900000, endpoint: "https://data.example", driveId: drive.id });
    if (url.includes("/versions?")) return json({ versions: versions.slice(0, 1), cursor: null });
    if (url.includes("/stat?")) return json({ path: "note.txt", type: "file", versionId: "head", size: 3, mtimeMs: 1000, seq: 4 });
    if (url.includes("/list?")) return json({ entries: [], cursor: null });
    return json({ ...drive, access: "read" });
  }));
  renderApp(`/drives/${drive.id}/note.txt?panel=versions`);
  await screen.findByText("v1");
  expect(screen.queryByRole("button", { name: /Restore/ })).not.toBeInTheDocument();
  const user = userEvent.setup();
  await user.click(screen.getByRole("link", { name: "Space" }));
  await screen.findByText("Alias:", { exact: false });
  expect(screen.queryByRole("button", { name: /Fork Space|Rename Space|Delete Space|Permanently delete Space/ })).not.toBeInTheDocument();
});
