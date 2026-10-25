import { MAX_STREAM_COMMIT_BYTES } from "./manifests";
import { fail, type Fail, type NormOp } from "./types";
import { MAX_OPS, parseOps } from "./validate";

/** NDJSON has one operation per line. Decode incrementally; cap bytes even without Content-Length. */
export async function readStreamCommit(request: Request): Promise<NormOp[] | Fail> {
	if (Number(request.headers.get("Content-Length")) > MAX_STREAM_COMMIT_BYTES) return fail(413, "too_large");
	if (!request.body) return fail(400, "bad_request");
	const reader = request.body.getReader();
	const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
	const ops: NormOp[] = [];
	let pending = "";
	let total = 0;
	let completed = false;
	const line = (text: string): Fail | undefined => {
		if (!text.trim()) return;
		if (ops.length === MAX_OPS) return fail(400, "bad_request", { message: `ops must have 1..${MAX_OPS} entries` });
		const parsed = parseOps({ ops: [JSON.parse(text)] });
		if (!Array.isArray(parsed)) return parsed;
		ops.push(...parsed);
	};
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > MAX_STREAM_COMMIT_BYTES) return fail(413, "too_large");
			pending += decoder.decode(value, { stream: true });
			let start = 0;
			let end: number;
			while ((end = pending.indexOf("\n", start)) >= 0) {
				const error = line(pending.slice(start, end));
				if (error) return error;
				start = end + 1;
			}
			pending = pending.slice(start);
		}
		pending += decoder.decode();
		const error = line(pending);
		if (error) return error;
		completed = true;
		return ops.length ? ops : fail(400, "bad_request", { message: "empty commit" });
	} catch {
		return fail(400, "bad_request", { message: "invalid NDJSON" });
	} finally {
		if (!completed) await reader.cancel().catch(() => undefined);
		reader.releaseLock();
	}
}
