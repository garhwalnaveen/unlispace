import { File } from "node:buffer";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Drive } from "../src/api";
import { MAC_APP_DOWNLOAD_URL } from "../src/onboarding/config";
import { s3Endpoint, snippet as s3Snippet } from "../src/settings/s3";
const S3_ENDPOINT = s3Endpoint()!;
import { noteSignIn, readOnboarding, startOnboarding, writeOnboarding } from "../src/onboarding/state";
import { uploadFile } from "../src/upload";
import { deferred, drive, json, renderApp, session } from "./fixtures";

vi.mock("../src/upload", async (original) => ({ ...(await original<typeof import("../src/upload")>()), uploadFile: vi.fn() }));
const upload = vi.mocked(uploadFile);

const DAY = 86_400_000;
const secret = { accessKeyId: "ULS1ABCDEFGHIJKLMNOP", secretAccessKey: "s3cr3t/with+symbols", workspaceId: drive.orgId, label: "Getting started", access: "write", drives: [drive.id], parent: null, createdAt: 1, lastUsedAt: null, revokedAt: null };
interface Options { drives?: Partial<Drive>[]; role?: string; keys?: () => Response; orgs?: () => Response | undefined }
function welcomeFetch({ drives = [drive], role = "owner", keys = () => json(secret, 201), orgs = () => undefined }: Options = {}) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/orgs")) return orgs() ?? json({ orgs: [{ id: drive.orgId, name: "My Space", role, tier: "individual", trialPending: false, trialEndsAt: Date.now() + 7 * DAY, drives }] });
    if (url.endsWith("/me/access")) return json({ user: session.user, workspaces: [] });
    if (url.endsWith("/keys") && init?.method === "POST") return keys();
    if (url.endsWith("/keys")) return json({ keys: [] });
    if (url.endsWith("/token")) return json({ token: "drive", endpoint: "https://data.example", expiresAt: Date.now() + 900_000, driveId: drive.id });
    if (url.includes("/list?")) return json({ entries: [], cursor: null });
    return json(drive);
  });
}
const heading = () => screen.getByRole("heading", { level: 1 });
const choose = (name: RegExp) => screen.findByRole("button", { name });
const leftWelcome = () => waitFor(() => expect(screen.getByRole("navigation", { name: "Main navigation" })).toBeInTheDocument());

beforeEach(() => { startOnboarding(session.user.id); upload.mockReset(); });

describe("welcome question", () => {
  it("shows one promise and three ways to start, without the sidebar", async () => {
    vi.stubGlobal("fetch", welcomeFetch());
    renderApp("/");
    expect(await screen.findByRole("heading", { level: 1, name: "Welcome to Orbit" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "How will you use Orbit?" })).toBeInTheDocument();
    const choices = within(screen.getByRole("group", { name: "How will you use Orbit?" })).getAllByRole("button");
    expect(choices.map((choice) => choice.querySelector("strong")?.textContent)).toEqual(["On my Mac", "With an agent or S3 tool", "In the browser"]);
    expect(screen.getByText("Step 1 of 2")).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Main navigation" })).not.toBeInTheDocument();
  });

  it("can be skipped, which goes to the files and leaves every step on the Get started list", async () => {
    vi.stubGlobal("fetch", welcomeFetch());
    renderApp("/welcome");
    await userEvent.click(await screen.findByRole("button", { name: "Skip for now" }));
    await leftWelcome();
    expect(readOnboarding()).toMatchObject({ status: "done" });
    expect(readOnboarding()?.path).toBeUndefined();
    expect(await screen.findByRole("region", { name: "Get started" })).toHaveTextContent("0 of 3 done");
    expect(screen.queryByRole("heading", { name: "Welcome to Orbit" })).not.toBeInTheDocument();
  });

  it("is not shown again once it has been finished", async () => {
    writeOnboarding({ status: "done" });
    vi.stubGlobal("fetch", welcomeFetch());
    renderApp("/");
    await leftWelcome();
    expect(screen.queryByRole("heading", { name: "Welcome to Orbit" })).not.toBeInTheDocument();
  });
});

describe("on my Mac", () => {
  it("offers the download, then how to sign in and where the drive appears", async () => {
    vi.stubGlobal("fetch", welcomeFetch());
    vi.spyOn(console, "error").mockImplementation(() => {});
    const user = userEvent.setup();
    renderApp("/welcome");
    await user.click(await choose(/On my Mac/));
    expect(heading()).toHaveTextContent("Get Orbit for Mac");
    expect(screen.getByText("Step 2 of 2")).toBeInTheDocument();
    const steps = within(screen.getByRole("list")).getAllByRole("listitem").map((item) => item.querySelector("strong")?.textContent);
    expect(steps).toEqual(["Download Orbit", "Open Orbit and sign in", "Find your drive in Finder"]);
    const download = screen.getByRole("link", { name: "Download for Mac" });
    expect(download).toHaveAttribute("href", MAC_APP_DOWNLOAD_URL);
    expect(screen.queryByRole("button", { name: "Continue to your files" })).not.toBeInTheDocument();
    fireEvent.click(download);
    expect(screen.getByRole("link", { name: "Download again" })).toHaveAttribute("href", MAC_APP_DOWNLOAD_URL);
    await user.click(screen.getByRole("button", { name: "Continue to your files" }));
    await leftWelcome();
    expect(readOnboarding()).toMatchObject({ status: "done", path: "mac" });
    // Downloading is not the same as connecting: the step stays open until the app signs in.
    expect(readOnboarding()?.macOpened).toBeUndefined();
  });

  it("goes back to the question", async () => {
    vi.stubGlobal("fetch", welcomeFetch());
    const user = userEvent.setup();
    renderApp("/welcome");
    await user.click(await choose(/On my Mac/));
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(heading()).toHaveTextContent("Welcome to Orbit");
    expect(readOnboarding()?.status).toBe("pending");
  });
});

describe("with an agent or S3 tool", () => {
  it("creates a key for the first drive in one click and shows the secret once with working settings", async () => {
    const fetcher = welcomeFetch({ drives: [{ ...drive, alias: "team-files" }] });
    vi.stubGlobal("fetch", fetcher);
    const user = userEvent.setup();
    renderApp("/welcome");
    await user.click(await choose(/agent or S3 tool/));
    expect(await screen.findByRole("heading", { level: 1, name: "Connect a tool or agent" })).toBeInTheDocument();
    expect(fetcher.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
    await user.click(screen.getByRole("button", { name: "Create access key" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Save your secret now" })).toBeInTheDocument();
    const request = fetcher.mock.calls.find(([url, init]) => url.endsWith("/keys") && init?.method === "POST");
    expect(JSON.parse(String(request?.[1]?.body))).toEqual({ workspaceId: drive.orgId, label: "Getting started", access: "write", drives: [drive.id] });
    const values = Object.fromEntries(Array.from(document.querySelectorAll(".ob-fields > div"), (row) => [row.querySelector("dt")?.textContent, row.querySelector("dd")?.textContent]));
    expect(values).toEqual({ "Access key ID": secret.accessKeyId, "Secret access key": secret.secretAccessKey, Endpoint: S3_ENDPOINT, Bucket: "team-files" });
    const panel = screen.getByRole("tabpanel");
    expect(screen.getByRole("tab", { name: "Environment variables" })).toHaveAttribute("aria-selected", "true");
    expect(panel).toHaveTextContent(`export AWS_ENDPOINT_URL='${S3_ENDPOINT}'`);
    await user.click(screen.getByRole("tab", { name: "AWS CLI" }));
    expect(panel).toHaveTextContent(`aws s3 ls 's3://team-files/' --endpoint-url '${S3_ENDPOINT}' --region auto`);
    await user.click(screen.getByRole("tab", { name: "rclone" }));
    expect(panel).toHaveTextContent("rclone ls 'orbit:team-files'");
    expect(panel).toHaveTextContent("rclone copy --ignore-checksum ./notes.txt 'orbit:team-files'");
    const copied = vi.spyOn(navigator.clipboard, "writeText");
    await user.click(screen.getByRole("button", { name: "Copy commands" }));
    expect(copied).toHaveBeenLastCalledWith(s3Snippet("rclone", { ...secret, endpoint: S3_ENDPOINT, bucket: "team-files" }));
    await user.click(screen.getByRole("button", { name: "Copy secret access key" }));
    expect(copied).toHaveBeenLastCalledWith(secret.secretAccessKey);
    copied.mockRejectedValueOnce(new Error("blocked"));
    await user.click(screen.getByRole("button", { name: "Copy bucket" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not copy. Select the text and copy it yourself.");
    // The secret cannot be lost to a stray Back or Skip.
    expect(screen.queryByRole("button", { name: "Back" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Skip for now" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "I saved the secret" }));
    await leftWelcome();
    expect(readOnboarding()).toMatchObject({ status: "done", path: "tools", keyCreated: true });
  });

  it("uses the drive ID as the bucket when the drive has no other name, and a read key for view-only access", async () => {
    const fetcher = welcomeFetch({ drives: [{ ...drive, access: "read" }], role: "viewer" });
    vi.stubGlobal("fetch", fetcher);
    const user = userEvent.setup();
    renderApp("/welcome?path=tools");
    expect(await screen.findByText(/can then read its files/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Create access key" }));
    await screen.findByRole("heading", { level: 1, name: "Save your secret now" });
    const request = fetcher.mock.calls.find(([url, init]) => url.endsWith("/keys") && init?.method === "POST");
    expect(JSON.parse(String(request?.[1]?.body)).access).toBe("read");
    expect(screen.getByRole("tabpanel").textContent).not.toContain("s3://");
    await user.click(screen.getByRole("tab", { name: "AWS CLI" }));
    expect(screen.getByRole("tabpanel")).toHaveTextContent(`s3://${drive.id}/`);
  });

  it("explains a refused key in plain words and lets the person try again", async () => {
    let attempts = 0;
    vi.stubGlobal("fetch", welcomeFetch({ keys: () => (++attempts === 1 ? json({ error: "keys_not_configured" }, 503) : json(secret, 201)) }));
    const user = userEvent.setup();
    renderApp("/welcome?path=tools");
    await user.click(await screen.findByRole("button", { name: "Create access key" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Access keys are not configured on this server yet.");
    expect(readOnboarding()?.keyCreated).toBeUndefined();
    expect(screen.getByRole("button", { name: "Skip for now" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Create access key" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Save your secret now" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("quotes every value so a pasted snippet cannot run something else", () => {
    const key = { accessKeyId: "ULS1ID", secretAccessKey: "a'b; rm -rf ~" };
    for (const kind of ["env", "aws", "rclone"] as const) {
      const snippet = s3Snippet(kind, { ...key, bucket: "bucket", endpoint: "https://s3.example" });
      expect(snippet).toContain("'a'\\''b; rm -rf ~'");
      expect(snippet).toContain("'https://s3.example'");
      expect(snippet).toContain("auto");
    }
  });
});

describe("in the browser", () => {
  const files = [new File(["a"], "a.txt"), new File(["bb"], "b.txt")] as unknown as globalThis.File[];
  it("uploads the chosen files into the first ready drive, one at a time, then opens the files", async () => {
    const first = deferred<void>();
    upload.mockImplementationOnce(async (_api, file, _path, progress) => { progress({ phase: "uploading", bytes: 0, total: file.size }); await first.promise; }).mockResolvedValue(undefined);
    vi.stubGlobal("fetch", welcomeFetch({ drives: [{ ...drive, id: "d-broken", status: "provisioning_failed" }, drive] }));
    const user = userEvent.setup();
    renderApp("/welcome");
    await user.click(await choose(/In the browser/));
    expect(await screen.findByRole("heading", { level: 1, name: "Add your first files" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open your files" })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Choose files to upload"), { target: { files } });
    const rows = () => within(screen.getByRole("list", { name: "Uploads" })).getAllByRole("listitem");
    await waitFor(() => expect(rows()[0]).toHaveTextContent("Uploading…"));
    expect(rows()[1]).toHaveTextContent("Waiting");
    expect(upload).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("progressbar", { name: "Upload progress for a.txt" })).toBeInTheDocument();
    await act(async () => { first.resolve(); });
    await waitFor(() => expect(rows().map((row) => row.textContent)).toEqual(["a.txtUploaded", "b.txtUploaded"]));
    expect(upload.mock.calls.map(([api, file, path]) => [api.id, file.name, path])).toEqual([[drive.id, "a.txt", "a.txt"], [drive.id, "b.txt", "b.txt"]]);
    await user.click(screen.getByRole("button", { name: "Open your files" }));
    await leftWelcome();
    expect(readOnboarding()).toMatchObject({ status: "done", path: "browser", uploaded: true });
  });

  it("keeps a failed file on the list with the reason and retries only that file", async () => {
    upload.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("This file name is not supported. Rename it before uploading.")).mockResolvedValue(undefined);
    vi.stubGlobal("fetch", welcomeFetch());
    renderApp("/welcome?path=browser");
    fireEvent.change(await screen.findByLabelText("Choose files to upload"), { target: { files } });
    expect(await screen.findByRole("alert")).toHaveTextContent("This file name is not supported");
    expect(screen.getByRole("button", { name: "Open your files" })).toBeEnabled();
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(upload).toHaveBeenCalledTimes(3);
    expect(upload.mock.calls[2][1].name).toBe("b.txt");
  });

  it("accepts files dropped anywhere on the page and ignores drags that are not files", async () => {
    upload.mockResolvedValue(undefined);
    vi.stubGlobal("fetch", welcomeFetch());
    renderApp("/welcome?path=browser");
    await screen.findByLabelText("Choose files to upload");
    fireEvent.drop(window, { dataTransfer: { files: [], types: ["text/plain"] } });
    expect(upload).not.toHaveBeenCalled();
    fireEvent.dragOver(window, { dataTransfer: { files: [], types: ["Files"] } });
    expect(screen.getByText("Drop to upload")).toBeInTheDocument();
    fireEvent.drop(window, { dataTransfer: { files: [files[0]], types: ["Files"] } });
    expect(await screen.findByText("Uploaded")).toBeInTheDocument();
    expect(upload).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Drop to upload")).not.toBeInTheDocument();
  });

  it("does not offer uploads to someone who can only view the drive", async () => {
    vi.stubGlobal("fetch", welcomeFetch({ drives: [{ ...drive, access: "read" }], role: "viewer" }));
    renderApp("/welcome?path=browser");
    expect(await screen.findByRole("heading", { level: 1, name: "You can view this drive" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Choose files to upload")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open your files" })).toBeInTheDocument();
  });
});

describe("while the first drive is being set up", () => {
  const pending = [{ ...drive, status: "provisioning_failed" as const }];
  async function open(fetcher: ReturnType<typeof welcomeFetch>) {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", fetcher);
    await act(async () => { renderApp("/welcome?path=tools"); });
    return () => fetcher.mock.calls.filter(([url]) => url.endsWith("/orgs")).length;
  }
  it("waits calmly and continues by itself when the drive is ready", async () => {
    let ready = false;
    const checks = await open(welcomeFetch({ orgs: () => (ready ? undefined : json({ orgs: [{ id: drive.orgId, name: "My Space", role: "owner", tier: "individual", trialPending: true, trialEndsAt: null, drives: pending }] })) }));
    expect(heading()).toHaveTextContent("Setting up your drive");
    expect(screen.getByRole("status")).toHaveTextContent("Creating your first drive…");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Skip for now" })).toBeInTheDocument();
    expect(checks()).toBe(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(checks()).toBe(2);
    ready = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(heading()).toHaveTextContent("Connect a tool or agent");
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(checks()).toBe(3);
  });

  it("stops checking after a while, reassures, and checks again on request", async () => {
    let ready = false;
    const checks = await open(welcomeFetch({ orgs: () => (ready ? undefined : json({ orgs: [{ id: drive.orgId, name: "My Space", role: "owner", tier: "individual", trialPending: true, trialEndsAt: null, drives: pending }] })) }));
    for (let i = 0; i < 20; i++) await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(checks()).toBe(11);
    expect(heading()).toHaveTextContent("Your drive isn't ready yet");
    expect(screen.getByText(/Your account is safe/)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    ready = true;
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Try again" })); });
    expect(heading()).toHaveTextContent("Connect a tool or agent");
    expect(checks()).toBe(12);
  });

  it("shows a connection problem with a way to retry", async () => {
    let online = false;
    await open(welcomeFetch({ orgs: () => (online ? undefined : json({ error: "request_failed", message: "Check your connection." }, 503)) }));
    expect(heading()).toHaveTextContent("Your drive isn't ready yet");
    expect(screen.getByRole("alert")).toHaveTextContent("Check your connection.");
    online = true;
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Try again" })); });
    expect(heading()).toHaveTextContent("Connect a tool or agent");
  });

  it("does not need a drive for the Mac route", async () => {
    await open(welcomeFetch({ drives: pending }));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Back" })); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /On my Mac/ })); });
    expect(heading()).toHaveTextContent("Get Orbit for Mac");
  });
});

describe("onboarding state", () => {
  it("starts once for a new account and never overwrites progress", () => {
    localStorage.clear();
    noteSignIn("u_new", true);
    expect(readOnboarding()).toEqual({ status: "pending", user: "u_new" });
    writeOnboarding({ status: "done", keyCreated: true });
    noteSignIn("u_new", true);
    expect(readOnboarding()).toEqual({ status: "done", user: "u_new", keyCreated: true });
  });
  it("drops another account's progress on sign-in and ignores unreadable values", () => {
    noteSignIn("u_other", false);
    expect(readOnboarding()).toBeNull();
    localStorage.setItem("orbit.onboarding", "{not json");
    expect(readOnboarding()).toBeNull();
    localStorage.setItem("orbit.onboarding", JSON.stringify({ status: "unknown" }));
    expect(readOnboarding()).toBeNull();
  });
});
