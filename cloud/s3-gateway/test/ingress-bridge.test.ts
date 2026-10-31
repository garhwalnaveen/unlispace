import { expect, it } from "vitest";
import { handleIngressBridge } from "../src/ingress-bridge";
import { harness, KEY_ID } from "./helpers";

const secret="ingress-fixture-secret-longer-than32-characters";
const request=(value:unknown, authorization=`Bearer ${secret}`) => new Request("https://s3.test/_uls/ingress",{method:"POST",headers:{authorization},body:JSON.stringify(value)});

it("requires a private ingress secret before dispatching allowlisted operations",async()=>{
  const h=await harness();
  for(const configured of [undefined,"short",secret]) {
    const response=await handleIngressBridge(request({service:"control",method:"resolveKey",args:[KEY_ID]},"Bearer wrong"),h.deps,configured);
    expect(response?.status).toBe(403);
  }
  const result=await handleIngressBridge(request({service:"control",method:"resolveKey",args:[KEY_ID]}),h.deps,secret);
  expect(result?.status).toBe(200);
  expect(await result!.json()).toMatchObject({value:{accessKeyId:KEY_ID}});
  expect(await handleIngressBridge(new Request("https://s3.test/not-internal"),h.deps,secret)).toBeNull();
  expect((await handleIngressBridge(new Request("https://s3.test/_uls/ingress",{headers:{authorization:`Bearer ${secret}`}}),h.deps,secret))?.status).toBe(405);
  for(const value of [
    {service:"control",method:"constructor",args:[]},
    {service:"control",method:"fetch",args:[]},
    {service:"state",method:"get",args:["key"]},
    {service:"state",method:"list",args:["upload:",null,1001],org:"org",keyId:KEY_ID},
    {service:"session",method:"fetch",args:[{path:"/admin",method:"POST"}]},
  ]) expect((await handleIngressBridge(request(value),h.deps,secret))?.status).toBe(400);
});

it("preserves RPC errors and limits internal request bodies",async()=>{
  const h=await harness();
  h.deps.controlPlane.resolveBucket=async()=>{throw new Error("no_such_bucket");};
  const response=await handleIngressBridge(request({service:"control",method:"resolveBucket",args:[KEY_ID,"missing"]}),h.deps,secret);
  expect(response?.status).toBe(503);
  expect(await response!.json()).toEqual({error:"no_such_bucket"});
  const huge=new Request("https://s3.test/_uls/ingress",{method:"POST",headers:{authorization:`Bearer ${secret}`},body:new ReadableStream<Uint8Array>({
    start(controller){const piece=new Uint8Array(1024*1024);for(let i=0;i<9;i++)controller.enqueue(piece);controller.close();},
  })});
  expect((await handleIngressBridge(huge,h.deps,secret))?.status).toBe(413);
});
