import { expect, it, vi } from "vitest";
import { DataPlane, type FetchBinding, type Manifest } from "../src/data-plane";
import { AVG_SIZE, MAX_SIZE, chunkManifest, chunkStream } from "../src/chunker";
import { handle } from "../src/index";
import { getObject, type ObjectContext } from "../src/objects";
import { harness, makeBucket, rawSigned, randomBytes, records } from "./helpers";
import { PutObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { client } from "./helpers";

const manifest: Manifest = {path:"x",versionId:"v",size:12,contentType:null,mtimeMs:0,shards:[{h:"a",n:4},{h:"b",n:4},{h:"c",n:4}]};
const plane = (binding: FetchBinding) => new DataPlane(binding, {mint:async()=>"test"}, records[0]!, "drive");
const collect = async (source: AsyncIterable<Uint8Array>) => { const bytes: number[] = []; for await (const part of source) bytes.push(...part); return bytes; };
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

it("enforces the advertised object length even when an iterator ends early", async () => {
  const dp = plane({fetch:async()=>{throw new Error("unexpected fetch");}});
  dp.manifest = async()=>({...manifest,size:8,shards:[{h:"a",n:8}]});
  const request = new Request("https://s3.test/b/x");
  const context = {request,url:new URL(request.url),dp,key:"x"} as ObjectContext;
  dp.bytes = async function* () { yield new Uint8Array(4); };
  await expect((await getObject(context)).arrayBuffer()).rejects.toThrow();
  dp.bytes = async function* () { yield new Uint8Array(8); };
  const response = await getObject(context);
  expect(response.headers.get("content-length")).toBe("8");
  expect((await response.arrayBuffer()).byteLength).toBe(8);
});

it("forwards only overlapping ranges and preserves shard order with one read ahead", async () => {
  const requested: string[] = [];
  const dp = plane({async fetch(req) {
    const h = new URL(req.url).pathname.split("/").at(-1)!;
    requested.push(`${h}:${req.headers.get("range")}`);
    const bytes = new TextEncoder().encode({a:"abcd",b:"efgh",c:"ijkl"}[h]!);
    const range = req.headers.get("range");
    if (!range) return new Response(bytes);
    const [a,b] = range.slice(6).split("-").map(Number);
    return new Response(bytes.slice(a,b!+1), {status:206,headers:{"content-range":`bytes ${a}-${b}/4`}});
  }});
  expect(await collect(dp.bytes(manifest, 2, 9))).toEqual([...new TextEncoder().encode("cdefghi")]);
  expect(requested).toEqual(["a:bytes=2-3","b:null","c:bytes=0-0"]);
});

it("cancels the active body and unused read ahead without fetching the remaining file", async () => {
  let requested = 0, cancelled = 0;
  const dp = plane({async fetch() {
    requested++;
    return new Response(new ReadableStream({start(c) { c.enqueue(new Uint8Array(4)); },cancel() { cancelled++; }}));
  }});
  const source = dp.bytes(manifest);
  await source.next();
  expect(requested).toBe(2);
  await source.return(undefined);
  expect(cancelled).toBe(2);
  expect(requested).toBe(2);
});

it("rejects short shards, bad range responses and short manifests", async () => {
  await expect(collect(plane({fetch:async()=>new Response(new Uint8Array(1))}).bytes(manifest))).rejects.toThrow("Truncated shard");
  await expect(collect(plane({fetch:async()=>new Response(new Uint8Array(2),{status:206,headers:{"content-range":"bytes 0-1/4"}})}).bytes(manifest,2,4))).rejects.toThrow("Invalid shard range");
  await expect(collect(plane({fetch:async()=>new Response(new Uint8Array(4))}).bytes({...manifest,shards:[]}))).rejects.toThrow("Truncated manifest");
});

it("emits a stable CDC boundary before buffering a maximum shard", async () => {
  let fed = 0;
  async function* source() { for (let n = 0; n < 8; n++) { fed += AVG_SIZE; yield randomBytes(AVG_SIZE, n + 1); } }
  const chunks = chunkStream(source());
  const first = await chunks.next();
  expect(first.value!.length).toBeLessThan(MAX_SIZE);
  expect(fed).toBeLessThan(MAX_SIZE);
  await chunks.return(undefined);
});

it("bounds upload bytes and waits for in-flight uploads after failure", async () => {
  const releases: (()=>void)[] = [];
  let active = 0, maxBytes = 0, done = false;
  async function* source() { yield new Uint8Array(3 * MAX_SIZE); }
  const failure = new Error("upload failed");
  const result = chunkManifest(source(), async (_s, bytes) => {
    active += bytes.length; maxBytes = Math.max(maxBytes, active);
    await new Promise<void>(resolve=>releases.push(resolve));
    active -= bytes.length;
    throw failure;
  }, true).catch(e => { done = true; return e; });
  while (!releases.length) await tick();
  expect(done).toBe(false);
  releases.shift()!();
  expect(await result).toBe(failure);
  expect(active).toBe(0);
  expect(maxBytes).toBeLessThanOrEqual(MAX_SIZE);
});

it("settles every overlapping upload before returning a failure", async () => {
  const releases: (()=>void)[]=[];
  let active=0, returned=false;
  async function* source() { yield randomBytes(12*AVG_SIZE); }
  const failed=chunkManifest(source(),async()=>{
    active++;
    const index=releases.length;
    await new Promise<void>(resolve=>releases.push(resolve));
    active--;
    if(index===0) throw new Error("first upload failed");
  }).catch(e=>{returned=true;return e;});
  while(releases.length<3) await tick();
  releases[0]!(); await tick();
  expect(returned).toBe(false);
  for(const release of releases) release();
  expect((await failed).message).toBe("first upload failed");
  expect(active).toBe(0);
});

it("overlaps chunk uploads without publishing before all uploads finish", async () => {
  let active = 0, maxActive = 0;
  async function* source() { yield randomBytes(12 * AVG_SIZE); }
  const result = await chunkManifest(source(), async () => {
    active++; maxActive = Math.max(maxActive,active); await tick(); active--;
  });
  expect(maxActive).toBeGreaterThan(1);
  expect(maxActive).toBeLessThanOrEqual(4);
  expect(active).toBe(0);
  expect(result.reduce((n,s)=>n+s.n,0)).toBe(12*AVG_SIZE);
});

it("returns HEAD while recording key use through waitUntil", async () => {
  const h = await harness(), b = makeBucket(h);
  let release!: ()=>void;
  h.deps.resolver.recordUse = vi.fn(()=>new Promise<void>(resolve=>{release=resolve;}));
  const pending: Promise<unknown>[] = [];
  const response = await handle(await rawSigned(h,"HEAD",`/${b}`),h.deps,{waitUntil:p=>{pending.push(p);}});
  expect(response.status).toBe(200);
  expect(pending.length).toBe(1);
  release(); await Promise.all(pending);
});

it("bounds listing manifest concurrency and looks up the listed versions", async () => {
  const h = await harness(), b = makeBucket(h), s3 = await client(h.deps);
  for (let i=0;i<10;i++) await s3.send(new PutObjectCommand({Bucket:b,Key:`x/${i}`,Body:"hello"}));
  const fetch = h.dp.fetch.bind(h.dp);
  let active=0, peak=0;
  h.deps.dataPlane={async fetch(req) {
    const u=new URL(req.url);
    if(!u.pathname.endsWith("/manifest")) return fetch(req);
    expect(u.searchParams.get("versionId")).toBeTruthy();
    active++;peak=Math.max(peak,active); await tick();
    try { return await fetch(req); } finally {active--;}
  }};
  const listing=await s3.send(new ListObjectsV2Command({Bucket:b,Prefix:"x/"}));
  expect(listing.Contents?.map(e=>e.Key)).toEqual(Array.from({length:10},(_,i)=>`x/${i}`));
  expect(peak).toBe(8);
  expect(active).toBe(0);
});

it("never commits an object when a pipelined chunk upload fails", async () => {
  const h=await harness(),b=makeBucket(h),s3=await client(h.deps);
  const fetch=h.dp.fetch.bind(h.dp);
  let commits=0;
  h.deps.dataPlane={async fetch(req) {
    const path=new URL(req.url).pathname;
    if(path.endsWith("/commit")) commits++;
    if(req.method==="PUT" && path.includes("/shards/")) return Response.json({error:"bad_request",message:"upload refused"},{status:400});
    return fetch(req);
  }};
  await expect(s3.send(new PutObjectCommand({Bucket:b,Key:"failed",Body:randomBytes(8*AVG_SIZE)}))).rejects.toMatchObject({name:"InvalidArgument"});
  expect(commits).toBe(0);
  expect(h.dp.drives.get(b)!.nodes.has("failed")).toBe(false);
});
