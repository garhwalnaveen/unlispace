import {it,expect,vi} from "vitest";
import {makeWorld,signIn} from "./helpers";
import {meterUsage} from "../src/entitlements";
import {rpcContext} from "../src/control-plane";
import {HttpError} from "../src/http";

it("reports delivery failure for every address and invalidates undelivered codes",async()=>{
 const w=await makeWorld();
 w.mail.send=async()=>{throw new Error("provider unavailable");};
 for(const email of ["a@example.com","unknown@example.com"]) {
  const response=await w.call("/auth/otp/start",{json:{email}});
  expect(response.status).toBe(503); expect(await response.json()).toMatchObject({error:"email_unavailable"});
 }
 expect(await w.env.DB.prepare("SELECT COUNT(*) AS n FROM otp_codes").first()).toEqual({n:0});
});

async function checkoutWorld() {
 const w=await makeWorld({DODO_PRODUCTS:JSON.stringify({individual:{monthly:"p1",annual:"p2"},teams:{monthly:"p3",annual:"p4"},storage:{monthly:"a1",annual:"a2"}})});
 const provider={checkout:vi.fn(async()=>({url:"https://checkout.example/one",sessionId:"cks_one"})),checkoutStatus:vi.fn(async()=>({createdAt:new Date(w.clock.t).toISOString(),paymentId:null as string|null,paymentStatus:null as string|null})),portal:async()=>({url:"https://example.com"}),invoices:async()=>({invoices:[],nextPage:null})};
 w.dodoImpl.client=provider;
 let session=await signIn(w);
 const org=(await(await w.call("/orgs",{token:session.accessToken})).json() as any).orgs[0];
 const call=(plan="individual")=>w.call(`/orgs/${org.id}/billing/checkout`,{token:session.accessToken,json:{plan}});
 return {w,provider,org,call,signInAgain:async()=>{session=await signIn(w);}};
}
it("serializes checkout creation and reuses the same payable session",async()=>{
 const {w,provider,call}=await checkoutWorld();
 const responses=await Promise.all([call(),call(),call()]);
 expect(responses.every(r=>[200,409].includes(r.status))).toBe(true);
 expect(provider.checkout).toHaveBeenCalledTimes(1);
 expect(await(await call()).json()).toEqual({url:"https://checkout.example/one"});
 expect((await call("teams")).status).toBe(409);
 expect(await w.env.DB.prepare("SELECT COUNT(*) AS n FROM billing_checkout_locks").first()).toEqual({n:1});
});
it("keeps ambiguous checkout failures locked, but releases a definitive rejection",async()=>{
 const {w,provider,call}=await checkoutWorld();
 provider.checkout.mockRejectedValueOnce(new HttpError(502,"billing_rejected"));
 expect((await call()).status).toBe(502);
 expect(await w.env.DB.prepare("SELECT COUNT(*) AS n FROM billing_checkout_locks").first()).toEqual({n:0});
 provider.checkout.mockRejectedValueOnce(new Error("lost provider response"));
 expect((await call()).status).toBe(500);
 expect((await call()).status).toBe(409);
 expect(provider.checkout).toHaveBeenCalledTimes(2);
});
it("replaces only an expired checkout with no payment attached",async()=>{
 const {w,provider,call,signInAgain}=await checkoutWorld();
 const createdAt=new Date(w.clock.t).toISOString();
 expect((await call()).status).toBe(200);
 w.clock.t+=26*60*60*1000; await signInAgain();
 provider.checkoutStatus.mockResolvedValueOnce({createdAt,paymentId:"pay_pending",paymentStatus:"processing"});
 expect((await call("teams")).status).toBe(409);
 expect(provider.checkout).toHaveBeenCalledTimes(1);
 provider.checkoutStatus.mockResolvedValueOnce({createdAt,paymentId:null,paymentStatus:null});
 expect((await call("teams")).status).toBe(200);
 expect(provider.checkout).toHaveBeenCalledTimes(2);
});
it("continues metering after a broken drive and does not keep it at the front",async()=>{
 const w=await makeWorld(); const session=await signIn(w);
 const org=(await(await w.call("/orgs",{token:session.accessToken})).json() as any).orgs[0];
 await w.env.DB.prepare("INSERT INTO drives(id,org_id,name,status,created_at) VALUES(?,?,?,'ready',0)").bind("aaa-broken",org.id,"Broken").run();
 const original=w.dp.driveStats.bind(w.dp); const calls:string[]=[];
 w.dp.driveStats=async id=>{calls.push(id);if(id==="aaa-broken") throw new Error("unavailable"); return original(id);};
 await expect(meterUsage(rpcContext(w.env))).rejects.toMatchObject({code:"usage_unavailable"});
 expect(calls).toContain(org.drives[0].id);
 expect(await w.env.DB.prepare("SELECT COUNT(*) AS n FROM drive_usage").first()).toEqual({n:1});
 await w.env.DB.prepare("INSERT INTO drives(id,org_id,name,status,created_at) VALUES(?,?,?,'ready',0)").bind("zzz-new",org.id,"New").run();
 calls.length=0; await expect(meterUsage(rpcContext(w.env))).rejects.toThrow();
 expect(calls[0]).toBe("zzz-new");
});
