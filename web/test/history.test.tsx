import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { backend, file, HEAD } from "./files-backend";
import { drive, json, renderApp } from "./fixtures";

const at = (day: string) => new Date(`2026-10-${day}T10:00:00`).getTime();
const versions = [
  { versionId: "v1", ts: at("01"), seq: 1, op: "put", size: 2048, actor: null, restoredFrom: null },
  { versionId: "v2", ts: at("02"), seq: 2, op: "put", size: 4096, actor: null, restoredFrom: null },
  { versionId: HEAD, ts: at("03"), seq: 3, op: "put", size: 3, actor: null, restoredFrom: null },
];
const note = { "": [file("note.txt", 3, at("03"), HEAD)] };
const history = () => within(screen.getByRole("region", { name: "Version history" })).getAllByRole("listitem");

it("opens a deep-linked file with a drive read token and shows plain-language history, newest first", async () => {
  const { requests, fetcher } = backend({
    folders: { "": [file("a #?.txt", 3, at("03"), HEAD)] },
    data: (route) => (route === "versions" ? json({ versions, cursor: null }) : undefined),
  });
  renderApp("/drives/d-test/a%20%23%3F.txt");
  const panel = await screen.findByRole("complementary", { name: "Details for a #?.txt" });
  expect(fetcher.mock.calls.find(([url]) => url.endsWith("/token"))?.[1]?.body).toBe(JSON.stringify({ access: "read" }));
  expect(requests.every((request) => request.headers.get("Authorization") === "Bearer drive-read")).toBe(true);
  expect(requests.find((request) => request.route === "stat")?.url.searchParams.get("path")).toBe("a #?.txt");
  expect(await within(panel).findByRole("link", { name: /Open in Finder/ })).toHaveAttribute("href", "uls://open?drive=d-test&path=a+%23%3F.txt");
  await waitFor(() => expect(history()).toHaveLength(3));
  const [newest, middle, oldest] = history();
  expect(newest).toHaveTextContent(/3 B · Current version$/);
  expect(middle).toHaveTextContent("4.1 KB");
  expect(oldest).toHaveTextContent("2 KB");
  expect(within(newest).queryByRole("button")).not.toBeInTheDocument();
  expect(within(oldest).getByRole("button", { name: /^Restore the version from/ })).toBeInTheDocument();
  // No internal identifiers anywhere on the page.
  expect(document.body).not.toHaveTextContent(/v_HEAD|v1|v2|sequence|manifest/i);
});

it("reads every history page, downloads an old version and restores it through a guarded confirmation", async () => {
  let restored = false;
  const { sent } = backend({
    folders: note,
    data: (route, url, _init, body) => {
      if (route === "versions") {
        const all = restored ? [...versions, { ...versions[1], versionId: "v_restored", ts: Date.now(), seq: 4, op: "restore", restoredFrom: "v2" }] : versions;
        return json(url.searchParams.has("cursor") ? { versions: all.slice(1), cursor: null } : { versions: all.slice(0, 1), cursor: "next" });
      }
      if (route === "stat" && restored) return json({ path: "note.txt", type: "file", versionId: "v_restored", size: 4096, mtimeMs: at("02"), seq: 4 });
      if (route === "manifest") return json({ path: "note.txt", versionId: "v2", size: 0, shards: [] });
      if (route === "restore") { expect(body).toEqual({ path: "note.txt", versionId: "v2", ifVersion: HEAD }); restored = true; return json({ seq: 4, results: [] }); }
    },
  });
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:test"); vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  renderApp(`/drives/${drive.id}/?file=note.txt`); const user = userEvent.setup();
  await waitFor(() => expect(history()).toHaveLength(3));
  const middle = history()[1];
  await user.click(within(middle).getByRole("button", { name: /^Download the version from/ }));
  expect(await within(screen.getByRole("region", { name: "Uploads and downloads" })).findByText(/Downloaded/)).toBeInTheDocument();
  expect(sent("manifest").at(-1)!.url.searchParams.get("versionId")).toBe("v2");
  await user.click(within(middle).getByRole("button", { name: /^Restore the version from/ }));
  const dialog = screen.getByRole("dialog", { name: "Restore this version?" });
  expect(dialog).toHaveTextContent("The current version is kept in history");
  expect(sent("restore")).toHaveLength(0);
  await user.click(within(dialog).getByRole("button", { name: "Restore version" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  await waitFor(() => expect(history()).toHaveLength(4));
  expect(history()[0]).toHaveTextContent(/4\.1 KB · Restored from .* · Current version$/);
});

it("keeps a failed restore in the confirmation and says nothing was changed", async () => {
  const { sent } = backend({
    folders: note,
    data: (route, _url, _init, body) => {
      if (route === "versions") return json({ versions, cursor: null });
      if (route === "restore") { expect(body.ifVersion).toBe(HEAD); return json({ error: "precondition_failed", path: "note.txt" }, 412); }
    },
  });
  renderApp(`/drives/${drive.id}/?file=note.txt`); const user = userEvent.setup();
  await waitFor(() => expect(history()).toHaveLength(3));
  await user.click(within(history()[2]).getByRole("button", { name: /^Restore the version from/ }));
  await user.click(screen.getByRole("button", { name: "Restore version" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("“note.txt” changed while you were working. Nothing was changed");
  expect(screen.getByRole("dialog", { name: "Restore this version?" })).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(sent("restore")).toHaveLength(1);
});

it("lets view-only members read history without restore or other write controls", async () => {
  const { fetcher } = backend({ drive: { access: "read" }, folders: note, data: (route) => (route === "versions" ? json({ versions, cursor: null }) : undefined) });
  renderApp(`/drives/${drive.id}/?file=note.txt`);
  await waitFor(() => expect(history()).toHaveLength(3));
  expect(screen.getByText("View only")).toBeInTheDocument();
  expect(screen.getAllByRole("button", { name: /^Download the version from/ })).toHaveLength(2);
  expect(screen.queryByRole("button", { name: /Restore|More actions for|New folder|^Upload/ })).not.toBeInTheDocument();
  expect(fetcher.mock.calls.some(([, init]) => init?.body === JSON.stringify({ access: "write" }))).toBe(false);
});

it("closes the details panel with Escape and keeps the folder in the address", async () => {
  backend({ folders: note });
  renderApp(`/drives/${drive.id}/?file=note.txt`); const user = userEvent.setup();
  await screen.findByRole("complementary", { name: "Details for note.txt" });
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("complementary", { name: "Details for note.txt" })).not.toBeInTheDocument());
  expect(screen.getByRole("link", { name: "note.txt" })).toHaveFocus();
});
