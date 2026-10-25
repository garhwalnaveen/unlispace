import { createHash } from "node:crypto";
import type { Auth } from "./auth";
import { checksumNames, Checksum, type ChecksumName, checkChecksum } from "./checksum";
import { digest, utf8, verifyHmac } from "./crypto";
import { integer, S3Error } from "./errors";

export const PUT_LIMIT = 95_000_000;
export const EDIT_LIMIT = 64 * 1024 * 1024;
const decoder = new TextDecoder();

class BodyReader {
  private pending: Uint8Array = new Uint8Array();
  private offset = 0;
  private done = false;
  private wire = 0;
  private readonly reader;
  constructor(stream: ReadableStream<Uint8Array> | null, private readonly wireLimit: number) { this.reader = stream?.getReader(); }
  private async fill(): Promise<boolean> {
    if (this.offset < this.pending.length) return true;
    if (this.done || !this.reader) return false;
    for (;;) {
      const next = await this.reader.read();
      if (next.done) { this.done = true; return false; }
      this.wire += next.value.length;
      if (this.wire > this.wireLimit) throw new S3Error(413, "EntityTooLarge");
      if (next.value.length) { this.pending = next.value; this.offset = 0; return true; }
    }
  }
  async *pieces(n: number): AsyncGenerator<Uint8Array> {
    while (n > 0) {
      if (!await this.fill()) throw new S3Error(400, "IncompleteBody");
      const take = Math.min(n, this.pending.length - this.offset);
      const bytes = this.pending.subarray(this.offset, this.offset + take);
      this.offset += take; n -= take;
      yield bytes;
    }
  }
  async line(): Promise<string> {
    const bytes: number[] = [];
    while (await this.fill()) {
      const b = this.pending[this.offset++]!;
      bytes.push(b);
      if (bytes.length > 8192) throw new S3Error(400, "InvalidRequest", "Chunk header or trailer too long");
      if (b === 10) {
        if (bytes.at(-2) !== 13) throw new S3Error(400, "InvalidRequest", "Chunk framing requires CRLF");
        return decoder.decode(Uint8Array.from(bytes.slice(0, -2)));
      }
    }
    throw new S3Error(400, "IncompleteBody");
  }
  async *rest(): AsyncGenerator<Uint8Array> {
    while (await this.fill()) {
      const bytes = this.pending.subarray(this.offset);
      this.offset = this.pending.length;
      yield bytes;
    }
  }
  async end(): Promise<void> {
    if (await this.fill()) throw new S3Error(400, "InvalidRequest", "Trailing payload data");
  }
  async close(): Promise<void> {
    if (!this.done) await this.reader?.cancel();
    this.reader?.releaseLock();
  }
}

/** Verification finishes before the caller can commit a manifest. Uploaded shards remain unreferenced on failure. */
export async function* verifiedBody(request: Request, auth: Auth, limit: number): AsyncGenerator<Uint8Array> {
  const streaming = auth.payloadHash.startsWith("STREAMING-");
  const signed = auth.payloadHash.startsWith("STREAMING-AWS4-");
  const trailers = auth.payloadHash.endsWith("-TRAILER");
  const encoding = request.headers.get("content-encoding")?.split(",").map(s => s.trim().toLowerCase()) ?? [];
  if (streaming !== encoding.includes("aws-chunked")) throw new S3Error(400, "InvalidRequest", "Payload mode and content encoding disagree");
  const lengthHeader = request.headers.get(streaming ? "x-amz-decoded-content-length" : "content-length");
  const expectedLength = lengthHeader === null ? null : integer(lengthHeader);
  if (streaming && expectedLength === null) throw new S3Error(400, "InvalidRequest", "Decoded content length is required");
  if (expectedLength !== null && expectedLength > limit) throw new S3Error(413, "EntityTooLarge");
  const announced = (request.headers.get("x-amz-trailer") ?? "").split(",").map(v => v.trim().toLowerCase()).filter(Boolean);
  if (trailers && (announced.length === 0 || new Set(announced).size !== announced.length || announced.some(v => !checksumNames.some(n => v === `x-amz-checksum-${n}`)))) throw new S3Error(400, "InvalidRequest", "Unsupported checksum trailer");
  if (!trailers && announced.length) throw new S3Error(400, "InvalidRequest");
  const checks = new Map<string, Checksum>();
  for (const name of checksumNames) {
    const header = `x-amz-checksum-${name}`;
    if (request.headers.has(header) || announced.includes(header)) checks.set(header, new Checksum(name));
  }
  if (request.headers.has("content-md5")) checks.set("content-md5", new Checksum("md5"));
  const sha = createHash("sha256");
  const reader = new BodyReader(request.body, streaming ? limit * 16 + 1024 * 1024 : limit);
  let total = 0, previous = auth.signature;
  const seenTrailers = new Map<string, string>();
  const account = (bytes: Uint8Array): void => {
    total += bytes.length;
    if (total > limit) throw new S3Error(413, "EntityTooLarge");
    sha.update(bytes);
    for (const checksum of checks.values()) checksum.update(bytes);
  };
  try {
    if (streaming) {
      let frames = 0;
      for (;;) {
        if (++frames > 1_000_000) throw new S3Error(413, "EntityTooLarge", "Too many chunks");
        const line = await reader.line();
        const match = signed ? /^([a-fA-F0-9]+);chunk-signature=([a-f0-9]{64})$/.exec(line) : /^([a-fA-F0-9]+)$/.exec(line);
        if (!match) throw new S3Error(400, "InvalidRequest", "Invalid aws-chunked framing");
        const n = Number.parseInt(match[1]!, 16);
        if (!Number.isSafeInteger(n) || n > limit - total) throw new S3Error(413, "EntityTooLarge");
        const chunkHash = createHash("sha256");
        for await (const bytes of reader.pieces(n)) { chunkHash.update(bytes); account(bytes); yield bytes; }
        if (signed) {
          const toSign = ["AWS4-HMAC-SHA256-PAYLOAD", auth.timestamp, auth.credentialScope, previous, await digest(new Uint8Array()), chunkHash.digest("hex")].join("\n");
          if (!await verifyHmac(auth.signingKey, toSign, match[2]!)) throw new S3Error(403, "SignatureDoesNotMatch");
          previous = match[2]!;
        }
        // A zero-size trailer chunk is followed directly by trailer headers, not a data CRLF.
        if (n === 0) {
          if (trailers) {
            for (;;) {
              const trailer = await reader.line();
              if (trailer === "") break;
              const m = /^([a-zA-Z0-9-]+):\s*(\S+)\s*$/.exec(trailer);
              if (!m) throw new S3Error(400, "InvalidRequest", "Invalid trailer");
              const name = m[1]!.toLowerCase();
              if (seenTrailers.has(name) || (!announced.includes(name) && !(signed && name === "x-amz-trailer-signature"))) throw new S3Error(400, "InvalidRequest", "Unexpected trailer");
              seenTrailers.set(name, m[2]!);
            }
            for (const name of announced) if (!seenTrailers.has(name)) throw new S3Error(400, "BadDigest", "Missing checksum trailer");
            if (signed) {
              const canonical = [...seenTrailers].filter(([k]) => k !== "x-amz-trailer-signature").sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${k}:${v}\n`).join("");
              const toSign = ["AWS4-HMAC-SHA256-TRAILER", auth.timestamp, auth.credentialScope, previous, await digest(utf8.encode(canonical))].join("\n");
              if (!await verifyHmac(auth.signingKey, toSign, seenTrailers.get("x-amz-trailer-signature") ?? "")) throw new S3Error(403, "SignatureDoesNotMatch");
            }
          } else if (await reader.line() !== "") throw new S3Error(400, "InvalidRequest");
          await reader.end();
          break;
        }
        if (await reader.line() !== "") throw new S3Error(400, "InvalidRequest");
      }
    } else {
      for await (const bytes of reader.rest()) { account(bytes); yield bytes; }
    }
    if (expectedLength !== null && total !== expectedLength) throw new S3Error(400, "IncompleteBody");
    const hash = sha.digest("hex");
    if (/^[a-f0-9]{64}$/.test(auth.payloadHash) && hash !== auth.payloadHash) throw new S3Error(400, "XAmzContentSHA256Mismatch");
    for (const [name, checksum] of checks) {
      const actual = checksum.finish();
      const header = request.headers.get(name), trailer = seenTrailers.get(name);
      if (header !== null) checkChecksum(actual, header);
      if (trailer !== undefined) checkChecksum(actual, trailer);
    }
  } finally { await reader.close(); }
}

export async function collectBody(source: AsyncIterable<Uint8Array>, limit: number): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let size = 0;
  for await (const bytes of source) {
    size += bytes.length;
    if (size > limit) throw new S3Error(413, "EntityTooLarge");
    parts.push(bytes);
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const p of parts) { out.set(p, offset); offset += p.length; }
  return out;
}
