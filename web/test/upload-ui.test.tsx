import { File } from "node:buffer";
import { fireEvent, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { drive, json, renderApp } from "./fixtures";
it("accepts a file drop, refreshes the list on commit and explains 412 conflicts", async () => {
  let conflict = false;
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/token")) return json({ token: "drive", endpoint: "https://data.example", expiresAt: Date.now() + 900_000, driveId: drive.id });
    if (url.includes("/list?")) return json({ entries: [], cursor: null });
    if (url.includes("/stat?")) return json({ error: "no_such_path" }, 404);
    if (url.endsWith("/missing")) return json({ missing: [] });
    if (url.endsWith("/commit")) { expect(JSON.parse(String(init?.body)).ops[0].ifAbsent).toBe(true); return conflict ? json({ error: "precondition_failed" }, 412) : json({ seq: 1 }); }
    return json(drive);
  });
  vi.stubGlobal("fetch", fetcher); renderApp(`/drives/${drive.id}/`);
  const area = await screen.findByRole("region", { name: "File upload and folder contents" });
  const file = new File(["hello"], "note.txt");
  fireEvent.drop(area, { dataTransfer: { files: [file] } });
  expect(await screen.findByText("Uploaded 1 file.")).toBeInTheDocument();
  expect(fetcher.mock.calls.filter(([url]) => url.includes("/list?"))).toHaveLength(2);
  conflict = true;
  fireEvent.change(screen.getByLabelText("Choose files to upload"), { target: { files: [file] } });
  expect(await screen.findByRole("alert")).toHaveTextContent("This file changed while you were uploading");
});
it("hides upload controls from read-only drive members", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.endsWith("/token")) return json({ token: "read", endpoint: "https://data.example", expiresAt: Date.now() + 900_000 });
    if (url.includes("/list?")) return json({ entries: [], cursor: null });
    return json({ ...drive, access: "read" });
  }));
  renderApp(`/drives/${drive.id}/`);
  await screen.findByText("This folder is empty.");
  expect(screen.queryByLabelText("Choose files to upload")).not.toBeInTheDocument();
});
