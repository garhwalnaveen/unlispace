import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { request } from "node:http";
import { once } from "node:events";
import { test } from "node:test";
import { ingressServer } from "./dist/ingress.mjs";

const keyId = "ULS1ABCDEFGHJKLMNPQR", secret = "streaming-test-only-secret";
const sha = value => createHash("sha256").update(value).digest("hex");
const hmac = (key,value) => createHmac("sha256",key).update(value).digest();
function sign(host, path, length, extras={}) {
  const date = new Date().toISOString().replace(/[:-]|\.\d{3}/g,""), day = date.slice(0,8);
  const headers = {host,"x-amz-date":date,"x-amz-content-sha256":"UNSIGNED-PAYLOAD",...extras};
  const names = Object.keys(headers).sort(), signed = names.join(";");
  const canonical = names.map(name=>`${name}:${headers[name]}\n`).join("");
  const scope = `${day}/auto/s3/aws4_request`;
  const payload = `PUT\n${path}\n\n${canonical}\n${signed}\nUNSIGNED-PAYLOAD`;
  const signing = hmac(hmac(hmac(hmac(`AWS4${secret}`,day),"auto"),"s3"),"aws4_request");
  return {...headers,"content-length":String(length),authorization:`AWS4-HMAC-SHA256 Credential=${keyId}/${scope}, SignedHeaders=${signed}, Signature=${createHmac("sha256",signing).update(`AWS4-HMAC-SHA256\n${date}\n${scope}\n${sha(payload)}`).digest("hex")}`};
}

const testLength=Number(process.env.ULS_STREAM_TEST_BYTES??128*1024*1024);
assert.ok(Number.isSafeInteger(testLength)&&testLength>0&&testLength<=5*1024**3);
test(`streams a signed ${testLength}-byte PUT over a real HTTP socket with bounded buffers`, async () => {
  let bytes = 0, largest = 0, commits = 0;
  const values = new Map();
  const deps = {
    resolver:{resolve:async()=>({keyId,secretAccessKey:secret,subject:"test",orgId:"org",scope:"admin"})},
    controlPlane:{resolveBucket:async()=>({driveId:"drive",access:"admin",writable:true})},
    state:{get:async key=>values.get(key),put:async(key,value)=>{values.set(key,value);}},
    tokens:{mint:async()=>"test-token"},host:"127.0.0.1",now:Date.now,
    dataPlane:{async fetch(req) {
      const path = new URL(req.url).pathname;
      if (path.endsWith("/manifest")) return Response.json({error:"no_such_path"},{status:404});
      if (path.includes("/shards/")) {
        const hash = createHash("sha256"); let size=0;
        for await (const part of req.body) {size+=part.length;hash.update(part);}
        assert.equal(hash.digest("hex"),path.split("/").at(-1));
        assert.ok(size<=16*1024*1024);bytes+=size;largest=Math.max(largest,size);
        return Response.json({stored:true});
      }
      if (path.endsWith("/commit")) {
        const {ops}=await req.json(); assert.equal(ops[0].size,testLength);commits++;
        return Response.json({seq:1,results:[{path:"large",versionId:"v_stream",size:ops[0].size}]});
      }
      throw new Error(`Unexpected data-plane request: ${path}`);
    }},
  };
  const server=ingressServer(deps,"http");server.listen(0,"127.0.0.1");await once(server,"listening");
  const host=`127.0.0.1:${server.address().port}`,length=testLength;
  const baseline=process.memoryUsage().rss;let peak=baseline;
  const monitor=setInterval(()=>{peak=Math.max(peak,process.memoryUsage().rss);},5);
  try {
    const response=new Promise((resolve,reject)=>{
      const outgoing=request({host:"127.0.0.1",port:server.address().port,path:"/bucket/large",method:"PUT",headers:sign(host,"/bucket/large",length)},resolve);
      outgoing.on("error",reject);
      void(async()=>{try{const chunk=Buffer.alloc(512*1024,7);for(let sent=0;sent<length;sent+=chunk.length) if(!outgoing.write(chunk.subarray(0,Math.min(chunk.length,length-sent)))) await once(outgoing,"drain");outgoing.end();}catch(error){outgoing.destroy(error);}})();
    });
    const result=await response;let body="";for await(const part of result)body+=part;
    assert.equal(result.statusCode,200,body);assert.equal(bytes,length);assert.equal(commits,1);assert.equal(largest,16*1024*1024);
    // Both ends share this process; Node may retain recently freed native crypto/body buffers.
    assert.ok(peak-baseline<256*1024*1024,`RSS grew by${peak-baseline}bytes`);
    console.log(JSON.stringify({uploadedBytes:bytes,maxShardBytes:largest,rssGrowthBytes:peak-baseline}));
  } finally {clearInterval(monitor);server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
