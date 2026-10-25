import { spawn } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";

const domain = process.env.ULS_WORKERS_DOMAIN;
if (!domain || !/^[a-z0-9.-]+$/.test(domain)) {
	console.error("Set ULS_WORKERS_DOMAIN to the production workers.dev domain (for example, naveen-f3d.workers.dev).");
	process.exit(2);
}

const args = process.argv.slice(2);
const configArg = args.findIndex((arg) => arg === "-c" || arg === "--config");
if (configArg < 0 || !args[configArg + 1]) {
	console.error("Pass a Wrangler config with -c <path> or --config <path>.");
	process.exit(2);
}

const configPath = resolve(args[configArg + 1]);
const source = await readFile(configPath, "utf8");

const tempConfig = resolve(dirname(configPath), `.wrangler-production-${randomUUID()}.jsonc`);
try {
	await writeFile(tempConfig, source.replaceAll("__WORKERS_DOMAIN__", domain));
	args[configArg + 1] = tempConfig;
	const child = spawn("npx", ["wrangler", ...args], { stdio: "inherit" });
	child.on("error", (error) => {
		console.error(error.message);
		process.exitCode = 1;
	});
	const exitCode = await new Promise((resolveExit) => child.on("close", resolveExit));
	process.exitCode ??= exitCode ?? 1;
} finally {
	await rm(tempConfig, { force: true });
}
