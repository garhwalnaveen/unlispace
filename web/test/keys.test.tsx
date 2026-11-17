import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { bucketName, s3Endpoint, snippet } from "../src/settings/s3";
import { drive, json, org, renderApp } from "./fixtures";

const key = { accessKeyId: "ULS1ABCDEFGHIJKLMNOP", workspaceId: org.id, label: "Backup", access: "write", drives: [drive.id], parent: null, createdAt: 1, lastUsedAt: null, revokedAt: null };
/** Answers the shell's own requests; returns undefined for anything a test must handle itself. */
function shell(url: string, orgs: unknown[] = [org]) {
  if (url.endsWith("/orgs")) return json({ orgs });
  if (url.endsWith("/me/access")) return json({ workspaces: [] });
  return undefined;
}
const calls = (fetcher: ReturnType<typeof vi.fn>, method: string) => fetcher.mock.calls.filter(([, init]) => init?.method === method);

it("starts from the list, creates a scoped key in a dialog, shows its secret once with ready-to-paste setup, then confirms revocation", async () => {
  let created = false;
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    const known = shell(url); if (known) return known;
    if (init?.method === "POST") {
      expect(JSON.parse(String(init.body))).toEqual({ workspaceId: org.id, label: "Backup", access: "write", drives: [drive.id] });
      created = true; return json({ ...key, secretAccessKey: "one-time-secret" }, 201);
    }
    if (init?.method === "DELETE") { expect(url).toContain(key.accessKeyId); return json({ ok: true }); }
    return json({ keys: created ? [key] : [] });
  });
  vi.stubGlobal("fetch", fetcher);
  const user = userEvent.setup();
  renderApp("/settings/access-keys");
  expect(await screen.findByRole("heading", { name: "No access keys yet" })).toBeInTheDocument();
  expect(screen.queryByLabelText("Name")).not.toBeInTheDocument();
  await user.click(await screen.findByRole("button", { name: "New key" }));
  const dialog = within(screen.getByRole("dialog", { name: "New access key" }));
  // One workspace: it is named, not asked for.
  expect(dialog.queryByLabelText("Workspace")).not.toBeInTheDocument();
  expect(dialog.getByText(/The key works in My Space/)).toBeInTheDocument();
  const create = dialog.getByRole("button", { name: "Create key" });
  expect(create).toBeDisabled();
  await user.type(dialog.getByLabelText("Name"), "Backup");
  await user.click(dialog.getByRole("radio", { name: /Read and write/ }));
  await user.click(dialog.getByRole("radio", { name: /Only some drives/ }));
  expect(create).toBeDisabled();
  await user.click(dialog.getByRole("checkbox", { name: "Space" }));
  await user.click(create);

  const secret = within(await screen.findByRole("dialog", { name: "Save your secret now" }));
  expect(secret.getByText("one-time-secret")).toBeInTheDocument();
  const endpoint = s3Endpoint()!;
  expect(endpoint).toBe("http://127.0.0.1:8789");
  expect(secret.getByText(endpoint)).toBeInTheDocument();
  const copy = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  await user.click(secret.getByRole("button", { name: "Copy Environment variables" }));
  expect(copy).toHaveBeenLastCalledWith(`export AWS_ACCESS_KEY_ID='${key.accessKeyId}'\nexport AWS_SECRET_ACCESS_KEY='one-time-secret'\nexport AWS_ENDPOINT_URL='${endpoint}'\nexport AWS_DEFAULT_REGION='auto'`);
  await user.click(secret.getByRole("button", { name: "Copy secret access key" }));
  expect(copy).toHaveBeenLastCalledWith("one-time-secret");
  await user.click(secret.getByRole("tab", { name: "AWS CLI" }));
  expect(secret.getByTestId("snippet")).toHaveTextContent(`aws s3 ls 's3://${drive.id}/' --endpoint-url '${endpoint}' --region auto`);
  await user.click(secret.getByRole("tab", { name: "rclone" }));
  expect(secret.getByTestId("snippet")).toHaveTextContent(`endpoint='${endpoint}' region=auto force_path_style=true`);
  expect(secret.getByTestId("snippet")).toHaveTextContent(`rclone ls 'orbit:${drive.id}'`);
  // A stray Escape must not lose the only copy of the secret.
  await user.keyboard("{Escape}");
  expect(secret.getByText("one-time-secret")).toBeInTheDocument();
  await user.click(secret.getByRole("button", { name: "I've saved it" }));
  expect(screen.queryByText("one-time-secret")).not.toBeInTheDocument();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(localStorage.getItem("orbit.refreshToken")).toBeNull();

  const row = within((await screen.findByText("Backup")).closest("tr")!);
  expect(row.getByText("Space")).toBeInTheDocument();
  expect(row.getByText("Read and write")).toBeInTheDocument();
  expect(row.getByText("Never")).toBeInTheDocument();
  await user.click(row.getByRole("button", { name: "Revoke Backup" }));
  expect(calls(fetcher, "DELETE")).toHaveLength(0);
  expect(screen.getByRole("dialog")).toHaveTextContent("loses access right away");
  await user.click(screen.getByRole("button", { name: "Revoke key" }));
  await waitFor(() => expect(calls(fetcher, "DELETE")).toHaveLength(1));
});

it("keeps the dialog and its input when creation fails, and reaches all drives by default", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const known = shell(url); if (known) return known;
    if (init?.method === "POST") { expect(JSON.parse(String(init.body))).toMatchObject({ access: "read", drives: null }); return json({ error: "keys_not_configured" }, 503); }
    return json({ keys: [] });
  }));
  renderApp("/settings/access-keys");
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "New key" }));
  await user.type(screen.getByLabelText("Name"), "Tools");
  expect(screen.getByRole("radio", { name: /All drives/ })).toBeChecked();
  await user.click(screen.getByRole("button", { name: "Create key" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Access keys are not configured");
  expect(screen.getByLabelText("Name")).toHaveValue("Tools");
});

it("offers only the access a role allows and asks for the workspace when there are several", async () => {
  const other = { ...org, id: "o_other", name: "Client", role: "viewer", drives: [] };
  vi.stubGlobal("fetch", vi.fn(async (url: string) => shell(url, [org, other]) ?? json({ keys: [] })));
  renderApp("/settings/access-keys");
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "New key" }));
  expect(screen.getAllByRole("radio", { name: /Read only|Read and write|Full control/ })).toHaveLength(3);
  await user.selectOptions(screen.getByLabelText("Workspace"), "o_other");
  expect(screen.getByRole("radio", { name: /Read only/ })).toBeChecked();
  expect(screen.queryByRole("radio", { name: /Read and write/ })).not.toBeInTheDocument();
  expect(screen.getByText(/allows read-only keys/)).toBeInTheDocument();
});

it("groups keys made from another key under it and revokes them together", async () => {
  const base = { workspaceId: org.id, access: "read", drives: null, createdAt: 1, lastUsedAt: null, revokedAt: null };
  let revoked = false;
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    const known = shell(url); if (known) return known;
    if (init?.method === "DELETE") { expect(url).toMatch(/\/keys\/parent$/); revoked = true; return json({ ok: true }); }
    return json({ keys: [ { ...base, accessKeyId: "grandchild", label: "Grandchild", parent: "child" }, { ...base, accessKeyId: "child", label: "Child", parent: "parent" }, { ...base, accessKeyId: "parent", label: "Parent", parent: null } ].map((item) => ({ ...item, revokedAt: revoked ? 2000 : null })) });
  });
  vi.stubGlobal("fetch", fetcher); renderApp("/settings/access-keys"); const user = userEvent.setup();
  await screen.findByText("Parent");
  expect(screen.getAllByRole("row").slice(1).map((row) => within(row).getAllByRole("cell")[0].querySelector("strong")!.textContent)).toEqual(["Parent", "Child", "Grandchild"]);
  expect(within(screen.getByText("Child").closest("tr")!).getByText("Made from Parent")).toBeInTheDocument();
  expect(within(screen.getByText("Grandchild").closest("tr")!).getByText("All drives, including new ones")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Revoke Parent" }));
  expect(screen.getByRole("dialog")).toHaveTextContent("2 keys made from it will be revoked too: Child, Grandchild.");
  await user.click(screen.getByRole("button", { name: "Revoke key" }));
  await waitFor(() => expect(screen.queryByRole("button", { name: "Revoke Child" })).not.toBeInTheDocument());
  expect(screen.getAllByText(/^Revoked /)).toHaveLength(3);
});

it("explains a failed list, retries it, and keeps the confirmation open when revoking fails", async () => {
  let failures = 1;
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    const known = shell(url); if (known) return known;
    if (init?.method === "DELETE") return json({ error: "forbidden" }, 403);
    if (failures-- > 0) return json({ error: "internal" }, 500);
    return json({ keys: [key] });
  });
  vi.stubGlobal("fetch", fetcher); renderApp("/settings/access-keys"); const user = userEvent.setup();
  expect(await screen.findByRole("alert")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Try again" }));
  await user.click(await screen.findByRole("button", { name: "Revoke Backup" }));
  await user.click(screen.getByRole("button", { name: "Revoke key" }));
  expect(await within(screen.getByRole("dialog")).findByRole("alert")).toHaveTextContent("You do not have permission");
  expect(screen.getByRole("button", { name: "Revoke key" })).toBeEnabled();
});

it("derives the S3 endpoint from the deployment, names buckets as the gateway does and quotes snippets safely", () => {
  expect(s3Endpoint("https://unlispace-api.example.workers.dev", undefined)).toBe("https://unlispace-s3.example.workers.dev");
  expect(s3Endpoint("http://localhost:8788", undefined)).toBe("http://localhost:8789");
  expect(s3Endpoint("https://api.example.com", undefined)).toBeNull();
  expect(s3Endpoint("https://api.example.com", "https://s3.example.com/")).toBe("https://s3.example.com");
  expect(bucketName({ id: "d-test", alias: "photos" })).toBe("photos");
  expect(bucketName({ id: "d-test", alias: null })).toBe("d-test");
  const input = { accessKeyId: "ID", secretAccessKey: "it's", endpoint: null, bucket: null };
  expect(snippet("env", input)).toContain(`AWS_SECRET_ACCESS_KEY='it'\\''s'`);
  expect(snippet("aws", input)).toContain("s3://YOUR-DRIVE/");
  expect(snippet("rclone", input)).toContain("endpoint='https://YOUR-ORBIT-S3-ENDPOINT'");
});
