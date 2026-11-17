import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { drive, json, org, renderApp } from "./fixtures";

const teams = { ...org, tier: "teams", trialEndsAt: null, drives: [{ ...drive, alias: "space" }] };
/**
 * The shell on the Account page, so the sidebar is the only thing under test.
 * `handle` answers drive writes; anything else a drive page asks for gets a harmless reply.
 */
function backend(handle: (url: string, init: RequestInit) => Response | undefined, orgs: () => unknown[] = () => [teams]) {
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method && init.method !== "GET" && !url.endsWith("/token")) { const answer = handle(url, init); if (answer) return answer; }
    if (url.endsWith("/orgs")) return json({ orgs: orgs() });
    if (url.endsWith("/me/access")) return json({ workspaces: [] });
    if (url.endsWith("/me")) return json({ email: "you@example.com", displayName: null });
    if (url.endsWith("/token")) return json({ token: "read", expiresAt: Date.now() + 900_000, endpoint: "https://data.example", driveId: drive.id });
    if (url.includes("/list?")) return json({ entries: [], cursor: null });
    return json(drive);
  });
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}
const writes = (fetcher: ReturnType<typeof vi.fn>) => fetcher.mock.calls.filter(([url, init]) => init?.method && init.method !== "GET" && !url.endsWith("/token")).map(([url, init]) => `${init.method} ${new URL(url).pathname}${new URL(url).search}`);
async function openMenu(user: ReturnType<typeof userEvent.setup>, item: RegExp) {
  await user.click(await screen.findByRole("button", { name: "Options for Space" }));
  await user.click(screen.getByRole("menuitem", { name: item }));
  return within(screen.getByRole("dialog"));
}

it("creates a drive from the sidebar and explains a plan limit without closing the dialog", async () => {
  let allowed = false;
  const created = { ...drive, id: "d-new", name: "Another drive" };
  const fetcher = backend((_url, init) => {
    expect(JSON.parse(String(init.body))).toEqual({ name: "Another drive" });
    return allowed ? json(created, 201) : json({ error: "plan_limit" }, 403);
  });
  const user = userEvent.setup();
  renderApp("/settings");
  await user.click(await screen.findByRole("button", { name: "New drive" }));
  const dialog = within(screen.getByRole("dialog", { name: "New drive" }));
  expect(dialog.getByText(/A drive holds files for My Space/)).toBeInTheDocument();
  expect(dialog.getByRole("button", { name: "Create drive" })).toBeDisabled();
  expect(dialog.queryByText("Advanced")).not.toBeInTheDocument();
  await user.type(dialog.getByLabelText("Drive name"), "Another drive");
  await user.click(dialog.getByRole("button", { name: "Create drive" }));
  expect(await dialog.findByRole("alert")).toHaveTextContent("Individual plan includes one drive");
  expect(dialog.getByLabelText("Drive name")).toHaveValue("Another drive");
  allowed = true;
  await user.click(dialog.getByRole("button", { name: "Create drive" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(writes(fetcher)).toEqual(["POST /orgs/o_test/drives", "POST /orgs/o_test/drives"]);
});

it("renames from the drive menu, keeping the bucket name under Advanced and conflicts editable", async () => {
  let taken = true;
  const fetcher = backend((_url, init) => {
    if (init.method !== "PATCH") return undefined;
    return taken ? json({ error: "alias_taken" }, 409) : json({ ...drive, ...JSON.parse(String(init.body)) });
  });
  const user = userEvent.setup();
  renderApp("/settings");
  const dialog = await openMenu(user, /Rename/);
  expect(dialog.getByLabelText("Drive name")).toHaveValue("Space");
  expect(dialog.getByLabelText("Drive name")).toHaveFocus();
  // Plain words by default: the technical name only appears once Advanced is opened.
  expect(dialog.getByText("Advanced").closest("details")).not.toHaveAttribute("open");
  await user.clear(dialog.getByLabelText("Drive name"));
  await user.type(dialog.getByLabelText("Drive name"), "Archive");
  await user.click(dialog.getByText("Advanced"));
  const bucket = dialog.getByLabelText("Bucket name for S3 tools");
  expect(bucket).toHaveValue("space");
  await user.clear(bucket); await user.type(bucket, "taken");
  await user.click(dialog.getByRole("button", { name: "Save" }));
  expect(await dialog.findByRole("alert")).toHaveTextContent("Another drive already uses that bucket name");
  expect(bucket).toHaveValue("taken");
  expect(JSON.parse(String(fetcher.mock.calls.filter(([, init]) => init?.method === "PATCH").pop()![1]!.body))).toEqual({ name: "Archive", alias: "taken" });
  taken = false;
  await user.clear(bucket); await user.type(bucket, "archive");
  await user.click(dialog.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(writes(fetcher)).toEqual(["PATCH /drives/d-test", "PATCH /drives/d-test"]);
});

it("makes a copy in plain words, lets Orbit pick the bucket name, and explains the copy limit", async () => {
  let limited = true;
  const child = { ...drive, id: "d-child", name: "Space copy", alias: "space-copy", forkOf: { driveId: drive.id, forkPoint: 1000 }, forks: [] };
  const fetcher = backend((url, init) => {
    if (!url.endsWith("/fork")) return undefined;
    return limited ? json({ error: "plan_limit" }, 403) : json({ ...child, ...JSON.parse(String(init.body)) }, 201);
  });
  const user = userEvent.setup();
  renderApp("/settings");
  const dialog = await openMenu(user, /Make a copy/);
  expect(screen.getByRole("dialog", { name: "Make a copy of “Space”" })).toBeInTheDocument();
  expect(dialog.getByText("The copy is ready instantly. It shares this drive's files and history up to now; from then on the two change independently.")).toBeInTheDocument();
  expect(dialog.getByLabelText("Name for the copy")).toHaveValue("Space copy");
  const advanced = dialog.getByText("Advanced").closest("details")!;
  expect(advanced).not.toHaveAttribute("open");
  // Outside Advanced the dialog never says alias, lineage, fork or fork point.
  const plain = screen.getByRole("dialog").cloneNode(true) as HTMLElement;
  plain.querySelector("details")!.remove();
  expect(plain.textContent).not.toMatch(/alias|lineage|fork/i);
  await user.click(dialog.getByRole("button", { name: "Make a copy" }));
  expect(await dialog.findByRole("alert")).toHaveTextContent("This workspace already has 50 copies");
  expect(JSON.parse(String(fetcher.mock.calls.filter(([url]) => url.endsWith("/fork")).pop()![1]!.body))).toEqual({ name: "Space copy" });
  limited = false;
  await user.click(dialog.getByText("Advanced"));
  expect(within(advanced).getByText(/fork point/)).toBeInTheDocument();
  await user.type(dialog.getByLabelText("Bucket name for S3 tools (optional)"), "branch");
  await user.click(dialog.getByRole("button", { name: "Make a copy" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(JSON.parse(String(fetcher.mock.calls.filter(([url]) => url.endsWith("/fork")).pop()![1]!.body))).toEqual({ name: "Space copy", alias: "branch" });
});

it("says what deleting does and that it cannot be undone, and requires the exact drive name", async () => {
  const fetcher = backend((_url, init) => init.method === "DELETE" ? json({ ok: true }) : undefined);
  const user = userEvent.setup();
  renderApp("/settings");
  const dialog = await openMenu(user, /Delete/);
  expect(screen.getByRole("dialog", { name: "Delete “Space”?" })).toBeInTheDocument();
  expect(dialog.getByText(/disappear right away for everyone who uses it/)).toBeInTheDocument();
  // The API keeps a deleted drive's data but offers no restore and no recovery period, so the dialog must not promise one.
  expect(dialog.getByText("A deleted drive can't be brought back.")).toBeInTheDocument();
  expect(dialog.getByText(/no recovery period/)).toBeInTheDocument();
  expect(dialog.getByText(/Its data is not erased and still counts towards your storage/)).toBeInTheDocument();
  const confirm = dialog.getByRole("button", { name: "Delete drive" });
  expect(confirm).toBeDisabled();
  await user.type(dialog.getByLabelText("Type “Space” to confirm"), "space");
  expect(confirm).toBeDisabled();
  await user.clear(dialog.getByLabelText("Type “Space” to confirm"));
  await user.type(dialog.getByLabelText("Type “Space” to confirm"), "Space");
  expect(writes(fetcher)).toEqual([]);
  await user.click(confirm);
  await waitFor(() => expect(writes(fetcher)).toEqual(["DELETE /drives/d-test"]));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
});

it("erases a drive's data only from Advanced, with the same confirmation, and explains when copies prevent it", async () => {
  const fetcher = backend((_url, init) => init.method === "DELETE" ? json({ error: "drive_has_forks" }, 409) : undefined);
  const user = userEvent.setup();
  renderApp("/settings");
  const dialog = await openMenu(user, /Delete/);
  expect(dialog.getByText("Advanced").closest("details")).not.toHaveAttribute("open");
  await user.click(dialog.getByText("Advanced"));
  await user.click(dialog.getByRole("checkbox", { name: "Also erase this drive's data permanently" }));
  expect(dialog.getByText("Its data is erased for good, including every earlier version.")).toBeInTheDocument();
  const confirm = dialog.getByRole("button", { name: "Delete and erase" });
  expect(confirm).toBeDisabled();
  await user.type(dialog.getByLabelText("Type “Space” to confirm"), "Space");
  await user.click(confirm);
  expect(await dialog.findByRole("alert")).toHaveTextContent("Copies of this drive still rely on its data, so it can't be erased.");
  expect(writes(fetcher)).toEqual(["DELETE /drives/d-test?hard=1"]);
  expect(screen.getByRole("dialog")).toBeInTheDocument();
});

it("offers no drive management to people who cannot manage the workspace", async () => {
  backend(() => undefined, () => [{ ...teams, role: "member" }]);
  const user = userEvent.setup();
  renderApp("/settings");
  await user.click(await screen.findByRole("button", { name: "Options for Space" }));
  expect(screen.getByRole("menuitem", { name: "Open in Finder" })).toBeInTheDocument();
  expect(screen.queryByRole("menuitem", { name: /Rename|Make a copy|Delete/ })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "New drive" })).not.toBeInTheDocument();
});
