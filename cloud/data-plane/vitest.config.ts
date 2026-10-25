import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: "./wrangler.jsonc" },
			// Fixed test token so the suite doesn't depend on a local .dev.vars file.
			miniflare: { bindings: { ULS_DEV_TOKEN: "uls-dev-local-token" } },
		}),
	],
	test: { include: ["test/**/*.test.ts"] },
});
