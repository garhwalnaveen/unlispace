import {expect,it,vi} from "vitest";
import {DataPlane,type CommitOp,MAX_COMMIT_BYTES} from "../src/data-plane";
import {digest,utf8} from "../src/crypto";

it("sends larger manifests through NDJSON with the same idempotency key",async()=>{
  const fetcher=vi.fn(async(request:Request)=>{
    expect(request.headers.get("content-type")).toBe("application/x-ndjson");
    expect(request.headers.get("x-uls-request-id")).toBe("multipart:retry");
    expect(JSON.parse((await request.text()).trim()).shards).toHaveLength(15000);
    return Response.json({seq:1,results:[]});
  });
  const dp=new DataPlane({fetch:fetcher},{mint:async()=>"local-token"},{keyId:"key",subject:"user",orgId:"org",scope:"write"},"drive");
  const op:CommitOp={op:"put",path:"large",size:15000,contentType:"text/plain",mtimeMs:0,shards:Array.from({length:15000},()=>({h:"a".repeat(64),n:1}))};
  expect(new TextEncoder().encode(JSON.stringify(op)).length).toBeGreaterThan(1024*1024);
  await dp.commit([op],"multipart:retry");
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("builds bounded two-level indexes after a million content references",async()=>{
  const metadata=new Map<string,unknown>();let largest=0;
  const dp=new DataPlane({fetch:async(request:Request)=>{
    expect(new URL(request.url).pathname.endsWith("/manifest-pages")).toBe(true);
    const data=await request.text();largest=Math.max(largest,utf8.encode(data).length);
    const hash=await digest(utf8.encode(data));metadata.set(hash,JSON.parse(data));
    return Response.json({hash});
  }},{mint:async()=>"local-token"},{keyId:"key",subject:"user",orgId:"org",scope:"write"},"drive");
  const result=await dp.buildManifest((async function*(){for(let i=0;i<1_000_001;i++)yield{h:"a".repeat(64),n:1};})());
  expect(result.shards).toEqual([]);expect(result.size).toBe(1_000_001);
  const root=metadata.get(result.manifestRef!.slice(5)) as {format:string;indexes:{h:string;pages:number}[]};
  expect(root.format).toBe("uls-manifest-v2");expect(root.indexes.map(i=>i.pages)).toEqual([1000,1]);
  expect(largest).toBeLessThan(256*1024);
},60_000);

it("rejects an oversized manifest before sending a commit",async()=>{
  const fetcher=vi.fn();
  const dp=new DataPlane({fetch:fetcher},{mint:async()=>"local-token"},{keyId:"key",subject:"user",orgId:"org",scope:"write"},"drive");
  await expect(dp.commit([{op:"put",path:"large",size:0,contentType:"x".repeat(MAX_COMMIT_BYTES),mtimeMs:0,shards:[]}])).rejects.toMatchObject({code:"EntityTooLarge"});
  expect(fetcher).not.toHaveBeenCalled();
});
