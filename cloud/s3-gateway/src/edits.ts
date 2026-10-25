import { chunkManifest, MAX_SIZE, type Shard } from "./chunker";
import type { DataPlane, Manifest } from "./data-plane";
import { S3Error } from "./errors";

export interface Edit { offset: number; bytes: Uint8Array }
type Segment = { kind: "base"; start: number; length: number } | { kind: "bytes"; bytes: Uint8Array; length: number } | { kind: "zero"; length: number };
const safe = (n: bigint): number => {
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new S3Error(400, "InvalidPatch", "Offset or length exceeds supported integer range");
  return Number(n);
};
export function parsePatch(body: Uint8Array): Edit[] {
  if (body.length < 12 || body[0] !== 83 || body[1] !== 51 || body[2] !== 83 || body[3] !== 80 || body[4] !== 1 || body[5] !== 0 || body[6] !== 0 || body[7] !== 0) throw new S3Error(400, "InvalidPatch");
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  const count = view.getUint32(8);
  if (count < 1 || count > 10000) throw new S3Error(400, "InvalidPatch");
  let offset = 12;
  const edits: Edit[] = [];
  for (let i = 0; i < count; i++) {
    if (offset + 16 > body.length) throw new S3Error(400, "InvalidPatch");
    const position = safe(view.getBigUint64(offset)), length = safe(view.getBigUint64(offset + 8));
    offset += 16;
    if (!Number.isSafeInteger(position + length) || length > body.length - offset) throw new S3Error(400, "InvalidPatch");
    edits.push({ offset: position, bytes: body.subarray(offset, offset + length) });
    offset += length;
  }
  if (offset !== body.length) throw new S3Error(400, "InvalidPatch");
  return edits;
}
function length(segments: Segment[]): number { return segments.reduce((n, s) => n + s.length, 0); }
function slice(segments: Segment[], start: number, end: number): Segment[] {
  const result: Segment[] = [];
  let position = 0;
  for (const segment of segments) {
    const a = Math.max(0, start - position), b = Math.min(segment.length, end - position);
    position += segment.length;
    if (a >= b) continue;
    if (segment.kind === "base") result.push({ kind: "base", start: segment.start + a, length: b - a });
    else if (segment.kind === "bytes") result.push({ kind: "bytes", bytes: segment.bytes.subarray(a, b), length: b - a });
    else result.push({ kind: "zero", length: b - a });
  }
  return result;
}
export function planEdits(baseSize: number, edits: Edit[], finalSize?: number, spliceRemove?: number): Segment[] {
  let segments: Segment[] = baseSize ? [{ kind: "base", start: 0, length: baseSize }] : [];
  for (const edit of edits) {
    const size = length(segments);
    if (!Number.isSafeInteger(edit.offset + edit.bytes.length)) throw new S3Error(400, "InvalidArgument");
    if (spliceRemove !== undefined && (edit.offset + spliceRemove > size || (spliceRemove === 0 && edit.bytes.length === 0))) throw new S3Error(400, "InvalidArgument", "Splice exceeds the object or makes no change");
    if (edit.offset > size) segments.push({ kind: "zero", length: edit.offset - size });
    const end = spliceRemove === undefined ? edit.offset + edit.bytes.length : edit.offset + spliceRemove;
    segments = [...slice(segments, 0, edit.offset), ...(edit.bytes.length ? [{ kind: "bytes" as const, bytes: edit.bytes, length: edit.bytes.length }] : []), ...slice(segments, end, length(segments))];
  }
  if (finalSize !== undefined) {
    const current = length(segments);
    segments = finalSize < current ? slice(segments, 0, finalSize) : [...segments, ...(finalSize > current ? [{ kind: "zero" as const, length: finalSize - current }] : [])];
  }
  // Coalesce adjacent slices, so a zero-length patch cannot fragment a base shard.
  const merged: Segment[] = [];
  for (const s of segments) {
    const previous = merged.at(-1);
    if (previous?.kind === "base" && s.kind === "base" && previous.start + previous.length === s.start) previous.length += s.length;
    else if (previous?.kind === "zero" && s.kind === "zero") previous.length += s.length;
    else if (s.length) merged.push(s);
  }
  return merged;
}

/** Untouched complete shards stay by reference; only partial shards and inserted bytes are fetched/chunked. */
export async function editManifest(dp: DataPlane, base: Manifest, edits: Edit[], finalSize?: number, spliceRemove?: number): Promise<{ shards: Shard[]; size: number }> {
  const segments = planEdits(base.size, edits, finalSize, spliceRemove);
  const shards: Shard[] = [];
  const pending: AsyncIterable<Uint8Array>[] = [];
  const flush = async (): Promise<void> => {
    async function* input(): AsyncGenerator<Uint8Array> { for (const stream of pending) yield* stream; }
    shards.push(...await chunkManifest(input(), (s, bytes) => dp.putShard(s, bytes)));
    pending.length = 0;
  };
  for (const segment of segments) {
    if (segment.kind === "bytes") {
      pending.push((async function* () { yield segment.bytes; })());
    } else if (segment.kind === "zero") {
      pending.push((async function* () {
        const zeros = new Uint8Array(Math.min(MAX_SIZE, segment.length));
        for (let left = segment.length; left > 0; left -= Math.min(left, zeros.length)) yield zeros.subarray(0, Math.min(left, zeros.length));
      })());
    } else {
      let offset = 0;
      for (const shard of base.shards) {
        const a = Math.max(segment.start, offset), b = Math.min(segment.start + segment.length, offset + shard.n);
        if (a < b) {
          if (a === offset && b === offset + shard.n) { await flush(); shards.push(shard); }
          else pending.push(dp.bytes(base, a, b));
        }
        offset += shard.n;
      }
    }
  }
  await flush();
  return { shards, size: length(segments) };
}
