import { base64, digest, hmac, utf8, verifyHmac } from "./crypto";
import { S3Error } from "./errors";

export type Access = "read" | "write" | "admin";
export interface KeyRecord {
  keyId: string;
  subject: string;
  orgId: string;
  scope: Access;
  drives?: string[];
}
export interface ResolvedKey extends KeyRecord { secretAccessKey: string }
export interface KeyResolver {
  resolve(keyId: string): Promise<ResolvedKey | null>;
  recordUse?(keyId: string): Promise<void>;
}

/** Test-only deterministic records. Production uses ControlPlaneKeyResolver. */
export class MemoryKeyResolver implements KeyResolver {
  /** `masters` maps the key-version character (4th id char) to a base64 master; a bare string is used for every version. */
  constructor(private readonly masters: Record<string, string> | string, private readonly records: readonly KeyRecord[]) {}
  async resolve(id: string): Promise<ResolvedKey | null> {
    if (!this.masters) return null;
    const record = this.records.find(k => k.keyId === id);
    if (!record || !/^ULS[A-Z0-9]{17}$/.test(id)) return null;
    const encoded = typeof this.masters === "string" ? this.masters : this.masters[id[3]!];
    if (!encoded) return null;
    let master: Uint8Array;
    try { master = Uint8Array.from(atob(encoded), c => c.charCodeAt(0)); }
    catch { throw new S3Error(503, "ServiceUnavailable", "Invalid access-key master configuration"); }
    if (master.length < 32) throw new S3Error(503, "ServiceUnavailable", "Access-key master must contain at least 32 bytes");
    return { ...record, secretAccessKey: base64(await hmac(master, id)).slice(0, 40) };
  }
}

export async function secretFor(master: Uint8Array, keyId: string): Promise<string> { return base64(await hmac(master, keyId)).slice(0, 40); }

export interface Auth {
  key: ResolvedKey;
  payloadHash: string;
  signingKey: Uint8Array;
  signature: string;
  timestamp: string;
  credentialScope: string;
}
const encode = (s: string): string => encodeURIComponent(s).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
export function canonicalQuery(url: URL, presigned: boolean): string {
  return [...url.searchParams].filter(([k]) => !(presigned && k === "X-Amz-Signature"))
    .map(([k, v]) => [encode(k), encode(v)] as const)
    .sort((a, b) => compare(a[0], b[0]) || compare(a[1], b[1]))
    .map(([k, v]) => `${k}=${v}`).join("&");
}

export async function authenticate(request: Request, resolver: KeyResolver, now = Date.now()): Promise<Auth> {
  const url = new URL(request.url);
  const presigned = url.searchParams.has("X-Amz-Algorithm");
  let credential: string, signed: string, signature: string, timestamp: string;
  if (presigned) {
    if (request.headers.has("authorization")) throw new S3Error(400, "InvalidRequest", "Multiple authentication mechanisms");
    for (const name of ["X-Amz-Algorithm", "X-Amz-Credential", "X-Amz-SignedHeaders", "X-Amz-Signature", "X-Amz-Date", "X-Amz-Expires"]) {
      if (url.searchParams.getAll(name).length !== 1) throw new S3Error(400, "AuthorizationQueryParametersError");
    }
    if (url.searchParams.get("X-Amz-Algorithm") !== "AWS4-HMAC-SHA256") throw new S3Error(400, "AuthorizationQueryParametersError");
    credential = url.searchParams.get("X-Amz-Credential")!;
    signed = url.searchParams.get("X-Amz-SignedHeaders")!;
    signature = url.searchParams.get("X-Amz-Signature")!;
    timestamp = url.searchParams.get("X-Amz-Date")!;
  } else {
    const auth = request.headers.get("authorization") ?? "";
    const match = /^AWS4-HMAC-SHA256 Credential=([^, ]+),\s*SignedHeaders=([^, ]+),\s*Signature=([a-f0-9]{64})$/.exec(auth);
    if (!match) throw new S3Error(403, "AccessDenied", "Valid SigV4 authentication required");
    credential = match[1]!; signed = match[2]!; signature = match[3]!;
    timestamp = request.headers.get("x-amz-date") ?? "";
  }
  const fields = credential.split("/");
  const [keyId, date, region, service, end] = fields;
  if (fields.length !== 5 || !region || service !== "s3" || end !== "aws4_request" || !/^\d{8}T\d{6}Z$/.test(timestamp) || date !== timestamp.slice(0, 8)) {
    throw new S3Error(400, "AuthorizationHeaderMalformed");
  }
  const epoch = Date.parse(timestamp.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, "$1-$2-$3T$4:$5:$6Z"));
  if (!Number.isFinite(epoch) || epoch > now + 900_000) throw new S3Error(403, "RequestTimeTooSkewed");
  if (presigned) {
    const expires = url.searchParams.get("X-Amz-Expires")!;
    if (!/^[0-9]+$/.test(expires) || +expires < 1 || +expires > 604800) throw new S3Error(400, "AuthorizationQueryParametersError");
    if (now > epoch + +expires * 1000) throw new S3Error(403, "AccessDenied", "Request has expired");
  } else if (Math.abs(now - epoch) > 900_000) throw new S3Error(403, "RequestTimeTooSkewed");

  const names = signed.split(";");
  if (!names.includes("host") || names.some((n, i) => !/^[a-z0-9-]+$/.test(n) || (i > 0 && compare(names[i - 1]!, n) >= 0))) throw new S3Error(400, "AuthorizationHeaderMalformed");
  if (!presigned && !names.includes("x-amz-date")) throw new S3Error(403, "SignatureDoesNotMatch");
  for (const [name] of request.headers) {
    if (name.startsWith("x-uls-") && !names.includes(name)) throw new S3Error(403, "SignatureDoesNotMatch", "Extension headers must be signed");
  }
  const headers = names.map(name => {
    const value = name === "host" ? (request.headers.get("host") ?? url.host) : request.headers.get(name);
    if (value === null) throw new S3Error(403, "SignatureDoesNotMatch");
    return `${name}:${value.trim().replace(/\s+/g, " ")}\n`;
  }).join("");
  const payloadHash = request.headers.get("x-amz-content-sha256") ?? url.searchParams.get("X-Amz-Content-Sha256") ?? (presigned ? "UNSIGNED-PAYLOAD" : await digest(new Uint8Array()));
  if (!/^[a-f0-9]{64}$/.test(payloadHash) && !["UNSIGNED-PAYLOAD", "STREAMING-UNSIGNED-PAYLOAD-TRAILER", "STREAMING-AWS4-HMAC-SHA256-PAYLOAD", "STREAMING-AWS4-HMAC-SHA256-PAYLOAD-TRAILER"].includes(payloadHash)) throw new S3Error(400, "InvalidArgument", "Unsupported payload hash");
  let path: string;
  try { path = url.pathname.split("/").map(p => encode(decodeURIComponent(p))).join("/"); }
  catch { throw new S3Error(400, "InvalidURI"); }
  const canonical = [request.method, path, canonicalQuery(url, presigned), headers, signed, payloadHash].join("\n");
  const key = await resolver.resolve(keyId!);
  if (!key) throw new S3Error(403, "InvalidAccessKeyId");
  const credentialScope = fields.slice(1).join("/");
  const signingKey = await hmac(await hmac(await hmac(await hmac(`AWS4${key.secretAccessKey}`, date!), region), "s3"), "aws4_request");
  const toSign = `AWS4-HMAC-SHA256\n${timestamp}\n${credentialScope}\n${await digest(utf8.encode(canonical))}`;
  if (!await verifyHmac(signingKey, toSign, signature)) throw new S3Error(403, "SignatureDoesNotMatch");
  return { key, payloadHash, signingKey, signature, timestamp, credentialScope };
}

export function authorize(key: KeyRecord, drive: string | null, required: Access): void {
  if (drive !== null && key.drives && !key.drives.includes(drive)) throw new S3Error(404, "NoSuchBucket");
  const rank: Record<Access, number> = { read: 0, write: 1, admin: 2 };
  if (rank[key.scope] < rank[required]) throw new S3Error(403, "AccessDenied");
}
