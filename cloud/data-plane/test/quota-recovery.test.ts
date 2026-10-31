import {env,exports} from "cloudflare:workers";
import {evictDurableObject,runInDurableObject} from "cloudflare:test";
import {expect,it} from "vitest";
import type {StorageQuota} from "../src/quota";
import type {DriveAuthority} from "../src/drive";
import {LineageGC,GC_GRACE_MS} from "../src/gc";
import {api,bytes,newDrive,sha256Hex} from "./helpers";
import {genKey,installJwks,signToken} from "./auth-helpers";
const admin=(exports as any).DataPlaneAdmin;
const quotas=(env as unknown as {STORAGE_QUOTA:DurableObjectNamespace<StorageQuota>}).STORAGE_QUOTA;
const quota=(id:string)=>quotas.get(quotas.idFromName(id));
const drive=(id:string)=>(env.DRIVE_AUTHORITY as DurableObjectNamespace<DriveAuthority>).get(env.DRIVE_AUTHORITY.idFromName(id));
const objectKey=(n:number)=>`shards/quota-fixture/${n.toString(16).padStart(64,"0")}`;

it("migrates legacy totals in bounded pages and safely finishes uncounted uploads",async()=>{
 const q=quota("legacy-counter-test");await q.configure(5000,[]);
 await runInDurableObject(q,(_instance,ctx)=>{
  ctx.storage.sql.exec("WITH RECURSIVE seq(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM seq WHERE n<1500) INSERT INTO objects(k,n) SELECT 'shards/quota-fixture/'||printf('%064x',n),1 FROM seq");
  ctx.storage.sql.exec("UPDATE objects SET inflight=1,stored=0 WHERE k=?",objectKey(1500));
  ctx.storage.sql.exec("DELETE FROM settings WHERE k IN ('used','counter_cursor','counter_ready')");
 });
 await evictDurableObject(q);
 expect(await runInDurableObject(q,async instance=>{try{await instance.usage([]);return "ready";}catch(e){return (e as Error).message;}})).toBe("quota_initializing");
 expect(await q.reserve(objectKey(2000),1)).toBe(false);
 await q.finish(objectKey(1500),false);
 expect(await q.usage([])).toEqual({usedBytes:1499});
 expect(await q.reserve(objectKey(2000),1)).toBe(true);
 expect(await q.usage([])).toEqual({usedBytes:1500});
 await q.finish(objectKey(2000),false);
 expect(await q.usage([])).toEqual({usedBytes:1499});
});

it("keeps one transactional total across duplicate and concurrent reservations",async()=>{
 const q=quota("atomic-total-test");await q.configure(7,[]);
 expect(await q.reserve(objectKey(1),4)).toBe(true);
 expect(await q.reserve(objectKey(1),4)).toBe(true);
 expect(await q.reserve(objectKey(1),5)).toBe(false);
 const competing=await Promise.all([q.reserve(objectKey(2),3),q.reserve(objectKey(3),3)]);
 expect(competing.filter(Boolean)).toHaveLength(1);
 expect(await q.usage([])).toEqual({usedBytes:7});
 await q.finish(objectKey(1),false);expect(await q.usage([])).toEqual({usedBytes:7});
 await q.finish(objectKey(1),false);expect(await q.usage([])).toEqual({usedBytes:3});
 await q.finish(objectKey(1),false);expect(await q.usage([])).toEqual({usedBytes:3});
});

it("uses the persisted total at a full ordinary account ledger size",async()=>{
 const q=quota("large-counter-test");await q.configure(250001,[]);
 await runInDurableObject(q,(_instance,ctx)=>ctx.storage.transactionSync(()=>{
  ctx.storage.sql.exec("WITH RECURSIVE seq(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM seq WHERE n<250000) INSERT INTO objects(k,n) SELECT 'shards/quota-fixture/'||printf('%064x',n),1 FROM seq");
  ctx.storage.sql.exec("UPDATE settings SET v=250000 WHERE k='used'");
 }));
 expect(await q.reserve(objectKey(250001),1)).toBe(true);
 expect(await q.reserve(objectKey(250002),1)).toBe(false);
 expect(await q.usage([])).toEqual({usedBytes:250001});
 const read=await runInDurableObject(q,(_instance,ctx)=>{const c=ctx.storage.sql.exec("SELECT v FROM settings WHERE k='used'");const used=c.one().v;return {used,rowsRead:c.rowsRead};});
 expect(read).toEqual({used:250001,rowsRead:1});
},30000);

it("checkpoints lineage inventory and leaves the entitlement limit unchanged during read-only usage",async()=>{
 const q=quota("inventory-checkpoint");await q.configure(99,[]);
 const lineages=["inventory-one","inventory-two","inventory-three","inventory-four","inventory-five"];
 for(const id of lineages)await env.SHARDS.put(`shards/${id}/${"a".repeat(64)}`,bytes("123"));
 expect(await runInDurableObject(q,async instance=>{try{await instance.usage(lineages);return "ready";}catch(e){return (e as Error).message;}})).toBe("quota_initializing");
 expect(await runInDurableObject(q,(_instance,ctx)=>ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM quota_scans").one().n)).toBe(3);
 expect(await q.reserve(objectKey(10),1)).toBe(false);
 expect(await runInDurableObject(q,async instance=>{try{await instance.usage([]);return "ready";}catch(e){return (e as Error).message;}})).toBe("quota_initializing");
 expect(await q.usage([])).toEqual({usedBytes:15});
 expect(await runInDurableObject(q,(_instance,ctx)=>ctx.storage.sql.exec("SELECT v FROM settings WHERE k='limit'").one().v)).toBe(99);
 expect(await q.usage(lineages)).toEqual({usedBytes:15});
});

it("verified deletion refuses active uploads and releases exactly once",async()=>{
 const q=quota("delete-fence-test"),data=bytes("data"),h=await sha256Hex(data),key=`shards/quota-fixture/${h}`;
 await q.configure(4,[]);expect(await q.reserve(key,4)).toBe(true);await env.SHARDS.put(key,data);
 expect(await q.deleteUnreferenced(key)).toBe(false);expect(await env.SHARDS.head(key)).not.toBeNull();
 await q.finish(key,true);expect(await q.releaseDeleted(key)).toBe(false);
 expect(await q.deleteUnreferenced(key)).toBe(true);expect(await q.deleteUnreferenced(key)).toBe(true);
 expect(await q.usage([])).toEqual({usedBytes:0});expect(await q.reserve(key,4)).toBe(true);
});

it("bounded reconciliation removes absent idle rows but retains ambiguous active reservations",async()=>{
 const q=quota("reconcile-test");await q.configure(20,[]);
 await q.reserve(objectKey(1),4);await q.finish(objectKey(1),true);
 await q.reserve(objectKey(2),5);
 expect(await q.reconcile([])).toEqual({usedBytes:5,checked:2,unresolved:1,more:false});
 expect(await q.usage([])).toEqual({usedBytes:5});
});

it("GC retries lost deletion acknowledgments and releases enforced quota",async()=>{
 const id=await newDrive(),org="gc-release-test",key=await genKey(org);installJwks(key);
 const token=await signToken(key,{org,drives:[{id,access:"write"}]});await admin.configureQuota(org,4,[id]);
 const data=bytes("data"),h=await sha256Hex(data),object=`shards/${id}/${h}`;
 expect((await api(`/v0/drives/${id}/shards/${h}`,{method:"PUT",body:data,token})).status).toBe(201);
 const q=quota(org);
 await runInDurableObject(drive(id),async(instance,ctx)=>{
  const ns=(instance as any).env.STORAGE_QUOTA as DurableObjectNamespace<StorageQuota>;
  const localQuota=ns.get(ns.idFromName(org));
  let loseAck=true;
  const gc=new LineageGC(ctx.storage.sql,env.SHARDS,id,async k=>{const deleted=await localQuota.deleteUnreferenced(k);if(loseAck){loseAck=false;throw new Error("lost deletion ack");}return deleted;},k=>localQuota.recoverDeletion(k));
  const now=Date.now()+GC_GRACE_MS+60000;
  await gc.step(0,now,false);await expect(gc.step(0,now,false)).rejects.toThrow("lost deletion ack");
  expect(ctx.storage.sql.exec("SELECT k FROM gc_pending").toArray()).toHaveLength(1);
  await gc.step(0,now,false);
  expect(ctx.storage.sql.exec("SELECT k FROM gc_pending").toArray()).toHaveLength(0);
 });
 expect(await env.SHARDS.head(object)).toBeNull();expect(await q.usage([id])).toEqual({usedBytes:0});
});

it("GC never replays a stale deletion after a new generation references the object",async()=>{
 const id=await newDrive(),data=bytes("newly referenced"),h=await sha256Hex(data),object=`shards/${id}/${h}`;
 await env.SHARDS.put(object,data);
 await runInDurableObject(drive(id),async(_instance,ctx)=>{
  ctx.storage.sql.exec("INSERT INTO gc_pending VALUES(?,1)",object);
  let deletes=0,recoveries=0;
  const gc=new LineageGC(ctx.storage.sql,env.SHARDS,id,async()=>{deletes++;return true;},async()=>{recoveries++;});
  await gc.step(2,Date.now(),false);
  expect(deletes).toBe(0);expect(recoveries).toBe(1);
 });
 expect(await env.SHARDS.head(object)).not.toBeNull();
});

it("GC keeps file attributes and their spilled metadata while reclaiming old unreferenced metadata",async()=>{
 const id=await newDrive(),content=bytes("attribute bytes"),h=await sha256Hex(content);
 await env.SHARDS.put(`shards/${id}/${h}`,content);
 const attrs=JSON.stringify({"com.apple.ResourceFork":[[h,content.length]]}),attrsHash=await sha256Hex(bytes(attrs));
 await env.SHARDS.put(`manifests/${id}/${attrsHash}`,bytes(attrs));
 const orphan=bytes("orphan metadata"),orphanHash=await sha256Hex(orphan),orphanKey=`manifests/${id}/${orphanHash}`;
 await env.SHARDS.put(orphanKey,orphan);
 const result=await runInDurableObject(drive(id),async(_instance,ctx)=>{
  ctx.storage.sql.exec("INSERT INTO versions(id,path,op,size,manifest,seq,ts,xattrs) VALUES('attr-test','file','put',0,'[]',1,1,?)","r2:"+attrsHash);
  const gc=new LineageGC(ctx.storage.sql,env.SHARDS,id);
  for(let i=0;i<10;i++){const r=await gc.step(1,Date.now()+GC_GRACE_MS+60000,false);if(r.done)return r;}
  throw new Error("gc did not finish");
 });
 expect(result.deleted).toBe(1);expect(await env.SHARDS.head(orphanKey)).toBeNull();
 expect(await env.SHARDS.head(`shards/${id}/${h}`)).not.toBeNull();expect(await env.SHARDS.head(`manifests/${id}/${attrsHash}`)).not.toBeNull();
});
