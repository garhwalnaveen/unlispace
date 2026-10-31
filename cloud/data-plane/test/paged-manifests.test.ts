import { env, exports } from "cloudflare:workers";
import { expect, it } from "vitest";
import { api, bytes, commit, newDrive, upload, selfFetch, TOKEN } from "./helpers";
import { genKey, installJwks, signToken } from "./auth-helpers";
import { DataPlane } from "../../s3-gateway/src/data-plane";
import { editManifest } from "../../s3-gateway/src/edits";
import { iterateManifest,readManifestPage } from "../src/manifests";

async function metadata(drive:string,value:unknown,token?:string) {
  const response = await api(`/v0/drives/${drive}/manifest-pages`,{json:value,...(token ? {token} : {})});
  expect(response.status).toBe(200);
  return (await response.json() as {hash:string}).hash;
}

it("commits, pages, copies and restores a logical 5 TiB file without a flat manifest RPC",async()=>{
  const drive=await newDrive();
  const shard=await upload(drive,new Uint8Array(16*1024*1024));
  const tuples=Array.from({length:1000},()=>[shard.h,shard.n]);
  const full=await metadata(drive,tuples);
  const tail=await metadata(drive,tuples.slice(0,680));
  const size=5*1024**4;
  const pages=[...Array.from({length:327},()=>({h:full,size:1000*shard.n,count:1000})),{h:tail,size:680*shard.n,count:680}];
  const hash=await metadata(drive,{format:"uls-manifest-v1",size,pages});
  const manifestRef=`tree:${hash}`;
  const op={op:"put",path:"large",size,shards:[],manifestRef};
  const saved=await commit(drive,[op]);expect(saved.status).toBe(200);
  const version=(await saved.json() as {results:{versionId:string}[]}).results[0]!.versionId;
  const first=await api(`/v0/drives/${drive}/manifest?path=large&shardCursor=0`);
  expect(first.status).toBe(200);
  expect(await first.json()).toMatchObject({size,manifestRef,nextShardCursor:1,shards:expect.any(Array)});
  const last=await api(`/v0/drives/${drive}/manifest?path=large&shardCursor=327`);
  const tailDoc=await last.json() as {shards:unknown[];nextShardCursor:number|null};
  expect(tailDoc.shards).toHaveLength(680);expect(tailDoc.nextShardCursor).toBeNull();
  expect((await commit(drive,[{...op,path:"copy"}])).status).toBe(200);
  expect((await commit(drive,[{op:"put",path:"large",size:0,shards:[]}])).status).toBe(200);
  expect((await api(`/v0/drives/${drive}/restore`,{json:{path:"large",versionId:version}})).status).toBe(200);
  expect(await (await api(`/v0/drives/${drive}/manifest?path=large&shardCursor=327`)).json()).toMatchObject({size,manifestRef});
  const gateway=new DataPlane({fetch:selfFetch},{mint:async()=>TOKEN},{keyId:"fixture",subject:"fixture",orgId:"fixture",scope:"admin"},drive);
  const manifest=await gateway.manifest("large");
  let length=0;
  for await(const data of gateway.bytes(manifest,size-4,size)){expect([...data]).toEqual([0,0,0,0]);length+=data.length;}
  expect(length).toBe(4);
  const edited=await editManifest(gateway,manifest,[{offset:size-1,bytes:bytes("Y")}]);
  expect(edited.size).toBe(size);expect(edited.manifestRef).toMatch(/^tree:/);
  await gateway.commit([{op:"put",path:"edited",...edited,contentType:"application/octet-stream",mtimeMs:0}]);
  const changed=await gateway.manifest("edited");
  const ending=[];
  for await(const data of gateway.bytes(changed,size-2,size))ending.push(...data);
  expect(ending).toEqual([0,89]);
},60_000);

it("rejects a paged manifest referencing another drive's content or inconsistent lengths",async()=>{
  const owner=await newDrive(),other=await newDrive();
  const shard=await upload(owner,bytes("private"));
  expect((await commit(other,[{op:"put",path:"too-large",size:5*1024**4+1,shards:[]}])).status).toBe(400);
  expect((await commit(other,[{op:"put",path:"bad-condition",size:0,shards:[],ifAbsent:"true"}])).status).toBe(400);
  const page=await metadata(other,[[shard.h,shard.n]]);
  const root=await metadata(other,{format:"uls-manifest-v1",size:shard.n,pages:[{h:page,size:shard.n,count:1}]});
  expect((await commit(other,[{op:"put",path:"stolen",size:shard.n,shards:[],manifestRef:`tree:${root}`}])).status).toBe(409);
  expect((await api(`/v0/drives/${other}/stat?path=stolen`)).status).toBe(404);
  await upload(other,bytes("private"));
  const badRoot=await metadata(other,{format:"uls-manifest-v1",size:shard.n+1,pages:[{h:page,size:shard.n+1,count:1}]});
  const invalid=await commit(other,[{op:"put",path:"wrong",size:shard.n+1,shards:[],manifestRef:`tree:${badRoot}`}]);
  expect(invalid.status).toBe(400);
  expect((await api(`/v0/drives/${other}/stat?path=wrong`)).status).toBe(404);
  for (const cursor of ["", "-1", "1.5", "1e2", "0x1"]) {
    expect((await api(`/v0/drives/${other}/manifest?path=wrong&shardCursor=${encodeURIComponent(cursor)}`)).status).toBe(400);
  }
});

it("charges paged metadata against the same authoritative quota before storing it",async()=>{
  const drive=await newDrive(),key=await genKey("paged-quota");installJwks(key);
  const token=await signToken(key,{org:"paged-quota",drives:[{id:drive,access:"write"}]});
  const admin=(exports as unknown as {DataPlaneAdmin:{configureQuota(org:string,limit:number,lineages:string[]):Promise<unknown>}}).DataPlaneAdmin;
  await admin.configureQuota("paged-quota",1,[drive]);
  const response=await api(`/v0/drives/${drive}/manifest-pages`,{json:[["a".repeat(64),1]],token});
  expect(response.status).toBe(403);
  expect((await env.SHARDS.list({prefix:`manifests/${drive}/`})).objects).toHaveLength(0);
});

it("indexes the worst-case FastCDC reference count with bounded metadata pages",async()=>{
  const drive=await newDrive(),shard=await upload(drive,bytes("a"));
  const leaf=await metadata(drive,Array.from({length:1000},()=>[shard.h,1]));
  const firstIndex=await metadata(drive,{format:"uls-manifest-v1",size:1_000_000,pages:Array.from({length:1000},()=>({h:leaf,size:1000,count:1000}))});
  const tailIndex=await metadata(drive,{format:"uls-manifest-v1",size:972_000,pages:Array.from({length:972},()=>({h:leaf,size:1000,count:1000}))});
  const hash=await metadata(drive,{format:"uls-manifest-v2",size:20_972_000,indexes:[...Array.from({length:20},()=>({h:firstIndex,size:1_000_000,pages:1000})),{h:tailIndex,size:972_000,pages:972}]});
  const page=await readManifestPage(env.SHARDS,drive,`tree:${hash}`,20_971);
  expect(page.shards).toHaveLength(1000);expect(page.next).toBeNull();
  const first=await iterateManifest(env.SHARDS,drive,`tree:${hash}`).next();
  expect(first.value?.metadata).toEqual([hash,firstIndex,leaf]);
});
