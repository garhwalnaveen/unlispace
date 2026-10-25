import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: "./wrangler.jsonc" },
			// Fixed test token so the suite doesn't depend on a local .dev.vars file.
			// ULS_JWT_PUBLIC_JWKS is set per test file (tests generate their own Ed25519 keypair).
			miniflare: { bindings: { ULS_DEV_TOKEN: "uls-dev-local-token", ULS_BLOCK_KEY: "test-only-block-signing-key", ULS_JWT_PUBLIC_JWKS: '{"keys":[]}' } },
		}),
	],
	test: {
		include: ["test/**/*.test.ts"],
		// workerd reports an RPC method's deliberate `throw` (DataPlaneAdmin typed errors, which the tests assert on
		// via `rejects`) as an uncaught exception as well. Ignore exactly those; every other unhandled error still fails the run.
		onUnhandledError(error) {
			const e = error as { name?: string; message?: string; remote?: boolean };
			if (e.remote && /^(no_such_drive|fork_depth_exceeded|slow_down|invalid snapshot row)$/.test(e.message ?? "")) return false;
			if (e.remote && /^(DriveExistsError|TypeError)$/.test(e.name ?? "") && /drive_exists|invalid driveId|invalid placement/.test(e.message ?? "")) return false;
		},
	},
});
