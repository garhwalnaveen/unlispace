import { expect,it } from "vitest";
import { DataPlane } from "../src/data-plane";
import { authenticate } from "../src/auth";
import { handle } from "../src/index";
import { harness,makeBucket,rawSigned,text } from "./helpers";
import { digest } from "../src/crypto";

it("reads, ranges, edits, copies and restores paged content without losing subsequent pages",async()=>{
  const h=await harness(),b=makeBucket(h);
  const auth=await authenticate(await rawSigned(h,"GET","/"),h.deps.resolver);
  const dp=new DataPlane(h.deps.dataPlane,h.deps.tokens,auth.key,b);
  const hash=await digest(text("x"));h.dp.shards.set(`${b}/${hash}`,text("x"));
  const content=await dp.buildManifest((async function*(){for(let i=0;i<2001;i++)yield{h:hash,n:1};})());
  expect(content.manifestRef).toMatch(/^tree:/);
  const saved=await dp.commit([{op:"put",path:"large",...content,contentType:"text/plain",mtimeMs:0}]);
  const version=saved.results[0]!.versionId;
  const call=async(method:string,path:string,headers:Record<string,string>={},body?:string)=>handle(await rawSigned(h,method,`/${b}/${path}`,{headers,body}),h.deps);
  expect(await(await call("GET","large")).text()).toBe("x".repeat(2001));
  expect(await(await call("GET","large",{range:"bytes=1999-2000"})).text()).toBe("xx");
  const renamed=await call("PUT","renamed?x-uls-rename",{"x-uls-source":"large"});expect(renamed.status).toBe(200);
  const copy=await call("PUT","copy",{"x-amz-copy-source":`${b}/renamed`});expect(copy.status).toBe(200);
  expect(await(await call("GET","copy")).text()).toBe("x".repeat(2001));
  const edit=await call("PUT","renamed?x-uls-write",{"x-uls-offset":"2000"},"Y");expect(edit.status).toBe(200);
  expect(await(await call("GET","renamed",{range:"bytes=1999-2000"})).text()).toBe("xY");
  const truncate=await call("PUT","renamed?x-uls-write",{"x-uls-offset":"0","x-uls-size":"5"});expect(truncate.status).toBe(200);
  expect(await(await call("GET","renamed")).text()).toBe("xxxxx");
  expect((await call("POST",`renamed?x-uls-restore&versionId=${version}`)).status).toBe(200);
  expect(await(await call("GET","renamed",{range:"bytes=1999-2000"})).text()).toBe("xx");
});
