import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { MemoryKeyResolver } from "../src/auth";
import { Ed25519TokenMinter } from "../src/data-plane";
import type { Deps } from "../src/index";
import type { StateStore } from "../src/state";
import { FakeDataPlane } from "../test/fake-data-plane";
import { FakeControlPlane } from "../test/fake-control-plane";
import { ingressServer } from "./ingress";

const id="ULS1ABCDEFGHJKLMNPQR";
const readId="ULS1READONLYREADONLY";
const resolver=new MemoryKeyResolver(btoa("fixture-master-with-32-characters!"),[
  {keyId:id,subject:"fixture-user",orgId:"org-1",scope:"admin"},
  {keyId:readId,subject:"fixture-user",orgId:"org-1",scope:"read"},
]);
const dp=new FakeDataPlane(), cp=new FakeControlPlane(dp,resolver);
const values=new Map<string,unknown>();
const state:StateStore={
  async get<T>(key:string){return values.get(key) as T|undefined;},
  async put(key,value){values.set(key,value);},async delete(key){values.delete(key);},
  async list<T>(prefix:string,after?:string,limit=1000){return [...values].filter(([k])=>k.startsWith(prefix)&&(!after||k>after)).sort(([a],[b])=>a<b?-1:a>b?1:0).slice(0,limit) as [string,T][];},
  async multipart(){throw new Error("This SDK fixture does not model multipart state");},
};
const pair=await crypto.subtle.generateKey({name:"Ed25519"},true,["sign","verify"]) as CryptoKeyPair;
const jwk={...(await crypto.subtle.exportKey("jwk",pair.privateKey) as JsonWebKey),kid:"sdk-fixture"};
const deps:Deps={resolver,controlPlane:cp,state,dataPlane:dp,tokens:new Ed25519TokenMinter(jwk,"sdk-fixture"),sessionAPI:{fetch:async()=>new Response(null,{status:501})},host:"127.0.0.1",now:Date.now};
const server=ingressServer(deps,"http");
server.listen(0,"127.0.0.1");
await once(server,"listening");
const address=server.address();
if(!address||typeof address==="string")throw new Error("No fixture address");
try{
  const child=spawn(process.env.ULS_SDK_PYTHON??"python3",[fileURLToPath(new URL("../../test/sdk-python.py",import.meta.url))],{
    stdio:["ignore","inherit","inherit"],env:{...process.env,ULS_TEST_ENDPOINT:`http://127.0.0.1:${address.port}`,ULS_TEST_ACCESS_KEY:id,ULS_TEST_SECRET:(await resolver.resolve(id))!.secretAccessKey},
  });
  const [code]=await once(child,"exit");
  if(code!==0)process.exitCode=1;
  if(code===0 && process.env.ULS_SDK_RUST==="1") {
    dp.createDrive("native-mount");
    cp.register("native-mount");
    const rust=spawn("cargo",["test","-p","uls-client","--test","mount_gateway","--","--ignored"],{
      cwd:fileURLToPath(new URL("../../../../engine",import.meta.url)),stdio:["ignore","inherit","inherit"],
      env:{...process.env,ULS_TEST_ENDPOINT:`http://127.0.0.1:${address.port}`,ULS_TEST_ACCESS_KEY:id,ULS_TEST_SECRET:(await resolver.resolve(id))!.secretAccessKey,
        ULS_TEST_DRIVE:"native-mount",ULS_TEST_READ_ACCESS_KEY:readId,ULS_TEST_READ_SECRET:(await resolver.resolve(readId))!.secretAccessKey},
    });
    const [rustCode]=await once(rust,"exit");
    if(rustCode!==0)process.exitCode=1;
  }
}finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
