import { build } from "esbuild";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
const root=fileURLToPath(new URL("../",import.meta.url));
await build({absWorkingDir:root,entryPoints:["node/sdk-conformance.ts"],outfile:"node/dist/sdk-conformance.mjs",bundle:true,platform:"node",format:"esm",target:"node22",plugins:[{
  name:"worker-declaration",setup(b){b.onResolve({filter:/^cloudflare:workers$/},()=>({path:"worker",namespace:"fixture"}));b.onLoad({filter:/.*/,namespace:"fixture"},()=>({contents:"export class DurableObject {};",loader:"js"}));},
}]});
const child=spawn(process.execPath,[fileURLToPath(new URL("./dist/sdk-conformance.mjs",import.meta.url))],{stdio:"inherit"});
const [code]=await once(child,"exit");
process.exitCode=code??1;
