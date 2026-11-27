import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { LinkManager, PublicLinkPage } from "../src/PublicLinks";
import { json, renderWithAuth, signedOutStore } from "./fixtures";

it("creates and revokes an upload request and reports clipboard errors", async () => {
 let created = false, revoked = false;
 const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
  if (init?.method === "POST") { const body=JSON.parse(String(init.body)); expect(body).toMatchObject({kind:"upload",path:"inbox/report.txt"}); created=true; return json({token:"share-token"},201); }
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
 await waitFor(()=>expect(revoked).toBe(true));
});

it("allows a signed-out recipient to upload one file", async () => {
 window.location.hash = "#recipient-token";
 const fetcher = vi.fn(async (url:string,init?:RequestInit) => {
  if (init?.method === "POST") { expect(url).toContain("/public/upload"); expect(new Headers(init.headers).get("authorization")).toBe("Bearer recipient-token"); expect(init.body).toBeInstanceOf(File); return json({ok:true}); }
  return json({kind:"upload",name:"report.txt",expiresAt:Date.now()+10000,maxBytes:16777216});
 });
 vi.stubGlobal("fetch",fetcher); const user=userEvent.setup(); renderWithAuth(<PublicLinkPage />, "/", await signedOutStore());
 await screen.findByRole("heading",{name:"Upload a file"});
 await user.upload(screen.getByLabelText("Choose a file"),new File(["hello"],"other.txt",{type:"text/plain"}));
 await user.click(screen.getByRole("button",{name:"Upload"}));
 expect(await screen.findByText("Upload complete.")).toBeInTheDocument();
 window.location.hash="";
});
