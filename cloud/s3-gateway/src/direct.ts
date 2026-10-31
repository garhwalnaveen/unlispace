import { createHash } from "node:crypto";
import { collectBody, verifiedBody } from "./body";
import { digest, hex, hmac, utf8, verifyHmac } from "./crypto";
import { S3Error } from "./errors";
import { commitManifest, mutationHeaders, optionalHead, preconditions, type ObjectContext } from "./objects";

const TTL_MS = 300_000;
const MAX_SHARDS = 4096;
const MAX_SHARD = 16 * 1024 * 1024;
interface Fragment {hash: string; length: number}
const invalid = (): never => { throw new S3Error(400, "InvalidArgument", "Invalid direct-upload plan or manifest"); };

async function body(c: ObjectContext): Promise<Record<string, unknown>> {
  const bytes = await collectBody(verifiedBody(c.request, c.auth, 1024 * 1024), 1024 * 1024);
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
    return value as Record<string, unknown>;
  } catch { return invalid(); }
}

function fragments(value: unknown): Fragment[] {
  if (!Array.isArray(value) || value.length > MAX_SHARDS) return invalid();
  const lengths = new Map<string, number>();
  return value.map((v: unknown) => {
    if (!v || typeof v !== "object") return invalid();
    const s = v as Record<string, unknown>;
    if (typeof s.hash !== "string" || !/^[a-f0-9]{64}$/.test(s.hash) || !Number.isSafeInteger(s.length) || (s.length as number) < 1 || (s.length as number) > MAX_SHARD || (lengths.has(s.hash) && lengths.get(s.hash) !== s.length)) return invalid();
    lengths.set(s.hash, s.length as number);
    return {hash: s.hash, length: s.length as number};
  });
}

function scope(c: ObjectContext, expires: string, nonce: string, planHash: string): string {
  return JSON.stringify([c.auth.key.keyId, c.dp.drive, c.key, expires, nonce, planHash]);
}

/** The small token binds the complete ordered plan without retaining abandoned plans in storage. */
export async function directPlan(c: ObjectContext, publicDataEndpoint: string | undefined): Promise<Response> {
  if (!publicDataEndpoint) throw new S3Error(501, "NotImplemented", "The public data endpoint is not configured");
  if (c.key.endsWith("/")) return invalid();
  const input = await body(c), shards = fragments(input.shards);
  const planHash = await digest(utf8.encode(JSON.stringify(shards)));
  const expires = String(c.now() + TTL_MS), nonce = crypto.randomUUID();
  const token = `${expires}.${nonce}.${planHash}.${hex(await hmac(c.auth.key.secretAccessKey, scope(c, expires, nonce, planHash)))}`;
  const unique = [...new Map(shards.map(s => [s.hash, s])).values()];
  const missing = new Set(await c.dp.missing(unique.map(s => s.hash)));
  const upload = await Promise.all(unique.filter(s => missing.has(s.hash)).map(async s => ({...s, url: await c.dp.directUploadUrl(publicDataEndpoint, {h: s.hash, n: s.length})})));
  return Response.json({token, upload, held: unique.length - upload.length, expiresSeconds: TTL_MS / 1000}, {headers: {"cache-control": "no-store"}});
}

export async function directCommit(c: ObjectContext): Promise<Response> {
  if (c.key.endsWith("/")) return invalid();
  const input = await body(c), shards = fragments(input.shards);
  if (typeof input.token !== "string" || !Number.isSafeInteger(input.size) || (input.size as number) < 0 || typeof input.contentHash !== "string" || !/^[a-f0-9]{64}$/.test(input.contentHash)) return invalid();
  const [expires, nonce, planHash, signature, extra] = input.token.split(".");
  if (extra !== undefined || !expires || !/^\d+$/.test(expires) || !nonce || !/^[a-f0-9-]{36}$/.test(nonce) || !planHash || !/^[a-f0-9]{64}$/.test(planHash) || !signature || +expires <= c.now() || +expires > c.now() + TTL_MS || !await verifyHmac(utf8.encode(c.auth.key.secretAccessKey), scope(c, expires, nonce, planHash), signature) || await digest(utf8.encode(JSON.stringify(shards))) !== planHash) return invalid();
  if (shards.reduce((n, s) => n + s.length, 0) !== input.size) return invalid();
  const current = await optionalHead(c.dp, c.key);
  const conditions = await preconditions(c.request, current);
  if ((await c.dp.missing([...new Set(shards.map(s => s.hash))])).length) return invalid();
  const whole = createHash("sha256");
  for (const s of shards) {
    const response = await c.dp.readShard(s.hash), reader = response.body?.getReader();
    if (!reader) return invalid();
    const hash = createHash("sha256");
    let size = 0;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.length;
        if (size > s.length) return invalid();
        hash.update(next.value); whole.update(next.value);
      }
    } finally { await reader.cancel(); reader.releaseLock(); }
    if (size !== s.length || hash.digest("hex") !== s.hash) return invalid();
  }
  if (whole.digest("hex") !== input.contentHash) return invalid();
  const manifest = await commitManifest(c, {path: c.key, size: input.size as number, shards: shards.map(s => ({h: s.hash, n: s.length})), contentType: c.request.headers.get("x-uls-content-type") ?? "application/octet-stream", mtimeMs: c.now()}, conditions);
  return new Response(null, {headers: await mutationHeaders(manifest)});
}
