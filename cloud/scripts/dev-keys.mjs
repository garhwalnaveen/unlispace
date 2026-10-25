#!/usr/bin/env node
// Generates an Ed25519 signing keypair for local dev and writes it into the .dev.vars files:
//   cloud/api/.dev.vars         ULS_JWT_PRIVATE_JWK, ULS_JWT_PUBLIC_JWKS
//   cloud/data-plane/.dev.vars  ULS_JWT_PUBLIC_JWKS
// Other lines are preserved. Existing keys are kept unless --rotate is passed (the old public key
// stays in the JWKS so outstanding tokens keep verifying). Secrets are never printed.
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const apiVars = join(root, "api", ".dev.vars");
const dpVars = join(root, "data-plane", ".dev.vars");
const rotate = process.argv.includes("--rotate");

function readLines(path) {
	return existsSync(path) ? readFileSync(path, "utf8").split("\n") : [];
}
function getVar(lines, key) {
	const l = lines.find((x) => x.startsWith(key + "="));
	return l ? l.slice(key.length + 1) : undefined;
}
function setVar(lines, key, value) {
	const i = lines.findIndex((x) => x.startsWith(key + "="));
	const line = `${key}=${value}`;
	if (i >= 0) lines[i] = line;
	else {
		while (lines.length && lines[lines.length - 1] === "") lines.pop();
		lines.push(line);
	}
}
function write(path, lines) {
	while (lines.length && lines[lines.length - 1] === "") lines.pop();
	writeFileSync(path, lines.join("\n") + "\n", { mode: 0o600 });
}

const api = readLines(apiVars);
const dp = readLines(dpVars);
const havePriv = !!getVar(api, "ULS_JWT_PRIVATE_JWK");
const haveJwks = !!getVar(api, "ULS_JWT_PUBLIC_JWKS");

if (havePriv && haveJwks && !rotate) {
	// Idempotent: just make sure the data plane has the same public set.
	const jwks = getVar(api, "ULS_JWT_PUBLIC_JWKS");
	if (getVar(dp, "ULS_JWT_PUBLIC_JWKS") !== jwks) {
		setVar(dp, "ULS_JWT_PUBLIC_JWKS", jwks);
		write(dpVars, dp);
		console.log("keys kept; synced ULS_JWT_PUBLIC_JWKS to data-plane/.dev.vars");
	} else console.log("keys already present; nothing to do (use --rotate to replace)");
	process.exit(0);
}

const kid = randomBytes(8).toString("hex");
const { privateKey } = generateKeyPairSync("ed25519");
const priv = { ...privateKey.export({ format: "jwk" }), kid, alg: "EdDSA", use: "sig" };
const { d: _d, ...pub } = priv;

let keys = [pub];
if (rotate) {
	try {
		const old = JSON.parse(getVar(api, "ULS_JWT_PUBLIC_JWKS") ?? "{}");
		if (Array.isArray(old.keys)) keys = [pub, ...old.keys.slice(0, 3)];
	} catch {}
}
const jwks = JSON.stringify({ keys });

setVar(api, "ULS_JWT_PRIVATE_JWK", JSON.stringify(priv));
setVar(api, "ULS_JWT_PUBLIC_JWKS", jwks);
setVar(dp, "ULS_JWT_PUBLIC_JWKS", jwks);
write(apiVars, api);
write(dpVars, dp);
console.log(`${rotate ? "rotated to" : "generated"} Ed25519 key kid=${kid}; wrote cloud/api/.dev.vars and cloud/data-plane/.dev.vars`);
