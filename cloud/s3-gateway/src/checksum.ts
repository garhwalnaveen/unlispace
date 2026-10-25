import { createHash } from "node:crypto";
import { base64 } from "./crypto";
import { S3Error } from "./errors";

const crcTable = (poly: number): Uint32Array => Uint32Array.from({ length: 256 }, (_, i) => {
  let c = i;
  for (let j = 0; j < 8; j++) c = (c >>> 1) ^ ((c & 1) ? poly : 0);
  return c >>> 0;
});
const crc32 = crcTable(0xedb88320), crc32c = crcTable(0x82f63b78);
const nvme = Array.from({ length: 256 }, (_, i) => {
  let c = BigInt(i);
  for (let j = 0; j < 8; j++) c = (c >> 1n) ^ ((c & 1n) ? 0x9a6c9329ac4bc9b5n : 0n);
  return [Number(c >> 32n) >>> 0, Number(c & 0xffffffffn) >>> 0] as const;
});
export const checksumNames = ["crc32", "crc32c", "crc64nvme", "sha1", "sha256"] as const;
export type ChecksumName = typeof checksumNames[number];

export class Checksum {
  private crc = 0xffffffff;
  private hi = 0xffffffff;
  private lo = 0xffffffff;
  private readonly hash;
  constructor(private readonly name: ChecksumName | "md5") {
    this.hash = ["sha1", "sha256", "md5"].includes(name) ? createHash(name) : null;
  }
  update(bytes: Uint8Array): void {
    if (this.hash) { this.hash.update(bytes); return; }
    if (this.name === "crc64nvme") {
      let hi = this.hi, lo = this.lo;
      for (const byte of bytes) {
        const [th, tl] = nvme[(lo ^ byte) & 255]!;
        lo = ((lo >>> 8) | (hi << 24)) ^ tl;
        hi = (hi >>> 8) ^ th;
      }
      this.hi = hi; this.lo = lo;
    } else {
      const table = this.name === "crc32c" ? crc32c : crc32;
      let crc = this.crc;
      for (const byte of bytes) crc = (crc >>> 8) ^ table[(crc ^ byte) & 255]!;
      this.crc = crc;
    }
  }
  finish(): string {
    if (this.hash) return this.hash.digest("base64");
    const out = new Uint8Array(this.name === "crc64nvme" ? 8 : 4);
    const view = new DataView(out.buffer);
    if (out.length === 8) { view.setUint32(0, ~this.hi); view.setUint32(4, ~this.lo); }
    else view.setUint32(0, ~this.crc);
    return base64(out);
  }
}

export function checkChecksum(actual: string, expected: string): void {
  if (actual !== expected) throw new S3Error(400, "BadDigest", "Payload checksum does not match");
}
