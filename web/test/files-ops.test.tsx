import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it } from "vitest";
import { backend, file, folder } from "./files-backend";
import { deferred, drive, json, renderApp } from "./fixtures";

const names = () => screen.getAllByRole("row").slice(1).map((row) => within(row).getByRole("link").textContent);
const menu = async (user: ReturnType<typeof userEvent.setup>, name: string, item: string) => {
  await user.click(screen.getByRole("button", { name: `Actions for ${name}` }));
  await user.click(await screen.findByRole("menuitem", { name: item }));
};
const tree = () => ({
  "": [file("b.txt", 2048, 3000, "v_B"), folder("docs", "v_DOCS"), file("a.txt", 5_000_000, 2000, "v_A"), folder("archive", "v_ARCHIVE")],
  "docs/": [file("plan.md", 10, 1000, "v_PLAN")], "archive/": [],
});

it("lists folders first with plain sizes, sorts by column and links folders and files to lasting addresses", async () => {
  backend({ folders: tree() });
  renderApp(`/drives/${drive.id}/`); const user = userEvent.setup();
  await screen.findByRole("link", { name: "docs" });
  expect(screen.getByRole("heading", { level: 1, name: "Space" })).toBeInTheDocument();
  expect(names()).toEqual(["archive", "docs", "a.txt", "b.txt"]);
  expect(screen.getByRole("row", { name: /a\.txt/ })).toHaveTextContent("5 MB");
  expect(screen.getByRole("columnheader", { name: "Name" })).toHaveAttribute("aria-sort", "ascending");
  await user.click(screen.getByRole("button", { name: "Size" }));
  expect(screen.getByRole("columnheader", { name: "Size" })).toHaveAttribute("aria-sort", "descending");
  expect(names()).toEqual(["archive", "docs", "a.txt", "b.txt"]);
  await user.click(screen.getByRole("button", { name: "Size" }));
  expect(names()).toEqual(["archive", "docs", "b.txt", "a.txt"]);
  await user.click(screen.getByRole("button", { name: "Modified" }));
  expect(names().slice(2)).toEqual(["b.txt", "a.txt"]);
  expect(screen.getByRole("link", { name: "a.txt" })).toHaveAttribute("href", "/drives/d-test/?file=a.txt");
  expect(screen.getByRole("link", { name: "Open in Finder" })).toHaveAttribute("href", "uls://open?drive=d-test&path=");
  expect(screen.queryByText(/Drive options|loaded items|Alias/i)).not.toBeInTheDocument();
  await user.click(screen.getByRole("link", { name: "docs" }));
  expect(await screen.findByRole("heading", { level: 1, name: "docs" })).toBeInTheDocument();
  expect(await screen.findByRole("link", { name: "plan.md" })).toHaveAttribute("href", "/drives/d-test/docs/?file=plan.md");
  expect(within(screen.getByRole("navigation", { name: "Folders" })).getByRole("link", { name: "Space" })).toHaveAttribute("href", "/drives/d-test/");
});

it("shows skeleton rows while loading and offers Try again after a failure", async () => {
  const first = deferred<Response>();
  let attempts = 0;
  backend({ data: (route) => (route !== "list" ? undefined : ++attempts === 1 ? first.promise : attempts === 2 ? json({ error: "internal" }, 500) : json({ entries: [file("ok.txt")], cursor: null })) });
  renderApp(`/drives/${drive.id}/`); const user = userEvent.setup();
  expect(await screen.findByRole("status", { name: "Loading files" })).toBeInTheDocument();
  first.resolve(json({ error: "internal" }, 500));
  expect(await screen.findByRole("heading", { name: "This folder couldn’t be loaded" })).toBeInTheDocument();
  expect(screen.getByRole("alert")).toHaveTextContent("Your files are safe");
  await user.click(screen.getByRole("button", { name: "Try again" }));
  await screen.findByRole("heading", { name: "This folder couldn’t be loaded" });
  await user.click(screen.getByRole("button", { name: "Try again" }));
  expect(await screen.findByRole("link", { name: "ok.txt" })).toBeInTheDocument();
});

it("creates a folder with a guarded mkdir, validating the name first and explaining a taken name", async () => {
  let taken = true;
  const { sent } = backend({ folders: tree(), data: (route) => (route === "commit" && taken ? json({ error: "precondition_failed", path: "docs/Drafts/" }, 412) : undefined) });
  renderApp(`/drives/${drive.id}/docs/`); const user = userEvent.setup();
  await screen.findByRole("link", { name: "plan.md" });
  await user.click(screen.getByRole("button", { name: "New folder" }));
  const input = screen.getByLabelText("Folder name");
  await user.clear(input); await user.type(input, "a/b");
  await user.click(screen.getByRole("button", { name: "Create folder" }));
  expect(screen.getByRole("alert")).toHaveTextContent("Names can’t contain a slash");
  expect(sent("commit")).toHaveLength(0);
  await user.clear(input); await user.type(input, "Drafts{Enter}");
  expect(await screen.findByRole("alert")).toHaveTextContent("“Drafts” already exists in this folder");
  expect(sent("commit")[0].body).toEqual({ ops: [{ op: "mkdir", path: "docs/Drafts/", ifAbsent: true }] });
  taken = false;
  await user.click(screen.getByRole("button", { name: "Create folder" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(screen.getByText("Created “Drafts”.")).toBeInTheDocument();
  expect(sent("list").length).toBeGreaterThanOrEqual(3);
});

it("renames with the version it saw and reports a name that is already used", async () => {
  let conflict = true;
  const { sent } = backend({ folders: tree(), data: (route) => (route === "commit" && conflict ? json({ error: "path_conflict", path: "b.txt" }, 409) : undefined) });
  renderApp(`/drives/${drive.id}/`); const user = userEvent.setup();
  await screen.findByRole("link", { name: "a.txt" });
  await menu(user, "a.txt", "Rename…");
  const input = screen.getByLabelText("New name");
  expect(input).toHaveValue("a.txt");
  await user.clear(input); await user.type(input, "b.txt{Enter}");
  expect(await screen.findByRole("alert")).toHaveTextContent("“b.txt” already exists in this folder");
  conflict = false;
  await user.clear(input); await user.type(input, "c.txt{Enter}");
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(sent("commit").at(-1)!.body).toEqual({ ops: [{ op: "rename", from: "a.txt", to: "c.txt", ifVersion: "v_A" }] });
  await menu(user, "docs", "Rename…");
  await user.clear(screen.getByLabelText("New name")); await user.type(screen.getByLabelText("New name"), "papers{Enter}");
  await waitFor(() => expect(sent("commit").at(-1)!.body).toEqual({ ops: [{ op: "rename", from: "docs/", to: "papers/", ifVersion: "v_DOCS" }] }));
});

it("moves the selection through a folder picker in one commit and refuses a folder moving into itself", async () => {
  const { sent } = backend({ folders: tree() });
  renderApp(`/drives/${drive.id}/`); const user = userEvent.setup();
  await screen.findByRole("link", { name: "a.txt" });
  await user.click(screen.getByRole("checkbox", { name: "Select a.txt" }));
  await user.click(screen.getByRole("checkbox", { name: "Select docs" }));
  const bar = screen.getByRole("toolbar", { name: "Selected items" });
  expect(bar).toHaveTextContent("2 selected");
  await user.click(within(bar).getByRole("button", { name: "Move to…" }));
  const dialog = screen.getByRole("dialog", { name: "Move 2 items" });
  const confirm = () => within(dialog).getByRole("button", { name: /^Move to/ });
  expect(confirm()).toBeDisabled();
  expect(dialog).toHaveTextContent("They’re already in this folder");
  expect(await within(dialog).findByRole("button", { name: "docs" })).toBeDisabled();
  await user.click(within(dialog).getByRole("button", { name: "archive" }));
  await waitFor(() => expect(confirm()).toHaveTextContent("Move to “archive”"));
  await user.click(confirm());
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(sent("commit")[0].body).toEqual({ ops: [
    { op: "rename", from: "docs/", to: "archive/docs/", ifVersion: "v_DOCS" },
    { op: "rename", from: "a.txt", to: "archive/a.txt", ifVersion: "v_A" },
  ] });
  expect(screen.getByText("Moved 2 items to “archive”.")).toBeInTheDocument();
  expect(screen.queryByRole("toolbar", { name: "Selected items" })).not.toBeInTheDocument();
});

it("deletes only after a confirmation that says what happens and how to get the items back", async () => {
  let fail = true;
  const { sent } = backend({ folders: tree(), data: (route) => (route === "commit" && fail ? json({ error: "precondition_failed", path: "a.txt" }, 412) : undefined) });
  renderApp(`/drives/${drive.id}/`); const user = userEvent.setup();
  await screen.findByRole("link", { name: "a.txt" });
  await menu(user, "a.txt", "Delete…");
  let dialog = screen.getByRole("dialog", { name: "Delete “a.txt”?" });
  expect(dialog).toHaveTextContent("removed from the drive for everyone");
  expect(dialog).toHaveTextContent("bring it back from Deleted files");
  await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(sent("commit")).toHaveLength(0);
  await user.click(screen.getByRole("checkbox", { name: "Select all items" }));
  await user.click(screen.getByRole("checkbox", { name: "Select b.txt" }));
  await user.click(within(screen.getByRole("toolbar", { name: "Selected items" })).getByRole("button", { name: "Delete…" }));
  dialog = screen.getByRole("dialog", { name: "Delete 3 items?" });
  expect(dialog).toHaveTextContent("everything inside the folders");
  await user.click(within(dialog).getByRole("button", { name: "Delete 3 items" }));
  expect(await within(dialog).findByRole("alert")).toHaveTextContent("“a.txt” changed while you were working. Nothing was changed");
  fail = false;
  await user.click(within(dialog).getByRole("button", { name: "Delete 3 items" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(sent("commit").at(-1)!.body).toEqual({ ops: [
    { op: "delete", path: "archive/", ifVersion: "v_ARCHIVE" },
    { op: "delete", path: "docs/", ifVersion: "v_DOCS" },
    { op: "delete", path: "a.txt", ifVersion: "v_A" },
  ] });
  expect(screen.getByText("Deleted 3 items.")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Show deleted files" })).toBeInTheDocument();
});

it("searches the whole drive from three characters, filters the folder before that, and falls back when search is unavailable", async () => {
  let available = true;
  const { sent } = backend({
    folders: tree(),
    data: (route, url) => {
      if (route !== "search") return undefined;
      if (!available) return json({ error: "not_found" }, 404);
      expect(url.searchParams.get("q")).toBe("plan");
      return json({ entries: [{ path: "docs/plan.md", type: "file", versionId: "v_PLAN", size: 10, contentType: "text/markdown", mtimeMs: 1000, seq: 1 }, { path: "plans/", type: "folder", versionId: "v_P", size: 0, contentType: null, mtimeMs: 1000, seq: 1 }], cursor: null });
    },
  });
  renderApp(`/drives/${drive.id}/`); const user = userEvent.setup();
  await screen.findByRole("link", { name: "a.txt" });
  const box = screen.getByRole("searchbox", { name: "Search Space" });
  await user.type(box, "a.");
  expect(names()).toEqual(["a.txt"]);
  expect(screen.getByText(/Showing matches in this folder\. Type 3 or more characters/)).toBeInTheDocument();
  expect(sent("search")).toHaveLength(0);
  await user.clear(box); await user.type(box, "plan");
  expect(await screen.findByText("2 results for “plan” in all of Space")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: /plan\.md/ })).toHaveAttribute("href", "/drives/d-test/docs/?file=plan.md");
  expect(screen.getByRole("link", { name: /plan\.md/ })).toHaveTextContent("in docs");
  expect(screen.getByRole("link", { name: /plans/ })).toHaveAttribute("href", "/drives/d-test/plans/");
  available = false;
  await user.clear(box); await user.type(box, "txt");
  expect(await screen.findByText(/Searching the whole drive isn’t available right now/)).toBeInTheDocument();
  expect(names()).toEqual(["a.txt", "b.txt"]);
  await user.clear(box); await user.type(box, "zzz");
  expect(await screen.findByRole("heading", { name: "No matches" })).toBeInTheDocument();
  await user.click(within(screen.getByRole("heading", { name: "No matches" }).parentElement!).getByRole("button", { name: "Clear search" }));
  expect(names()).toHaveLength(4);
});

it("lists deleted files from the drive’s history and puts one back as it was", async () => {
  const { sent } = backend({
    folders: tree(),
    data: (route, url) => {
      if (route === "changes") return json(url.searchParams.get("limit") === "1" ? { changes: [], lastEv: 4, more: false } : { lastEv: 4, more: false, changes: [
        { ev: 1, seq: 1, path: "docs/old.txt", op: "put", versionId: "v_1" },
        { ev: 2, seq: 2, path: "docs/old.txt", op: "delete", versionId: "v_2" },
        { ev: 3, seq: 3, path: "moved.txt", op: "delete", versionId: null },
        { ev: 4, seq: 3, path: "kept.txt", op: "rename", versionId: "v_3" },
      ] });
      if (route === "versions" && url.searchParams.get("path") === "docs/old.txt") return json({ cursor: null, versions: [
        { versionId: "v_1", op: "put", size: 9, seq: 1, ts: 1000, actor: null }, { versionId: "v_2", op: "delete", size: null, seq: 2, ts: 2000, actor: null },
      ] });
    },
  });
  renderApp(`/drives/${drive.id}/`); const user = userEvent.setup();
  await screen.findByRole("link", { name: "a.txt" });
  await user.click(screen.getByRole("button", { name: "More for this drive" }));
  await user.click(await screen.findByRole("menuitem", { name: "Deleted files" }));
  const dialog = await screen.findByRole("dialog", { name: "Deleted files" });
  const items = await within(dialog).findAllByRole("listitem");
  expect(items).toHaveLength(1);
  expect(items[0]).toHaveTextContent("old.txt");
  expect(items[0]).toHaveTextContent("Was in docs");
  await user.click(within(dialog).getByRole("button", { name: "Restore old.txt" }));
  expect(await within(dialog).findByText("Restored")).toBeInTheDocument();
  expect(sent("restore")[0].body).toEqual({ path: "docs/old.txt", versionId: "v_1", ifAbsent: true });
  expect(sent("restore")[0].headers.get("Authorization")).toBe("Bearer drive-write");
});

it("previews a small text file in the details panel and downloads it from there", async () => {
  const bytes = new TextEncoder().encode("hello orbit");
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) => byte.toString(16).padStart(2, "0")).join("");
  backend({
    folders: { "": [file("readme.md", bytes.length, 1000, "v_R"), file("movie.mov", 900_000_000, 1000, "v_M")] },
    data: (route) => (route === "manifest" ? json({ path: "readme.md", versionId: "v_R", size: bytes.length, contentType: "text/html", shards: [{ h: hash, n: bytes.length }] })
      : route === `shards/${hash}` ? new Response(bytes) : undefined),
  });
  renderApp(`/drives/${drive.id}/`); const user = userEvent.setup();
  await user.click(await screen.findByRole("link", { name: "readme.md" }));
  const panel = await screen.findByRole("complementary", { name: "Details for readme.md" });
  expect(await within(panel).findByLabelText("Preview of readme.md")).toHaveTextContent("hello orbit");
  expect(within(panel).getByText("11 B")).toBeInTheDocument();
  await user.click(screen.getByRole("link", { name: "movie.mov" }));
  const movie = await screen.findByRole("complementary", { name: "Details for movie.mov" });
  expect(await within(movie).findByText(/no preview in the browser/)).toBeInTheDocument();
  await user.click(within(movie).getByRole("button", { name: "Download" }));
  expect(await within(screen.getByRole("region", { name: "Uploads and downloads" })).findByRole("alert")).toHaveTextContent("too large to download in the browser. Open it in Finder instead.");
});

it("loads long folders a page at a time and says when a filter has only checked the items shown so far", async () => {
  const { sent } = backend({
    data: (route, url) => (route !== "list" ? undefined : url.searchParams.has("cursor")
      ? json({ entries: [file("c-last.txt")], cursor: null })
      : json({ entries: [folder("z-folder"), file("a-small.txt", 5), file("b-large.txt", 500)], cursor: "opaque+/=" })),
  });
  renderApp(`/drives/${drive.id}/`); const user = userEvent.setup();
  await screen.findByRole("link", { name: "b-large.txt" });
  expect(screen.getByText("3 items shown so far")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Size" }));
  expect(names()).toEqual(["z-folder", "b-large.txt", "a-small.txt"]);
  const box = screen.getByRole("searchbox", { name: "Search Space" });
  await user.type(box, "c-");
  expect(await screen.findByRole("heading", { name: "No matches" })).toBeInTheDocument();
  expect(screen.getByText(/Only the items shown so far are checked/)).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Check more of this folder" }));
  expect(await screen.findByRole("link", { name: "c-last.txt" })).toBeInTheDocument();
  expect(sent("list")[1].url.searchParams.get("cursor")).toBe("opaque+/=");
  await user.clear(box);
  expect(screen.getByText("4 items")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Show more" })).not.toBeInTheDocument();
});
