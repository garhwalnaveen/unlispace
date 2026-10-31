import {env,exports} from "cloudflare:workers";
import {it,expect} from "vitest";
import {api,newDrive,upload,bytes,sha256Hex} from "./helpers";
import {genKey,installJwks,signToken} from "./auth-helpers";
const admin=(exports as any).DataPlaneAdmin;

it("counts uncommitted bytes and caps concurrent uploads across drives",async()=>{
 const a=await newDrive(),b=await newDrive(); const key=await genKey("quota-test"); installJwks(key);
 const token=await signToken(key,{org:"quota-concurrent",drives:[{id:a,access:"write"},{id:b,access:"write"}]});
 await admin.configureQuota("quota-concurrent",5,[a,b]);
 const responses=await Promise.all([a,b].map(async(d,i)=>{const data=bytes(i?"bbbb":"aaaa"),h=await sha256Hex(data);return api(`/v0/drives/${d}/shards/${h}`,{method:"PUT",body:data,token});}));
 expect(responses.map(r=>r.status).sort()).toEqual([201,403]);
 expect((await admin.configureQuota("quota-concurrent",5,[a,b])).usedBytes).toBe(4);
 const winner=responses[0]!.status===201?a:b;
 expect((await admin.driveStats(winner)).ownBytes).toBe(4);
});
it("seeds existing R2 objects, charges a duplicate once and releases failed uploads",async()=>{
 const d=await newDrive(); const shard=await upload(d,bytes("seed"));
 const key=await genKey("quota-existing");installJwks(key);
 const token=await signToken(key,{org:"quota-existing",drives:[{id:d,access:"write"}]});
 expect((await admin.configureQuota("quota-existing",8,[d])).usedBytes).toBe(4);
 expect((await api(`/v0/drives/${d}/shards/${shard.h}`,{method:"PUT",body:bytes("seed"),token})).status).toBe(200);
 const h=await sha256Hex(bytes("next"));
 expect((await api(`/v0/drives/${d}/shards/${h}`,{method:"PUT",body:bytes("oops"),token})).status).toBe(400);
 expect((await admin.configureQuota("quota-existing",8,[d])).usedBytes).toBe(4);
 expect((await api(`/v0/drives/${d}/shards/${h}`,{method:"PUT",body:bytes("next"),token})).status).toBe(201);
 expect((await admin.configureQuota("quota-existing",8,[d])).usedBytes).toBe(8);
});
it("persists idempotent commit receipts and fences a cancelled completion",async()=>{
 const d=await newDrive();
 const ops=[{op:"put",path:"file",size:0,shards:[],mtimeMs:1,contentType:"text/plain"}];
 const save=()=>api(`/v0/drives/${d}/commit`,{json:{ops,requestId:"multipart:test"}});
 const first=await(await save()).json();expect(await(await save()).json()).toEqual(first);
 const versions=await(await api(`/v0/drives/${d}/versions?path=file`)).json() as any;expect(versions.versions).toHaveLength(1);
 const cancel=await api(`/v0/drives/${d}/commit-cancel`,{json:{requestId:"multipart:abort"}});expect(await cancel.json()).toEqual({committed:null});
 expect((await api(`/v0/drives/${d}/commit`,{json:{ops,requestId:"multipart:abort"}})).status).toBe(409);
 expect(await(await api(`/v0/drives/${d}/commit-cancel`,{json:{requestId:"multipart:test"}})).json()).toEqual({committed:first});
 expect((await api(`/v0/drives/${d}/commit`,{json:{ops:[{...ops[0],path:"different"}],requestId:"multipart:test"}})).status).toBe(409);
});
it("reserves quota for spilled manifests before committing",async()=>{
 const drive=await newDrive(); const shard=await upload(drive,bytes("x"));
 const key=await genKey("manifest-budget");installJwks(key);
 const token=await signToken(key,{org:"manifest-budget",drives:[{id:drive,access:"write"}]});
 await admin.configureQuota("manifest-budget",10,[drive]);
 const shards=Array.from({length:4000},()=>shard);
 const op={op:"put",path:"large-manifest",size:shards.length,shards,mtimeMs:1,contentType:"text/plain"};
 expect((await api(`/v0/drives/${drive}/commit`,{json:{ops:[op]},token})).status).toBe(403);
 expect((await env.SHARDS.list({prefix:`manifests/${drive}/`})).objects).toHaveLength(0);
 await admin.configureQuota("manifest-budget",1_000_000,[drive]);
 expect((await api(`/v0/drives/${drive}/commit`,{json:{ops:[op]},token})).status).toBe(200);
 const objects=(await env.SHARDS.list({prefix:`manifests/${drive}/`})).objects;
 expect(objects).toHaveLength(1);
 expect((await admin.configureQuota("manifest-budget",1_000_000,[drive])).usedBytes).toBe(1+objects[0]!.size);
});
