import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

// The deployed entry point, with the wrangler bindings (service bindings are the inert stub from vitest.config.ts).
describe("worker entry point", () => {
	it("serves /healthz without credentials", async () => {
		const res = await SELF.fetch("https://s3.test/healthz");
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });
	});

	it("answers unauthenticated requests with an S3 XML AccessDenied", async () => {
		const res = await SELF.fetch("https://s3.test/some-bucket/key");
		expect(res.status).toBe(403);
		expect(res.headers.get("content-type")).toContain("xml");
		expect(await res.text()).toContain("<Code>AccessDenied</Code>");
	});

	it("rejects an unknown access key even with a well-formed header (no default credentials)", async () => {
		const res = await SELF.fetch("https://s3.test/", {
			headers: {
				authorization: `AWS4-HMAC-SHA256 Credential=ULS1AAAAAAAAAAAAAAAAA/20261025/auto/s3/aws4_request, SignedHeaders=host;x-amz-date, Signature=${"0".repeat(64)}`,
				"x-amz-date": new Date().toISOString().replace(/[-:]|\.\d{3}/g, ""),
			},
		});
		expect(res.status).toBe(403);
		expect(await res.text()).toMatch(/InvalidAccessKeyId|RequestTimeTooSkewed/);
	});
});
