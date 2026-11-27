import { describe, expect, it } from "vitest";
import { makeWorld, signIn } from "./helpers";
const hash = "a".repeat(64), other = "b".repeat(64);
describe("public links", () => {
 it("scopes downloads to a pinned file and enforces expiry and revocation", async () => {
  const w=await makeWorld(); const owner=await signIn(w); const org:any=((await (await w.call("/orgs",{token:owner.accessToken})).json()) as any).orgs[0]; const drive=org.drives[0].id;
  const calls:string[]=[];
  w.fetchImpl.fn = (async (input: RequestInfo | URL, init?: RequestInit) => { const url=new URL(String(input)); calls.push(url.pathname+url.search); expect(new Headers(init?.headers).get("authorization")).toMatch(/^Bearer /); if(url.pathname.endsWith("/manifest")) return Response.json({path:"safe.txt",versionId:"v_test",size:1,contentType:"text/html",shards:[{h:hash,n:1}],signedBlocks:["secret"]}); return new Response("x"); }) as typeof fetch;
  const path=`/drives/${drive}/links`; const body={kind:"download",path:"safe.txt",expiresAt:w.clock.t+1000};
  expect((await w.call(path,{json:body})).status).toBe(401);
  expect((await w.call("/public/upload",{method:"POST",token:"x".repeat(43),body:"x"})).status).toBe(404);
  const tokenRows = await w.env.DB.prepare("SELECT k FROM rate_limits WHERE k LIKE 'links:upload-token:%'").all();
  expect(tokenRows.results).toHaveLength(0);
  expect((await w.call(path,{token:owner.accessToken,json:{...body,path:"../escape"}})).status).toBe(400);
  await w.env.DB.prepare("UPDATE orgs SET tier='teams' WHERE id=?").bind(org.id).run();
  expect((await w.call(path,{token:owner.accessToken,json:body})).status).toBe(403);
  await w.env.DB.prepare("UPDATE orgs SET tier='individual' WHERE id=?").bind(org.id).run();
  const created=await w.call(path,{token:owner.accessToken,json:body}); expect(created.status).toBe(201); const link:any=await created.json();
  for (let i = 0; i < 101; i++) await w.env.DB.prepare("INSERT INTO public_links(id,token_hash,drive_id,user_id,path,kind,created_at,expires_at,revoked_at) VALUES(?,?,?,?,?,?,?,?,?)").bind(`old${i}`,`hash${i}`,drive,owner.user.id,"old.txt","download",w.clock.t+1,w.clock.t+1000,w.clock.t).run();
  const listed:any = await (await w.call(path,{token:owner.accessToken})).json(); expect(listed.links.map((item:any) => item.id)).toEqual([link.id]);
  const info=await w.call("/public/link",{token:link.token}); const data:any=await info.json(); expect(info.status).toBe(200); expect(data.manifest).not.toHaveProperty("signedBlocks"); expect(data.manifest.contentType).toBe("application/octet-stream");
  expect((await w.call(`/public/shards/${other}`,{token:link.token})).status).toBe(404);
  const shard=await w.call(`/public/shards/${hash}`,{token:link.token}); expect(shard.status).toBe(200); expect(shard.headers.get("content-disposition")).toBe("attachment");
  expect(calls.some(c=>c.includes("versionId=v_test"))).toBe(true);
  expect((await w.call(`${path}/${link.id}`,{method:"DELETE",token:owner.accessToken})).status).toBe(200);
  expect((await w.call("/public/link",{token:link.token})).status).toBe(404);
  const second:any=await (await w.call(path,{token:owner.accessToken,json:body})).json(); w.clock.t+=1001; expect((await w.call("/public/link",{token:second.token})).status).toBe(404);
 });
 it("uploads only to its requested destination with ifAbsent and consumes the link", async () => {
  const w=await makeWorld(); const owner=await signIn(w); const org:any=((await (await w.call("/orgs",{token:owner.accessToken})).json()) as any).orgs[0]; const drive=org.drives[0].id;
  let operation:any;
  w.fetchImpl.fn = (async (input: RequestInfo | URL, init?: RequestInit) => { const url=new URL(String(input)); if(url.pathname.endsWith("/commit")) { operation=JSON.parse(String(init?.body)).ops[0]; return Response.json({ok:true}); } return Response.json({ok:true}); }) as typeof fetch;
  const link:any=await (await w.call(`/drives/${drive}/links`,{token:owner.accessToken,json:{kind:"upload",path:"inbox/report.txt",expiresAt:w.clock.t+10000}})).json();
  expect((await w.call("/public/upload",{token:link.token,method:"POST",headers:{"content-length":String(16*1024*1024+1)},body:"x"})).status).toBe(413);
  expect((await w.call("/public/upload",{token:link.token,method:"POST",body:"hello"})).status).toBe(200);
  expect(operation).toMatchObject({op:"put",path:"inbox/report.txt",ifAbsent:true,size:5});
  expect((await w.call("/public/upload",{token:link.token,method:"POST",body:"again"})).status).toBe(404);
 });
});

describe("public link restrictions", () => {
 it("refuses uploads after issuer loses membership and preserves no-overwrite errors", async () => {
  const w=await makeWorld(); const owner=await signIn(w); const org:any=((await (await w.call("/orgs",{token:owner.accessToken})).json()) as any).orgs[0]; const drive=org.drives[0].id;
  let commits=0;
  w.fetchImpl.fn = (async (input: RequestInfo | URL) => { if(new URL(String(input)).pathname.endsWith("/commit")) { commits++; return Response.json({error:"precondition_failed"},{status:412}); } return Response.json({ok:true}); }) as typeof fetch;
  const path=`/drives/${drive}/links`; const link:any=await (await w.call(path,{token:owner.accessToken,json:{kind:"upload",path:"existing.txt",expiresAt:w.clock.t+10000}})).json();
  expect((await w.call("/public/upload",{token:link.token,method:"POST",body:"new"})).status).toBe(412);
  await w.env.DB.prepare("DELETE FROM memberships WHERE org_id=? AND user_id=?").bind(org.id,owner.user.id).run();
  expect((await w.call("/public/upload",{token:link.token,method:"POST",body:"new"})).status).toBe(404);
  expect(commits).toBe(1);
 });
});
