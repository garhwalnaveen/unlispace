import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// The real data plane is never started here. wrangler.jsonc binds DATA_PLANE to a service
// named unlispace-data-plane, so an inert auxiliary worker satisfies the binding. Behavioural tests inject
// test/fake-data-plane.ts through Deps instead (see test/helpers.ts).
const stubDataPlane = `
import { WorkerEntrypoint } from "cloudflare:workers";
export default { fetch: () => Response.json({ error: "stub" }, { status: 503 }) };
export class ControlPlane extends WorkerEntrypoint { resolveKey() { return null; } }
`;

export default defineConfig({
	plugins: [
		{
			// The SDK's *browser* aws-chunked encoder (selected under workerd) writes `${chunk}` for byte chunks, which
			// stringifies a Uint8Array as "165,5,...", and its trailing checksum is computed over an already-consumed stream.
			// Test-only replacement with a byte-correct encoder; the wire format (hex length, CRLF, trailer) is unchanged.
			name: "aws-sdk-chunked-encoder-bytes",
			enforce: "pre",
			transform(_code, id) {
				if (!/getAwsChunkedEncodingStream\.browser\.js$/.test(id)) return;
				return `
export const getAwsChunkedEncodingStream = (readableStream, options) => {
  const { base64Encoder, bodyLengthChecker, checksumAlgorithmFn, checksumLocationName } = options;
  const enc = new TextEncoder();
  const reader = readableStream.getReader();
  const hasher = checksumAlgorithmFn ? new checksumAlgorithmFn() : undefined;
  return new ReadableStream({
    async pull(controller) {
      const { value, done } = await reader.read();
      if (done) {
        controller.enqueue(enc.encode("0\\r\\n"));
        if (hasher) {
          controller.enqueue(enc.encode(checksumLocationName + ":" + base64Encoder(await hasher.digest()) + "\\r\\n"));
          controller.enqueue(enc.encode("\\r\\n"));
        }
        controller.close();
        return;
      }
      hasher?.update(value);
      const head = enc.encode((bodyLengthChecker(value) || 0).toString(16) + "\\r\\n");
      const out = new Uint8Array(head.length + value.length + 2);
      out.set(head); out.set(value, head.length); out.set([13, 10], head.length + value.length);
      controller.enqueue(out);
    },
  });
};`;
			},
		},
		{
			// workerd matches the "browser" export condition, which selects the AWS SDK's DOMParser-based XML reader
			// (workerd has no DOMParser). Swap in the SDK's own fast-xml-parser implementation.
			name: "aws-sdk-xml-parser-node",
			enforce: "pre",
			transform(_code, id) {
				if (/@aws-sdk\/xml-builder\/dist-es\/xml-parser\.browser\.js/.test(id)) return 'export { parseXML } from "./xml-parser.js";';
			},
		},
		cloudflareTest({
			wrangler: { configPath: "./wrangler.jsonc" },
			miniflare: {
				workers: [{name: "unlispace-api", modules:true, compatibilityDate:"2026-10-01", script:stubDataPlane}, { name: "unlispace-data-plane", modules: true, compatibilityDate: "2026-10-01", script: stubDataPlane }],
				bindings: {
					ULS_JWT_PRIVATE_JWK: "{}",
				},
			},
		}),
	],
	test: { include: ["test/**/*.test.ts"], testTimeout: 60_000, hookTimeout: 60_000 },
});
