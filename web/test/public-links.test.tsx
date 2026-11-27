import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { Link } from "react-router-dom";
import { App } from "../src/App";
import { LinkManager } from "../src/PublicLinks";
import { json, renderWithAuth, signedOutStore } from "./fixtures";

it("creates and revokes an upload request and reports clipboard errors", async () => {
 let created = false, revoked = false;
 const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
  if (init?.method === "POST") { const body=JSON.parse(String(init.body)); expect(body).toMatchObject({kind:"upload",path:"inbox/report.txt"}); created=true; return json({id:"link1",token:"share-token"},201); }
  if (init?.method === "DELETE") { revoked=true; return json({ok:true}); }
  return json({links:created && !revoked ? [{id:"link1",kind:"upload",path:"inbox/report.txt",expiresAt:Date.now()+10000,revokedAt:null,consumedAt:null}] : []});
 });
 vi.stubGlobal("fetch",fetcher); const user=userEvent.setup(); renderWithAuth(<LinkManager driveId="d-test" folder="inbox/" canWrite />);
 await user.click(screen.getByRole("button",{name:"Public links"}));
 await user.type(screen.getByLabelText("Requested file name"),"report.txt");
 await user.click(screen.getByRole("button",{name:"Create upload request"}));
 expect(await screen.findByLabelText("Public link")).toHaveValue("http://localhost:3000/share#share-token");
 vi.spyOn(navigator.clipboard,"writeText").mockRejectedValue(new Error("denied"));
 await user.click(screen.getByRole("button",{name:"Copy"}));
 expect(await screen.findByRole("alert")).toHaveTextContent("Select the link and copy it manually");
 await user.click(screen.getByRole("button",{name:"Revoke"}));
 await waitFor(() => expect(screen.queryByLabelText("Public link")).not.toBeInTheDocument());
 expect(revoked).toBe(true);
});

it("clears the selected file and sends the new token when switching requests", async () => {
 const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
  const token = new Headers(init?.headers).get("authorization");
  if (init?.method === "POST") {
   expect(url).toContain("/public/upload");
   expect(token).toBe("Bearer second-token");
   expect(init.body).toBeInstanceOf(File);
   return json({ok:true});
  }
  return json({kind:"upload",name:token === "Bearer first-token" ? "first.txt" : "second.txt",expiresAt:Date.now()+10000,maxBytes:16777216});
 });
 vi.stubGlobal("fetch", fetcher);
 const user = userEvent.setup();
 renderWithAuth(<><Link to="/share#second-token">Second request</Link><App /></>, "/share#first-token", await signedOutStore());
 await screen.findByText(/first.txt/);
 const selected = new File(["first"], "first.txt", {type:"text/plain"});
 await user.upload(screen.getByLabelText("Choose a file"), selected);
 expect(screen.getByRole("button", {name:"Upload"})).toBeEnabled();
 await user.click(screen.getByRole("link", {name:"Second request"}));
 await screen.findByText(/second.txt/);
 expect(screen.queryByText(/first.txt/)).not.toBeInTheDocument();
 expect(screen.getByRole("button", {name:"Upload"})).toBeDisabled();
 await user.upload(screen.getByLabelText("Choose a file"), new File(["second"], "second.txt", {type:"text/plain"}));
 await user.click(screen.getByRole("button", {name:"Upload"}));
 expect(await screen.findByText("Upload complete.")).toBeInTheDocument();
 expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
});

it("lets an issuer revoke existing links when creation is disabled", async () => {
 let revoked = false;
 vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
  if (init?.method === "DELETE") { revoked = true; return json({ok:true}); }
  return json({links:revoked ? [] : [{id:"link1",kind:"upload",path:"inbox/report.txt",expiresAt:Date.now()+10000}]});
 }));
 const user = userEvent.setup();
 renderWithAuth(<LinkManager driveId="d-test" folder="inbox/" canWrite canCreate={false} />);
 await user.click(await screen.findByRole("button", {name:"Public links"}));
 expect(screen.queryByRole("button", {name:"Create upload request"})).not.toBeInTheDocument();
 await user.click(screen.getByRole("button", {name:"Revoke"}));
 await waitFor(() => expect(screen.queryByRole("button", {name:"Revoke"})).not.toBeInTheDocument());
});
