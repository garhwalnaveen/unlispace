import {env,exports} from "cloudflare:workers";
import {evictDurableObject,runInDurableObject} from "cloudflare:test";
import {expect,it} from "vitest";
import type {DataPlaneAdmin} from "../src/index";
import type {DriveAuthority} from "../src/drive";
import {api,newDrive,putFile,commit,upload,bytes} from "./helpers";
const admin=(exports as unknown as {DataPlaneAdmin:Pick<DataPlaneAdmin,"forkDrive">}).DataPlaneAdmin;
const stub=(id:string)=>(env.DRIVE_AUTHORITY as DurableObjectNamespace<DriveAuthority>).get(env.DRIVE_AUTHORITY.idFromName(id));
const child=()=>`mvcc-${crypto.randomUUID().slice(0,8)}`;
const manifest=(drive:string,path:string)=>(api(`/v0/drives/${drive}/manifest?path=${encodeURIComponent(path)}`).then(r=>r.json())) as Promise<{shards:{h:string;n:number}[];versionId:string}>;

it("keeps frozen namespace, history, shard grants and branch routing across mutations and eviction",async()=>{
 const source=await newDrive(),fork=child(),nested=child();
 await putFile(source,"folder/a","before");
 await putFile(source,"remove.txt","retained");
 const first=await manifest(source,"folder/a");
 const staged=await upload(source,bytes("staged before fork"));
 await admin.forkDrive(source,fork);
 await putFile(source,"folder/a","parent later");
 const later=await manifest(source,"folder/a");
 await commit(source,[{op:"rename",from:"folder/",to:"parent/"},{op:"delete",path:"remove.txt"}]);
 expect((await manifest(fork,"folder/a")).versionId).toBe(first.versionId);
 expect((await api(`/v0/drives/${fork}/stat?path=parent/a`)).status).toBe(404);
 expect((await api(`/v0/drives/${fork}/stat?path=remove.txt`)).status).toBe(200);
 for(const ref of [staged,later.shards[0]!]) {
   expect((await api(`/v0/drives/${fork}/shards/${ref.h}`)).status).toBe(404);
   expect((await commit(fork,[{op:"put",path:"forbidden",size:ref.n,shards:[ref]}])).status).toBe(409);
 }
 const history=await (await api(`/v0/drives/${fork}/versions?path=folder/a`)).json() as {versions:{versionId:string}[]};
 expect(history.versions.map(v=>v.versionId)).toEqual([first.versionId]);
 await commit(fork,[{op:"rename",from:"folder/",to:"branch/"}]);
 await admin.forkDrive(fork,nested);
 await putFile(fork,"branch/a","child later");
 expect((await manifest(nested,"branch/a")).shards).toEqual(first.shards);
 expect((await api(`/v0/drives/${source}/stat?path=parent/a`)).status).toBe(200);
 await evictDurableObject(stub(fork));
 await evictDurableObject(stub(source));
 expect((await manifest(nested,"branch/a")).shards).toEqual(first.shards);
 expect((await manifest(fork,"branch/a")).shards).not.toEqual(first.shards);
});

it("forks add no namespace, history or content-reference rows regardless of source tree size",async()=>{
 const source=await newDrive();
 await commit(source,Array.from({length:1000},(_,i)=>({op:"put",path:`file-${i}`,size:0,shards:[]})));
 const counts=()=>runInDurableObject(stub(source),(_instance,ctx)=>Object.fromEntries(["nodes","versions","path_log","shards_known","drive_shards","retained_shards"].map(name=>[name,ctx.storage.sql.exec<{n:number}>(`SELECT COUNT(*) AS n FROM mv_${name}`).one().n])));
 const before=await counts();
 const fork=child();
 await admin.forkDrive(source,fork);
 expect(await counts()).toEqual(before);
 const metadata=await runInDurableObject(stub(source),(_instance,ctx)=>({
   branches:ctx.storage.sql.exec<{n:number}>("SELECT COUNT(*) AS n FROM mv_branches").one().n,
   copied:ctx.storage.sql.exec<{n:number}>("SELECT COUNT(*) AS n FROM export_rows").one().n,
   childRows:ctx.storage.sql.exec<{n:number}>("SELECT COUNT(*) AS n FROM mv_nodes WHERE _branch=?",fork).one().n,
 }));
 expect(metadata).toEqual({branches:2,copied:0,childRows:0});
 expect((await api(`/v0/drives/${fork}/stat?path=file-999`)).status).toBe(200);
});

it("keeps the earliest branch socket expiration when a shared alarm serves multiple branches",async()=>{
 const source=await newDrive(),fork=child();
 await putFile(source,"f","content");
 await admin.forkDrive(source,fork);
 const now=Date.now(),earlier=Math.ceil(now/1000)+5,later=earlier+60;
 const open=async(drive:string,exp:number)=>{
   const response=await stub(drive).fetch(new Request("https://internal/watch?since=1",{headers:{Upgrade:"websocket","x-uls-token-exp":String(exp)}}));
   expect(response.status).toBe(101);
   const socket=response.webSocket!;socket.accept();return socket;
 };
 const a=await open(source,earlier),b=await open(fork,later);
 try {
   const alarm=await runInDurableObject(stub(source),async(instance,ctx)=>{await ctx.storage.deleteAlarm();await instance.alarm();return ctx.storage.getAlarm();});
   expect(alarm).not.toBeNull();
   expect(alarm!).toBeLessThanOrEqual(earlier*1000);
 }finally{a.close();b.close();}
});
