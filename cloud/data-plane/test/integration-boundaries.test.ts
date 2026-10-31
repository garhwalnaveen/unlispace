import {env,exports} from "cloudflare:workers";
import {evictDurableObject,runInDurableObject} from "cloudflare:test";
import {expect,it} from "vitest";
import type {DriveAuthority} from "../src/drive";
import {api,bytes,commit,newDrive,upload} from "./helpers";
const admin=(exports as any).DataPlaneAdmin;
const stub=(id:string)=>{const ns=env.DRIVE_AUTHORITY as DurableObjectNamespace<DriveAuthority>;return ns.get(ns.idFromName(id));};
const manifest=async(id:string,path:string,version?:string)=>{
 const r=await api(`/v0/drives/${id}/manifest?path=${path}${version?`&versionId=${version}`:""}`);expect(r.status).toBe(200);return r.json() as Promise<any>;
};
const snapshot=(id:string)=>runInDurableObject(stub(id),async(instance,ctx)=>{
 ctx.storage.sql.exec("INSERT OR REPLACE INTO meta VALUES('snapshot_at','0')");return instance.snapshot();
});

it("restores file and historical attribute bytes after snapshot, hard deletion and eviction",async()=>{
 const id=await newDrive(),body=await upload(id,bytes("file data")),oldAttr=await upload(id,bytes("old resource")),newAttr=await upload(id,bytes("new resource"));
 const first=await commit(id,[{op:"put",path:"file",size:body.n,shards:[body],xattrs:{"com.apple.ResourceFork":[oldAttr]}}]);expect(first.status).toBe(200);
 const version=(await first.json() as any).results[0].versionId;
 expect((await commit(id,[{op:"put",path:"file",size:body.n,shards:[body],xattrs:{"com.apple.ResourceFork":[newAttr],"com.apple.FinderInfo":[]}}])).status).toBe(200);
 const key=await snapshot(id);expect(key).toBeTruthy();
 await admin.deleteDrive(id,{hard:true});await admin.restoreSnapshot(id,key);await evictDurableObject(stub(id));
 expect((await manifest(id,"file")).xattrs).toEqual({"com.apple.ResourceFork":[newAttr],"com.apple.FinderInfo":[]});
 expect((await manifest(id,"file",version)).xattrs).toEqual({"com.apple.ResourceFork":[oldAttr]});
 for(const shard of [body,oldAttr,newAttr]){
  const r=await api(`/v0/drives/${id}/shards/${shard.h}`);expect(r.status).toBe(200);expect((await r.arrayBuffer()).byteLength).toBe(shard.n);
 }
 expect((await api(`/v0/drives/${id}/restore`,{json:{path:"file",versionId:version}})).status).toBe(200);
 expect((await manifest(id,"file")).xattrs).toEqual({"com.apple.ResourceFork":[oldAttr]});
});

it("imports snapshots predating attributes and retained-grant tables without trusting staged bytes",async()=>{
 const id=await newDrive(),body=await upload(id,bytes("retained content")),staged=await upload(id,bytes("not committed"));
 expect((await commit(id,[{op:"put",path:"file",size:body.n,shards:[body]}])).status).toBe(200);
 const key=await snapshot(id);expect(key).toBeTruthy();
 const object=await env.SHARDS.get(key!);expect(object).not.toBeNull();
 const text=await new Response(object!.body.pipeThrough(new DecompressionStream("gzip"))).text();
 const lines=text.trimEnd().split("\n").map(line=>JSON.parse(line));
 const legacy=lines.filter((row,i)=>i===0 || (row.table!=="retained_shards" && !(row.table==="meta" && ["refs_ready","refs_cursor"].includes(row.row.k)))).map((row,i)=>{
  if(i!==0 && row.table==="versions")delete row.row.xattrs;
  return JSON.stringify(row);
 }).join("\n")+"\n";
 const compressed=await new Response(new Blob([legacy]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer();
 await env.SHARDS.put(key!,compressed);
 await admin.deleteDrive(id,{hard:true});await admin.restoreSnapshot(id,key!);
 expect((await manifest(id,"file")).xattrs).toEqual({});
 expect((await api(`/v0/drives/${id}/shards/${body.h}`)).status).toBe(200);
 expect((await api(`/v0/drives/${id}/shards/${staged.h}`)).status).toBe(404);
 await evictDurableObject(stub(id));
 expect((await api(`/v0/drives/${id}/shards/${body.h}`)).status).toBe(200);
});
