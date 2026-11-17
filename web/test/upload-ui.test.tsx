import { File } from "node:buffer";
import { fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it } from "vitest";
import { backend, file, missing } from "./files-backend";
import { drive, json, renderApp } from "./fixtures";

const tray = () => screen.getByRole("region", { name: "Uploads and downloads" });
const note = () => new File(["hello"], "note.txt") as unknown as globalThis.File;
const pick = (...files: globalThis.File[]) => fireEvent.change(screen.getByLabelText("Choose files to upload"), { target: { files } });

it("uploads a dropped file into the open folder, shows it in the tray and refreshes the list", async () => {
  const folders = { "": [] as ReturnType<typeof file>[] };
  const { sent } = backend({
    folders,
    data: (route, _url, _init, body) => {
      if (route === "commit") { folders[""] = [file("note.txt", 5)]; expect(body.ops).toMatchObject([{ op: "put", path: "note.txt", ifAbsent: true, size: 5 }]); }
      return undefined;
    },
  });
  renderApp(`/drives/${drive.id}/`);
  expect(await screen.findByRole("heading", { name: "Nothing in this drive yet" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Upload files" })).toBeInTheDocument();
  fireEvent.drop(screen.getByRole("heading", { name: "Nothing in this drive yet" }), { dataTransfer: { files: [note()] } });
  expect(await within(await screen.findByRole("region", { name: "Uploads and downloads" })).findByText("1 file uploaded")).toBeInTheDocument();
  expect(within(tray()).getByText("Uploaded · 5 B")).toBeInTheDocument();
  expect(await screen.findByRole("link", { name: "note.txt" })).toBeInTheDocument();
  expect(sent("list")).toHaveLength(2);
  expect(sent("commit")[0].headers.get("Authorization")).toBe("Bearer drive-write");
});

it("asks before touching a file that already exists: Replace saves a new version, Keep both uploads a copy", async () => {
  const { sent } = backend({
    folders: { "": [file("note.txt", 3, 1000, "v_OLD")] },
    data: (route, url) => (route === "stat" && url.searchParams.get("path") === "note (2).txt" ? missing() : undefined),
  });
  renderApp(`/drives/${drive.id}/`); const user = userEvent.setup();
  await screen.findByRole("link", { name: "note.txt" });
  pick(note());
  expect(await within(tray()).findByText("A file with this name is already here.")).toBeInTheDocument();
  expect(sent("commit")).toHaveLength(0);
  await user.click(screen.getByRole("button", { name: "Replace note.txt with a new version" }));
  await within(tray()).findByText("1 file uploaded");
  expect(sent("commit")[0].body.ops[0]).toMatchObject({ op: "put", path: "note.txt", ifVersion: "v_OLD" });
  expect(sent("commit")[0].body.ops[0]).not.toHaveProperty("ifAbsent");
  pick(note());
  await user.click(await screen.findByRole("button", { name: "Keep both copies of note.txt" }));
  await within(tray()).findByText("2 files uploaded");
  expect(sent("commit")[1].body.ops[0]).toMatchObject({ op: "put", path: "note (2).txt", ifAbsent: true });
  expect(within(tray()).getByText("note (2).txt")).toBeInTheDocument();
});

it("keeps a failed upload in the tray with the reason and retries it on request", async () => {
  let fail = true;
  const { sent } = backend({ data: (route) => (route === "commit" && fail ? json({ error: "precondition_failed", path: "note.txt" }, 412) : undefined) });
  renderApp(`/drives/${drive.id}/`); const user = userEvent.setup();
  await screen.findByRole("button", { name: "Upload files" });
  pick(note());
  expect(await within(tray()).findByRole("alert")).toHaveTextContent("“note.txt” changed while you were working. Nothing was changed");
  expect(within(tray()).getByRole("status")).toHaveTextContent("1 file didn’t finish");
  fail = false;
  await user.click(screen.getByRole("button", { name: "Try note.txt again" }));
  expect(await within(tray()).findByText("1 file uploaded")).toBeInTheDocument();
  expect(sent("commit")).toHaveLength(2);
  await user.click(screen.getByRole("button", { name: "Close transfer list" }));
  expect(screen.queryByRole("region", { name: "Uploads and downloads" })).not.toBeInTheDocument();
});

it("hides every upload control from view-only members and explains a refused drop", async () => {
  const { sent, fetcher } = backend({ drive: { access: "read" } });
  renderApp(`/drives/${drive.id}/`);
  const heading = await screen.findByRole("heading", { name: "Nothing in this drive yet" });
  expect(screen.getByText("View only")).toBeInTheDocument();
  expect(screen.queryByLabelText("Choose files to upload")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Upload|New folder/ })).not.toBeInTheDocument();
  fireEvent.drop(heading, { dataTransfer: { files: [note()] } });
  expect(await screen.findByText("You can view this drive, but you can’t add files to it.")).toBeInTheDocument();
  expect(sent("commit")).toHaveLength(0);
  expect(fetcher.mock.calls.some(([, init]) => init?.body === JSON.stringify({ access: "write" }))).toBe(false);
});

it("makes a trial-expired workspace view only, reassures first and links to billing", async () => {
  backend({ workspace: { state: "expired", writable: false }, folders: { "": [file("note.txt")] } });
  renderApp(`/drives/${drive.id}/`);
  await screen.findByRole("link", { name: "note.txt" });
  const note = screen.getByRole("note");
  expect(note).toHaveTextContent(/^Your files are safe\. This workspace’s trial has ended/);
  expect(within(note).getByRole("link", { name: "See plans in Billing" })).toHaveAttribute("href", `/orgs/${drive.orgId}/billing`);
  expect(screen.getByText("View only")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /^Upload|New folder/ })).not.toBeInTheDocument();
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Actions for note.txt" }));
  expect(screen.getByRole("menuitem", { name: "Download" })).toBeInTheDocument();
  expect(screen.queryByRole("menuitem", { name: /Rename|Move|Delete/ })).not.toBeInTheDocument();
});
