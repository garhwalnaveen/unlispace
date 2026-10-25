import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
	const migrations = await readD1Migrations("./migrations");
	return {
		plugins: [
			cloudflareTest({
				wrangler: { configPath: "./wrangler.jsonc" },
				miniflare: {
					// Tests inject a fake DATA_PLANE through `env`, so the real service binding is never called.
					bindings: { TEST_MIGRATIONS: migrations },
					// Stand-in for the real data plane so the service binding resolves without it.
					workers: [
						{
							name: "unlispace-data-plane",
							modules: true,
							script: `import { WorkerEntrypoint } from "cloudflare:workers";
export class DataPlaneAdmin extends WorkerEntrypoint {
  async createDrive(driveId) { return { driveId, placement: null, createdAt: Date.now() }; }
  async deleteDrive() { return { ok: true }; }
  async driveStats() { return null; }
}
export default { fetch() { return new Response("stub", { status: 404 }); } };`,
						},
					],
				},
			}),
		],
		test: { include: ["test/**/*.test.ts"], setupFiles: ["./test/setup.ts"] },
	};
});
