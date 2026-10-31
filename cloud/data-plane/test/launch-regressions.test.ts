import {env,exports} from "cloudflare:workers";
import {evictDurableObject,runInDurableObject} from "cloudflare:test";
import {expect,it} from "vitest";
import {signBlocks} from "../src/blocks";
import {type DriveAuthority} from "../src/drive";
import {api,bytes,commit,newDrive,putFile,upload} from "./helpers";
import {genKey,installJwks,signToken} from "./auth-helpers";
const admin=(exports as any).DataPlaneAdmin;
const stubFor=(id:string)=>{const ns=env.DRIVE_AUTHORITY as DurableObjectNamespace<DriveAuthority>;return ns.get(ns.idFromName(id));};
const manifest=async(d:string,path:string)=>await(await api(`/v0/drives/${d}/manifest?path=${path}`)).json() as any;

it("keeps later parent chunks private from child reads, discovery, commits and signed blocks",async()=>{
 const parent=await newDrive();await putFile(parent,"before","shared");
 const staged=await upload(parent,bytes("unpublished-parent"));
 const child=`d-${crypto.randomUUID()}`;await admin.forkDrive(parent,child);
 expect((await api(`/v0/drives/${child}/shards/${staged.h}`)).status).toBe(404);
 const shard=await upload(parent,bytes("parent-private"));
 await commit(parent,[{op:"put",path:"after",size:shard.n,shards:[shard]}]);
 const key=await genKey("fork-boundary");installJwks(key);
 const token=await signToken(key,{drives:[{id:child,access:"write"}]});
 expect((await api(`/v0/drives/${child}/shards/${shard.h}`,{token})).status).toBe(404);
 expect(await(await api(`/v0/drives/${child}/shards/missing`,{token,json:{hashes:[shard.h]}})).json()).toEqual({missing:[shard.h]});
 expect((await api(`/v0/drives/${child}/commit`,{token,json:{ops:[{op:"put",path:"stolen",size:shard.n,shards:[shard]}]}})).status).toBe(409);
 const inherited=await manifest(child,"before");
 expect((await api(`/v0/drives/${child}/shards/${inherited.shards[0].h}`,{token})).status).toBe(200);
 const signed = await signBlocks("http://example.com",child,[shard],env.ULS_BLOCK_KEY!,parent);
 expect((await api(new URL(signed.blockUrls[shard.h]!).pathname+new URL(signed.blockUrls[shard.h]!).search)).status).toBe(404);
 // A wrong body under an existing hash must not grant authority, even if its size matches.
 expect((await api(`/v0/drives/${child}/shards/${shard.h}`,{token,method:"PUT",body:bytes("xxxxxxxxxxxxxx")})).status).toBe(400);
 expect((await api(`/v0/drives/${child}/shards/${shard.h}`,{token})).status).toBe(404);
 expect(await(await api(`/v0/drives/${parent}/shards/${shard.h}`)).text()).toBe("parent-private");
 // Copying identical bytes is authorized by proving possession through a verified upload.
 expect((await api(`/v0/drives/${child}/shards/${shard.h}`,{token,method:"PUT",body:bytes("parent-private")})).status).toBe(200);
 expect((await api(`/v0/drives/${child}/shards/${shard.h}`,{token})).status).toBe(200);
});

it("preserves versioned xattrs through content edits, rename, restore, fork and eviction",async()=>{
 const d=await newDrive(),body=await upload(d,bytes("data")),attr=await upload(d,bytes("resource"));
 expect((await(await api(`/v0/drives/${d}`)).json() as any).features).toContain("xattrs");
 const first=await(await commit(d,[{op:"put",path:"file",size:body.n,shards:[body],xattrs:{"com.apple.ResourceFork":[attr]}}])).json() as any;
 expect((await manifest(d,"file")).xattrs).toEqual({"com.apple.ResourceFork":[attr]});
 await commit(d,[{op:"put",path:"file",size:body.n,shards:[body]}]);
 await commit(d,[{op:"rename",from:"file",to:"renamed"}]);
 expect((await manifest(d,"renamed")).xattrs).toEqual({"com.apple.ResourceFork":[attr]});
 await commit(d,[{op:"put",path:"renamed",size:body.n,shards:[body],xattrs:{}}]);
 expect((await manifest(d,"renamed")).xattrs).toEqual({});
 expect((await api(`/v0/drives/${d}/restore`,{json:{path:"renamed",versionId:first.results[0].versionId}})).status).toBe(200);
 const child=`d-${crypto.randomUUID()}`;await admin.forkDrive(d,child);
 await evictDurableObject(stubFor(child));
 expect((await manifest(child,"renamed")).xattrs).toEqual({"com.apple.ResourceFork":[attr]});
 expect((await api(`/v0/drives/${child}/shards/${attr.h}`)).status).toBe(200);
});

it("spills large attribute references and includes metadata bytes in authoritative quota",async()=>{
 const d=await newDrive(),shard=await upload(d,bytes("x"));
 const key=await genKey("attr-budget");installJwks(key);
 const token=await signToken(key,{org:"attr-budget",drives:[{id:d,access:"write"}]});
 await admin.configureQuota("attr-budget",1_000_000,[d]);
 const op={op:"put",path:"file",size:1,shards:[shard],xattrs:{"com.apple.ResourceFork":Array.from({length:4000},()=>shard)}};
 expect((await api(`/v0/drives/${d}/commit`,{token,json:{ops:[op]}})).status).toBe(200);
 const objects=(await env.SHARDS.list({prefix:`manifests/${d}/`})).objects;
 expect(objects).toHaveLength(1);
 expect((await admin.configureQuota("attr-budget",1_000_000,[d])).usedBytes).toBe(1+objects[0]!.size);
 expect((await manifest(d,"file")).xattrs["com.apple.ResourceFork"]).toHaveLength(4000);
});

it("migrates retained chunk permissions in bounded restartable batches without trusting polluted cache",async()=>{
 const d=await newDrive();await putFile(d,"file","retained");
 const secret=await upload(d,bytes("orphan"));
 await runInDurableObject(stubFor(d),(_o,ctx)=>{ctx.storage.sql.exec("DELETE FROM drive_shards");ctx.storage.sql.exec("DELETE FROM meta WHERE k IN ('refs_ready','refs_cursor')");});
 await evictDurableObject(stubFor(d));
 expect((await api(`/v0/drives/${d}/shards/${secret.h}`)).status).toBe(404);
 const m=await manifest(d,"file");expect((await api(`/v0/drives/${d}/shards/${m.shards[0].h}`)).status).toBe(200);
});

it("honors NDJSON request ids across retries and cancellation",async()=>{
 const d=await newDrive();const op={op:"put",path:"file",size:0,shards:[]};
 const save=(id:string,operation=op)=>api(`/v0/drives/${d}/commit`,{method:"POST",headers:{"Content-Type":"application/x-ndjson","x-uls-request-id":id},body:JSON.stringify(operation)+"\n"});
 const first=await(await save("stream:retry")).json();
 expect(await(await save("stream:retry")).json()).toEqual(first);
 expect((await save("stream:retry",{...op,path:"other"})).status).toBe(409);
 await api(`/v0/drives/${d}/commit-cancel`,{json:{requestId:"stream:cancel"}});
 expect((await save("stream:cancel")).status).toBe(409);
 expect((await save("invalid id")).status).toBe(400);
});

it("rejects invalid attribute metadata before any publication",async()=>{
 const d=await newDrive();
 for(const xattrs of [null,{"":[]},{["a".repeat(256)]:[]},{"nul\0name":[]},{"attr":[{h:"a".repeat(64),n:0}]},{"attr":[{h:"a".repeat(64),n:16*1024*1024+1}]},Object.fromEntries(Array.from({length:65},(_,i)=>[String(i),[]]))]) {
  expect((await commit(d,[{op:"put",path:"file",size:0,shards:[],xattrs}])).status).toBe(400);
 }
 expect((await api(`/v0/drives/${d}/stat?path=file`)).status).toBe(404);
});
