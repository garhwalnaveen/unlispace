import {env} from "cloudflare:workers";
import {expect,it} from "vitest";
import {BoundState,WorkspaceState,stateRows,partShards,type Part,type Upload} from "../src/state";

function store(name:string) {return new BoundState(env.S3_STATE.get(env.S3_STATE.idFromName(`migration-${name}-${crypto.randomUUID()}`)));}
const upload=(id:string,drive="ours"):Upload=>({id,drive,key:id,createdAt:0,contentType:"text/plain",status:"open"});

it("keeps legacy multipart leases in their authority while new workspace state is isolated",async()=>{
  const current=store("new"),legacy=store("old");
  const state=new WorkspaceState(current,legacy,async()=>new Set(["ours"]));
  await legacy.put("upload:old",upload("old"));
  await legacy.put("upload:foreign",upload("foreign","theirs"));
  await legacy.put("version:ours:v_old",{operation:"copy"});
  await state.put("upload:new",upload("new"));
  await state.multipart("old","lock",{lease:"legacy-owner"});
  expect((await legacy.get<Upload>("upload:old"))?.lease).toBe("legacy-owner");
  expect(await current.get("upload:old")).toBeUndefined();
  expect(await legacy.get("upload:new")).toBeUndefined();
  expect(await state.get("version:ours:v_old")).toEqual({operation:"copy"});
  expect((await state.list<Upload>("upload:")).map(([,u])=>u.id).sort()).toEqual(["new","old"]);
  await state.multipart("old","abort",{lease:"legacy-owner"});
  expect(await legacy.get("upload:old")).toBeUndefined();
});

it("pages state without dropping records across legacy and workspace boundaries",async()=>{
  const current=store("page-new"),legacy=store("page-old");
  const state=new WorkspaceState(current,legacy,async()=>new Set(["ours"]));
  for(let i=0;i<205;i++) {
    const id=String(i).padStart(4,"0");
    await (i%2 ? current : legacy).put(`upload:${id}`,upload(id));
  }
  const found=[];
  for await(const [key] of stateRows(state,"upload:")) found.push(key);
  expect(found).toHaveLength(205);
  expect(new Set(found).size).toBe(205);
  expect(found).toEqual([...found].sort());
});

it("persists completion manifests in bounded values and hydrates them for crash retries",async()=>{
  const state=store("completion");
  await state.put("upload:large",upload("large"));
  await state.multipart("large","lock",{lease:"one"});
  const shards=Array.from({length:30000},()=>({h:"a".repeat(64),n:1}));
  const completion={operation:{op:"put" as const,path:"large",size:30000,shards,contentType:"text/plain",mtimeMs:0},parts:"[]",etag:"test"};
  expect((await state.multipart("large","prepare",{lease:"one",completion})).completion?.operation).toMatchObject({shards:[],size:30000});
  const persisted=await state.get<Upload>("upload:large");
  expect(persisted?.completionPages).toBe(30);
  expect(persisted?.completion?.operation).toMatchObject({shards:[]});
  await state.multipart("large","unlock",{lease:"one"});
  expect((await state.multipart("large","lock",{lease:"two"})).completion?.operation).toMatchObject({shards});
  await state.multipart("large","abort",{lease:"two"});
  expect(await state.list("completion:large:")).toEqual([]);
});

it("pages large parts, replaces them atomically, and clears pages on abort",async()=>{
  const state=store("part-pages");
  await state.put("upload:large-part",upload("large-part"));
  const shards=Array.from({length:30000},(_,i)=>({h:i.toString(16).padStart(64,"0"),n:1}));
  const part:Part={number:1,size:shards.length,etag:"first",modified:0,shards};
  await state.multipart("large-part","part",part);
  const saved=await state.get<Part>("part:large-part:00001");
  expect(saved).toMatchObject({shards:[],shardPages:30,size:30000});
  const found=[];
  for await(const ref of partShards(state,"large-part",saved!)) found.push(ref);
  expect(found).toEqual(shards);
  await state.multipart("large-part","part",{...part,shards:shards.slice(0,3),size:3,etag:"replacement"});
  expect(await state.list("part-shards:large-part:")).toHaveLength(1);
  const replacement=await state.get<Part>("part:large-part:00001");
  const refs=[];
  for await(const ref of partShards(state,"large-part",replacement!)) refs.push(ref);
  expect(refs).toEqual(shards.slice(0,3));
  await state.multipart("large-part","abort");
  expect(await state.list("part-shards:large-part:")).toEqual([]);
  expect(await state.list("part:large-part:")).toEqual([]);
});
