import { authenticate, authorize, MemoryKeyResolver, type Auth, type Access, type KeyRecord, type KeyResolver } from "./auth";
import { collectBody, verifiedBody } from "./body";
import { DataPlane, Ed25519TokenMinter, type DriveAdmin, type FetchBinding, type InternalTokenMinter } from "./data-plane";
import { errorResponse, S3Error, tag, xml } from "./errors";
import { listObjects, listVersions } from "./listing";
import { abortUpload, completeUpload, createUpload, listParts, listUploads, uploadPart } from "./multipart";
import { copyObject, deleteKey, deleteObject, editObject, getObject, putObject, renameObject, restoreObject, type ObjectContext } from "./objects";
import { BoundState, type BucketRecord, type StateStore } from "./state";
import { XMLParser } from "fast-xml-parser";

export { S3State } from "./state";

/** Everything the router needs from the outside world; tests substitute fakes. */
export interface Deps {
  resolver: KeyResolver;
  tokens: InternalTokenMinter;
  dataPlane: FetchBinding;
  admin: DriveAdmin;
  state: StateStore;
  host: string;
  now: () => number;
}

const DRIVE_ID = /^[a-z0-9][a-z0-9-]{2,62}$/;
const EXTENSIONS = ["x-uls-write", "x-uls-patch", "x-uls-splice", "x-uls-rename", "x-uls-restore"] as const;
const xmlParser = new XMLParser({ isArray: n => n === "Object", parseTagValue: false });

export function depsFromEnv(env: Env): Deps {
  const dev = JSON.parse(env.ULS_S3_DEV_KEYS || "[]") as KeyRecord[];
  return {
    resolver: new MemoryKeyResolver(env.ULS_S3_MASTER_KEY ?? "", dev),
    tokens: new Ed25519TokenMinter(JSON.parse(env.ULS_JWT_PRIVATE_JWK) as JsonWebKey & { kid?: string }, env.ULS_ISSUER),
    dataPlane: env.DATA_PLANE,
    admin: env.DATA_PLANE_ADMIN as unknown as DriveAdmin,
    state: new BoundState(env.S3_STATE.get(env.S3_STATE.idFromName("global"))),
    host: env.ULS_S3_HOST,
    now: Date.now,
  };
}

/** Path-style `/{bucket}/{key}` or virtual-host `{bucket}.{host}/{key}`. */
function address(url: URL, host: string): { bucket: string | null; key: string } {
  let path: string;
  try { path = decodeURIComponent(url.pathname); } catch { throw new S3Error(400, "InvalidURI"); }
  const h = url.hostname.toLowerCase();
  if (h.endsWith(`.${host}`)) return { bucket: h.slice(0, -host.length - 1), key: path.replace(/^\//, "") };
  const rest = path.replace(/^\//, ""), slash = rest.indexOf("/");
  return slash < 0 ? { bucket: rest || null, key: "" } : { bucket: rest.slice(0, slash), key: rest.slice(slash + 1) };
}

async function requireBucket(deps: Deps, auth: Auth, bucket: string): Promise<void> {
  if (!DRIVE_ID.test(bucket)) throw new S3Error(400, "InvalidBucketName");
  authorize(auth.key, bucket, "read");
}

export async function handle(request: Request, deps: Deps): Promise<Response> {
  const url = new URL(request.url);
  const requestId = crypto.randomUUID();
  const head = request.method === "HEAD";
  try {
    if (url.pathname === "/healthz") return Response.json({ ok: true });
    const auth = await authenticate(request, deps.resolver, deps.now());
    const { bucket, key } = address(url, deps.host);
    const q = url.searchParams, method = request.method;
    const response = await route();
    response.headers.set("x-amz-request-id", requestId);
    return response;

    async function route(): Promise<Response> {
      const ctxFor = (b: string): ObjectContext => ({
        request, url, auth, key, now: deps.now, state: deps.state,
        dp: new DataPlane(deps.dataPlane, deps.tokens, auth.key, b),
      });
      if (bucket === null) {
        if (method !== "GET") throw new S3Error(405, "MethodNotAllowed");
        return listBuckets(deps, auth);
      }
      if (key === "") return bucketRoute(bucket, ctxFor(bucket));
      await requireBucket(deps, auth, bucket);
      const c = ctxFor(bucket);
      const write = (): void => authorize(auth.key, bucket, "write");
      const extension = EXTENSIONS.find(e => q.has(e));
      if (q.has("x-uls-versions")) {
        if (method !== "GET") throw new S3Error(405, "MethodNotAllowed");
        return objectVersions(c);
      }
      if (extension) {
        if (method !== "PUT" && method !== "POST") throw new S3Error(405, "MethodNotAllowed");
        write();
        switch (extension) {
          case "x-uls-write": return editObject(c, "write");
          case "x-uls-patch": return editObject(c, "patch");
          case "x-uls-splice": return editObject(c, "splice");
          case "x-uls-rename": return renameObject(c);
          default: return restoreObject(c);
        }
      }
      if (q.has("uploads") && method === "POST") { write(); return createUpload(c); }
      if (q.has("uploadId")) {
        if (method === "PUT") { write(); return uploadPart(c); }
        if (method === "POST") { write(); return completeUpload(c); }
        if (method === "DELETE") { write(); return abortUpload(c); }
        if (method === "GET") return listParts(c);
      }
      switch (method) {
        case "GET": case "HEAD": return getObject(c);
        case "PUT": write(); return request.headers.has("x-amz-copy-source") ? copyObject(c) : putObject(c);
        case "DELETE": write(); return deleteObject(c);
        default: throw new S3Error(405, "MethodNotAllowed");
      }
    }
  } catch (e) {
    if (!(e instanceof S3Error)) console.error("unhandled", e);
    const failure = errorResponse(e, requestId, url.pathname, head);
    failure.headers.set("x-amz-request-id", requestId);
    return failure;
  }

  async function bucketRoute(bucket: string, c: ObjectContext): Promise<Response> {
    const q = url.searchParams, method = request.method;
    const auth = c.auth;
    if (method === "PUT" && !q.size) {
      // CreateBucket: the bucket name is the drive id.
      authorize(auth.key, null, "admin");
      if (!DRIVE_ID.test(bucket)) throw new S3Error(400, "InvalidBucketName");
      if (auth.key.drives && !auth.key.drives.includes(bucket)) throw new S3Error(403, "AccessDenied");
      await collectBody(verifiedBody(request, auth, 64 * 1024), 64 * 1024);
      const known = await deps.state.get<BucketRecord>(`bucket:${bucket}`);
      if (known) throw new S3Error(409, known.orgId === auth.key.orgId ? "BucketAlreadyOwnedByYou" : "BucketAlreadyExists");
      try { await deps.admin.createDrive(bucket); }
      catch (e) {
        if (e instanceof Error && /drive_exists/.test(`${e.name} ${e.message}`)) throw new S3Error(409, "BucketAlreadyExists");
        throw e;
      }
      await deps.state.put<BucketRecord>(`bucket:${bucket}`, { driveId: bucket, alias: bucket, displayName: bucket, createdAt: deps.now(), orgId: auth.key.orgId });
      return new Response(null, { status: 200, headers: { location: `/${bucket}` } });
    }
    await requireBucket(deps, auth, bucket);
    if (method === "DELETE" && !q.size) {
      authorize(auth.key, bucket, "admin");
      const info = await c.dp.describe();
      if (info.fileCount > 0) throw new S3Error(409, "BucketNotEmpty");
      await deps.admin.deleteDrive(bucket);
      await deps.state.delete(`bucket:${bucket}`);
      return new Response(null, { status: 204 });
    }
    if (method === "HEAD" && !q.size) {
      const info = await c.dp.describe();
      return new Response(null, { headers: { "x-amz-bucket-region": "auto", ...(info.placement ? { "x-uls-placement": info.placement } : {}) } });
    }
    if (method === "GET" && q.has("versioning")) {
      await c.dp.describe();
      return xml("VersioningConfiguration", tag("Status", "Enabled"));
    }
    if (method === "GET" && q.has("location")) { await c.dp.describe(); return xml("LocationConstraint", ""); }
    if (method === "GET" && q.has("versions")) return listVersions(c, bucket);
    if (method === "GET" && q.has("uploads")) return listUploads(c);
    if (method === "POST" && q.has("delete")) { authorize(auth.key, bucket, "write"); return deleteObjects(c, bucket); }
    if (method === "GET" && (!q.size || q.has("list-type") || q.has("prefix") || q.has("delimiter") || q.has("max-keys") || q.has("marker") || q.has("encoding-type"))) return listObjects(c, bucket);
    throw new S3Error(501, "NotImplemented", "This bucket operation is not supported");
  }

  async function deleteObjects(c: ObjectContext, bucket: string): Promise<Response> {
    const body = new TextDecoder().decode(await collectBody(verifiedBody(request, c.auth, 4 * 1024 * 1024), 4 * 1024 * 1024));
    let objects: { Key: string }[], quiet: boolean;
    try {
      const doc = xmlParser.parse(body) as { Delete?: { Object?: { Key: string }[]; Quiet?: string } };
      objects = doc.Delete?.Object ?? []; quiet = doc.Delete?.Quiet === "true";
      if (objects.some(o => typeof o.Key !== "string")) throw new Error("bad key");
    } catch { throw new S3Error(400, "MalformedXML"); }
    if (!objects.length || objects.length > 1000) throw new S3Error(400, "MalformedXML", "Between 1 and 1000 objects are required");
    const deleted: string[] = [], errors: string[] = [];
    for (const { Key } of objects) {
      try { await deleteKey({ ...c, key: Key }, Key, new Request(request.url)); if (!quiet) deleted.push(`<Deleted>${tag("Key", Key)}</Deleted>`); }
      catch (e) {
        const err = e instanceof S3Error ? e : new S3Error(500, "InternalError");
        errors.push(`<Error>${tag("Key", Key)}${tag("Code", err.code)}${tag("Message", err.message)}</Error>`);
      }
    }
    void bucket;
    return xml("DeleteResult", deleted.join("") + errors.join(""));
  }
}

async function listBuckets(deps: Deps, auth: Auth): Promise<Response> {
  const records = (await deps.state.list<BucketRecord>("bucket:")).map(([, b]) => b)
    .filter(b => (!auth.key.drives || auth.key.drives.includes(b.driveId)) && (!b.orgId || b.orgId === auth.key.orgId))
    .sort((a, b) => a.alias < b.alias ? -1 : 1);
  return xml("ListAllMyBucketsResult", `<Owner>${tag("ID", auth.key.subject)}${tag("DisplayName", auth.key.subject)}</Owner><Buckets>${records.map(b => `<Bucket>${tag("Name", b.alias)}${tag("CreationDate", new Date(b.createdAt).toISOString())}</Bucket>`).join("")}</Buckets>`);
}

async function objectVersions(c: ObjectContext): Promise<Response> {
  const versions = await c.dp.versions(c.key);
  if (!versions.length) throw new S3Error(404, "NoSuchKey");
  return Response.json({ key: c.key, versions: versions.reverse().map(v => ({ versionId: v.versionId, op: v.op, size: v.size, ts: v.ts, actor: v.actor })) });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    let deps: Deps;
    try { deps = depsFromEnv(env); }
    catch (e) { console.error("misconfigured", e); return errorResponse(new S3Error(503, "ServiceUnavailable", "Gateway is not configured"), crypto.randomUUID()); }
    return handle(request, deps);
  },
} satisfies ExportedHandler<Env>;
export type { Access };
