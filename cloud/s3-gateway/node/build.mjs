import { build } from "esbuild";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
await build({
  absWorkingDir: root, entryPoints: ["node/main.ts", "node/ingress.ts"], outdir: "node/dist", outExtension: {".js": ".mjs"},
  bundle: true, platform: "node", format: "esm", target: "node22", sourcemap: true,
  plugins: [{name: "worker-class-declaration", setup(build) {
    build.onResolve({filter: /^cloudflare:workers$/}, () => ({path: "cloudflare:workers", namespace: "worker-types"}));
    // The gateway exports Worker classes as well as its pure handler. Node never constructs them.
    build.onLoad({filter: /.*/, namespace: "worker-types"}, () => ({contents: "export class DurableObject {}; export class WorkerEntrypoint {};", loader: "js"}));
  }}],
});
