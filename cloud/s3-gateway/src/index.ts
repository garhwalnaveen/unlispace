import { authenticate, authorize, type Auth, type Access, type KeyResolver } from "./auth";
import { collectBody, verifiedBody } from "./body";
import { DataPlane, Ed25519TokenMinter, type FetchBinding, type InternalTokenMinter } from "./data-plane";
import { errorResponse, S3Error, tag, xml } from "./errors";
import { listObjects, listVersions } from "./listing";
import { abortUpload, completeUpload, createUpload, listParts, listUploads, uploadPart } from "./multipart";
import { copyObject, deleteKey, deleteObject, editObject, getObject, putObject, renameObject, restoreObject, type ObjectContext } from "./objects";
import { BoundState, WorkspaceState, type VersionAnnotation, type StateStore } from "./state";
import { control, keyResolver, type ControlPlane, type SessionAPI } from "./control-plane";
import { etag } from "./data-plane";
import { digest } from "./crypto";
import { XMLParser } from "fast-xml-parser";
import { handleIngressBridge } from "./ingress-bridge";
import { directPlan, directCommit } from "./direct";

declare global { interface Env { ULS_INGRESS_SECRET?: string; ULS_DATA_ENDPOINT?: string } }

export { S3State } from "./state";

/** Everything the router needs from the outside world; tests substitute fakes. */
export interface Deps {
  resolver: KeyResolver;
  controlPlane: ControlPlane;
  sessionAPI: SessionAPI;
  tokens: InternalTokenMinter;
  dataPlane: FetchBinding;
  state: StateStore;
  workspaceState?: (org: string, keyId: string) => StateStore;
  publicDataEndpoint?: string;
  host: string;
  now: () => number;
}

const ALIAS = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
const DRIVE_ID = /^d-[0-9a-z]{26}$/;
const EXTENSIONS = ["x-uls-write", "x-uls-patch", "x-uls-splice", "x-uls-rename", "x-uls-restore"] as const;
const xmlParser = new XMLParser({ isArray: n => n === "Object", parseTagValue: false });

export function depsFromEnv(env: Env): Deps {
  const cp = env.CONTROL_PLANE as unknown as ControlPlane;
  return {
    resolver: keyResolver(cp),
    controlPlane: cp,
    sessionAPI: env.API,
    tokens: new Ed25519TokenMinter(JSON.parse(env.ULS_JWT_PRIVATE_JWK ?? "") as JsonWebKey & { kid?: string }, env.ULS_ISSUER),
    dataPlane: env.DATA_PLANE,
    state: new BoundState(env.S3_STATE.get(env.S3_STATE.idFromName("global"))),
    workspaceState: (org,keyId) => new WorkspaceState(
      new BoundState(env.S3_STATE.get(env.S3_STATE.idFromName(`workspace:${org}`))),
      new BoundState(env.S3_STATE.get(env.S3_STATE.idFromName("global"))),
      async () => new Set((await control(() => cp.listDrives(keyId))).map(d=>d.driveId)),
    ),
    host: env.ULS_S3_HOST,
    publicDataEndpoint: env.ULS_DATA_ENDPOINT,
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

export async function handle(request: Request, deps: Deps): Promise<Response> {
  let url = new URL(request.url);
  const storageMount = url.searchParams.has("x-s3sdk-mount");
  const requestId = crypto.randomUUID();
  const head = request.method === "HEAD";
  try {
    if (url.pathname === "/healthz") return protocol(Response.json({ ok: true }));
    if (/^\/_(?:uls|s3sdk)\/keys(?:\/[^/]+)?$/.test(url.pathname)) {
      const response = await keyRoute(request, deps);
      response.headers.set("cache-control", "no-store");
      return protocol(response);
    }
    const auth = await authenticate(request, deps.resolver, deps.now());
    // Verify the caller's original wire bytes before translating extension names.
    request = extensionAliases(request);
    url = new URL(request.url);
    const state = deps.workspaceState?.(auth.key.orgId,auth.key.keyId) ?? deps.state;
    const { bucket, key } = address(url, deps.host);
    const q = url.searchParams, method = request.method;
    const response = await route();
    await deps.resolver.recordUse?.(auth.key.keyId);
    response.headers.set("x-amz-request-id", requestId);
    protocol(response);
    return response;

    async function route(): Promise<Response> {
      const ctxFor = (b: string): ObjectContext => ({
        request, url, auth, key, now: deps.now, state,
        resolveSource: async bucket => {
          const info = await control(() => deps.controlPlane.resolveBucket(auth.key.keyId, bucket));
          authorize(auth.key, info.driveId, "read");
          return new DataPlane(deps.dataPlane, deps.tokens, auth.key, info.driveId);
        },
        dp: new DataPlane(deps.dataPlane, deps.tokens, auth.key, b),
      });
      if (bucket === null) {
        if (method !== "GET") throw new S3Error(405, "MethodNotAllowed");
        return listBuckets(deps, auth);
      }
      if (key === "") return bucketRoute(bucket, ctxFor(bucket));
      const info = await control(() => deps.controlPlane.resolveBucket(auth.key.keyId, bucket));
      authorize(auth.key, info.driveId, "read");
      const c = ctxFor(info.driveId);
      if (new TextEncoder().encode(key).length > 1024 || key.startsWith("/") || key.replace(/\/$/, "").split("/").some(p => p === "." || p === ".." || p === "")) throw new S3Error(400, "InvalidArgument");
      if (["acl", "tagging", "torrent", "legal-hold", "retention", "attributes", "select", "restore"].some(name => q.has(name))) throw new S3Error(501, "NotImplemented", "This object operation is not supported");
      const write = (deleting = false): void => {
        authorize(auth.key, info.driveId, "write");
        if (info.access === "read") throw new S3Error(403, "AccessDenied");
        if (!deleting && !info.writable) throw new S3Error(403, "QuotaExceeded");
      };
      if ([...q.keys()].some(k => k.startsWith("x-uls-") && !["x-uls-versions", "x-uls-direct-plan", "x-uls-direct-commit"].includes(k) && !EXTENSIONS.some(e => e === k))) throw new S3Error(501, "NotImplemented");
      const extensions = EXTENSIONS.filter(e => q.has(e));
      if (extensions.length + Number(q.has("x-uls-versions")) + Number(q.has("x-uls-direct-plan")) + Number(q.has("x-uls-direct-commit")) > 1) throw new S3Error(400, "InvalidArgument");
      const extension = extensions[0];
      if (q.has("x-uls-direct-plan") || q.has("x-uls-direct-commit")) {
        const plan = q.has("x-uls-direct-plan");
        if (method !== (plan ? "POST" : "PUT")) throw new S3Error(405, "MethodNotAllowed");
        write();
        return plan ? directPlan(c,deps.publicDataEndpoint) : directCommit(c);
      }
      if (q.has("x-uls-versions")) {
        if (method !== "GET") throw new S3Error(405, "MethodNotAllowed");
        return objectVersions(c);
      }
      if (extension) {
        if (method !== (extension === "x-uls-patch" || extension === "x-uls-restore" ? "POST" : "PUT")) throw new S3Error(405, "MethodNotAllowed");
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
        if (method === "DELETE") { write(true); return abortUpload(c); }
        if (method === "GET") return listParts(c);
      }
      switch (method) {
        case "GET": case "HEAD": return getObject(c);
        case "PUT": write(); return request.headers.has("x-amz-copy-source") ? copyObject(c) : putObject(c);
        case "DELETE": write(true); return deleteObject(c);
        default: throw new S3Error(405, "MethodNotAllowed");
      }
    }
  } catch (e) {
    if (!(e instanceof S3Error)) console.error("unhandled", e);
    const failure = errorResponse(e, requestId, url.pathname, head);
    failure.headers.set("x-amz-request-id", requestId);
    return protocol(failure);
  }

  async function bucketRoute(bucket: string, c: ObjectContext): Promise<Response> {
    const q = url.searchParams, method = request.method;
    const auth = c.auth;
    if (method === "PUT" && !q.size) {
      authorize(auth.key, null, "admin");
      if (!ALIAS.test(bucket) || DRIVE_ID.test(bucket)) throw new S3Error(400, "InvalidBucketName");
      await collectBody(verifiedBody(request, auth, 64 * 1024), 64 * 1024);
      const source = request.headers.get("x-uls-fork-source");
      const placementHeader = request.headers.get("x-uls-placement");
      const placements: Record<string, string> = {wnam:"wnam", enam:"enam", weur:"weur", eeur:"eeur", apac:"apac", oc:"oc", sam:"enam", afr:"weur", me:"eeur"};
      if (!source && placementHeader !== null && !placements[placementHeader]) throw new S3Error(400, "InvalidArgument");
      let displayName: string | undefined;
      try { const value = request.headers.get("x-uls-display-name"); if (value !== null) displayName = decodeURIComponent(value); }
      catch { throw new S3Error(400, "InvalidArgument"); }
      const sourceInfo = source ? await control(() => deps.controlPlane.resolveBucket(auth.key.keyId, source)) : null;
      const created = source
        ? await control(() => deps.controlPlane.forkDrive(auth.key.keyId, {source, alias: bucket}))
        : await control(() => deps.controlPlane.createDrive(auth.key.keyId, {alias: bucket, ...(displayName !== undefined ? {displayName} : {}), ...(placementHeader ? {placement: placements[placementHeader]} : {})}));
      if (sourceInfo) {
        await c.state.put(`annotation-parent:${created.driveId}`,sourceInfo.driveId);
      }
      return new Response(null, {headers: {location: `/${bucket}`, "x-uls-drive-id": created.driveId,
        ...(sourceInfo && "forkPoint" in created ? {"x-uls-fork-source-id": sourceInfo.driveId, "x-uls-fork-point": new Date(created.forkPoint as number).toISOString()} : {})}});
    }
    const info = await control(() => deps.controlPlane.resolveBucket(auth.key.keyId, bucket));
    authorize(auth.key, info.driveId, "read");
    c = {...c, dp: new DataPlane(deps.dataPlane, deps.tokens, auth.key, info.driveId)};
    if (method === "DELETE" && !q.size) {
      authorize(auth.key, info.driveId, "admin");
      await control(() => deps.controlPlane.deleteDrive(auth.key.keyId, bucket, {hard: request.headers.get("x-uls-hard-delete") === "true"}));
      return new Response(null, {status: 204});
    }
    if (method === "GET" && q.has("x-uls-drive")) return Response.json(await control(() => deps.controlPlane.describeDrive(auth.key.keyId, bucket)));
    if (method === "GET" && q.has("x-uls-mount")) {
      if (storageMount) throw new S3Error(501, "NotImplemented", "Use x-uls-mount for native drive tokens; raw storage credentials are unavailable");
      return Response.json(await control(() => deps.controlPlane.mintMountToken(auth.key.keyId, bucket)));
    }
    if (method === "HEAD" && !q.size) return new Response(null, {headers: {"x-amz-bucket-region": "auto", ...(info.placement ? {"x-uls-placement": info.placement} : {})}});
    if (method === "GET" && q.has("versioning")) {
      await c.dp.describe();
      return xml("VersioningConfiguration", tag("Status", "Enabled"));
    }
    if (method === "GET" && q.has("location")) { await c.dp.describe(); return xml("LocationConstraint", ""); }
    if (method === "GET" && q.has("versions")) return listVersions(c, bucket);
    if (method === "GET" && q.has("uploads")) return listUploads(c);
    if (method === "POST" && q.has("delete")) { authorize(auth.key, info.driveId, "write"); if (info.access === "read") throw new S3Error(403, "AccessDenied"); return deleteObjects(c, bucket); }
    if (method === "GET" && (!q.size || q.has("list-type") || q.has("prefix") || q.has("delimiter") || q.has("max-keys") || q.has("marker") || q.has("encoding-type"))) return listObjects(c, bucket);
    throw new S3Error(501, "NotImplemented", "This bucket operation is not supported");
  }

  async function deleteObjects(c: ObjectContext, bucket: string): Promise<Response> {
    const body = new TextDecoder().decode(await collectBody(verifiedBody(request, c.auth, 4 * 1024 * 1024), 4 * 1024 * 1024));
    let objects: { Key: string; VersionId?: string }[], quiet: boolean;
    try {
      const doc = xmlParser.parse(body) as { Delete?: { Object?: { Key: string; VersionId?: string }[]; Quiet?: string } };
      objects = doc.Delete?.Object ?? []; quiet = doc.Delete?.Quiet === "true";
      if (objects.some(o => typeof o.Key !== "string")) throw new Error("bad key");
    } catch { throw new S3Error(400, "MalformedXML"); }
    if (!objects.length || objects.length > 1000) throw new S3Error(400, "MalformedXML", "Between 1 and 1000 objects are required");
    const deleted: string[] = [], errors: string[] = [];
    for (const { Key, VersionId } of objects) {
      try {
        if (VersionId !== undefined) throw new S3Error(501, "NotImplemented", "Version history is immutable");
        await deleteKey({ ...c, key: Key }, Key, new Request(request.url));
        if (!quiet) deleted.push(`<Deleted>${tag("Key", Key)}</Deleted>`);
      }
      catch (e) {
        const err = e instanceof S3Error ? e : new S3Error(500, "InternalError");
        errors.push(`<Error>${tag("Key", Key)}${VersionId !== undefined ? tag("VersionId", VersionId) : ""}${tag("Code", err.code)}${tag("Message", err.message)}</Error>`);
      }
    }
    void bucket;
    return xml("DeleteResult", deleted.join("") + errors.join(""));
  }
}

async function listBuckets(deps: Deps, auth: Auth): Promise<Response> {
  const records = await control(() => deps.controlPlane.listDrives(auth.key.keyId));
  return xml("ListAllMyBucketsResult", `<Owner>${tag("ID", auth.key.subject)}${tag("DisplayName", auth.key.subject)}</Owner><Buckets>${records.map(b => `<Bucket>${tag("Name", b.alias ?? b.driveId)}${tag("CreationDate", new Date(b.createdAt).toISOString())}</Bucket>`).join("")}</Buckets>`);
}

async function objectVersions(c: ObjectContext): Promise<Response> {
  const versions = await c.dp.versions(c.key);
  if (!versions.length) throw new S3Error(404, "NoSuchKey");
  const head = await c.dp.stat(c.key);
  const entries = [];
  const annotationDrives = [c.dp.drive];
  for (let depth = 0; depth < 8; depth++) {
    const parent = await c.state.get<string>(`annotation-parent:${annotationDrives.at(-1)!}`);
    if (!parent || annotationDrives.includes(parent)) break;
    annotationDrives.push(parent);
  }
  const current = versions.find(v => v.versionId === head.versionId);
  const latestContent = current?.op === "rename"
    ? versions.filter(v => !["rename", "delete", "mkdir"].includes(v.op)).at(-1)?.versionId
    : head.versionId;
  for (const v of versions) {
    let saved: VersionAnnotation | undefined;
    for (const drive of annotationDrives) {
      saved = await c.state.get<VersionAnnotation>(`version:${drive}:${v.versionId}`);
      if (saved) break;
    }
    const operation = saved?.operation ?? v.operation ?? v.op;
    if (["rename", "delete", "mkdir"].includes(operation)) continue;
    entries.push({versionId: v.versionId, isLatest: v.versionId === latestContent, size: v.size,
      etag: await etag(await c.dp.manifest(c.key, v.versionId)), lastModified: new Date(v.ts).toISOString(),
      operation: ["put", "write", "copy", "restore"].includes(operation) ? operation : "other", restoredFrom: saved?.restoredFrom ?? v.restoredFrom ?? null});
  }
  return Response.json({key: c.key, versions: entries});
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    let deps: Deps;
    try { deps = depsFromEnv(env); }
    catch (e) { console.error("misconfigured", e); return protocol(errorResponse(new S3Error(503, "ServiceUnavailable", "Gateway is not configured"), crypto.randomUUID())); }
    const internal = await handleIngressBridge(request, deps, env.ULS_INGRESS_SECRET);
    if (internal) { internal.headers.set("cache-control","no-store"); return internal; }
    return handle(request, deps);
  },
} satisfies ExportedHandler<Env>;
export type { Access };

function protocol(response: Response): Response {
  response.headers.set("x-uls-protocol", "1");
  for (const [name, value] of [...response.headers]) {
    if (name.startsWith("x-uls-")) response.headers.set(name.replace("x-uls-", "x-s3sdk-"), value);
  }
  return response;
}

function extensionAliases(request: Request): Request {
  const url = new URL(request.url), headers = new Headers(request.headers);
  let changed = false;
  for (const [name, value] of request.headers) {
    if (!name.startsWith("x-s3sdk-")) continue;
    const native = name.replace("x-s3sdk-", "x-uls-");
    if (headers.has(native)) throw new S3Error(400, "InvalidArgument", "Use one extension namespace per header");
    headers.set(native, value);
    changed = true;
  }
  for (const name of new Set(url.searchParams.keys())) {
    if (!name.startsWith("x-s3sdk-") && !name.startsWith("x-uls-")) continue;
    const native = name.replace("x-s3sdk-", "x-uls-");
    if (url.searchParams.getAll(name).length !== 1 || (name !== native && url.searchParams.has(native))) throw new S3Error(400, "InvalidArgument", "Ambiguous extension parameter");
    if (name !== native) {
      url.searchParams.set(native, url.searchParams.get(name)!);
      url.searchParams.delete(name);
      changed = true;
    }
  }
  return changed ? new Request(url, {method: request.method, headers, body: request.body, redirect: request.redirect, duplex:"half"} as RequestInit) : request;
}

async function keyRoute(request: Request, deps: Deps): Promise<Response> {
  const url = new URL(request.url), compatible = url.pathname.startsWith("/_s3sdk/"), root = /^\/_(?:uls|s3sdk)\/keys$/.test(url.pathname);
  try {
    if (request.headers.has("x-uls-login-authorization") && request.headers.has("x-s3sdk-login-authorization")) throw new S3Error(400, "InvalidArgument");
    const session = request.headers.get("x-s3sdk-login-authorization") ?? request.headers.get("x-uls-login-authorization") ?? request.headers.get("authorization");
    if (session?.startsWith("Bearer ")) {
      if (!(root && ["GET", "POST"].includes(request.method)) && !(!root && request.method === "DELETE")) return Response.json({error: "method_not_allowed"}, {status:405});
      const headers = new Headers({authorization: session});
      if (request.headers.has("content-type")) headers.set("content-type", request.headers.get("content-type")!);
      const upstream = await deps.sessionAPI.fetch(new Request(`https://api.internal${url.pathname.replace(/^\/_(?:uls|s3sdk)/, "")}${url.search}`, {method:request.method, headers, body: request.method === "POST" ? request.body : null}));
      if (compatible && request.method === "DELETE" && upstream.ok) return new Response(null, {status:204});
      return new Response(upstream.body, {status:upstream.status, headers:upstream.headers});
    }
    if (!root || request.method !== "POST") return Response.json({error:"access_denied"}, {status:403});
    if (url.searchParams.has("X-Amz-Algorithm") || !/^[a-f0-9]{64}$/.test(request.headers.get("x-amz-content-sha256") ?? "")) return Response.json({error:"invalid_argument"}, {status:400});
    let auth: Auth;
    try { auth = await authenticate(request, deps.resolver, deps.now()); }
    catch (error) { return Response.json({error: error instanceof S3Error && error.status === 503 ? "service_unavailable" : "access_denied"}, {status: error instanceof S3Error && error.status === 503 ? 503 : 403}); }
    const bytes = await collectBody(verifiedBody(request, auth, 64 * 1024), 64 * 1024);
    if (await digest(bytes) !== auth.payloadHash) throw new S3Error(400, "InvalidArgument");
    let body: {drives: string[]; access?: Access; label?: string; orgId?: string; workspaceId?: string};
    try { body = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new S3Error(400, "InvalidArgument"); }
    if (!body || !Array.isArray(body.drives) || !body.drives.length || body.drives.some(d => typeof d !== "string")) throw new S3Error(400, "InvalidArgument");
    for (const workspace of [body.orgId, body.workspaceId]) {
      if (workspace === undefined) continue;
      if (typeof workspace !== "string" || !workspace) throw new S3Error(400, "InvalidArgument");
      if (workspace !== auth.key.orgId) throw new S3Error(403, "AccessDenied");
    }
    if (body.label !== undefined && typeof body.label !== "string") throw new S3Error(400, "InvalidArgument");
    if (body.access !== undefined && !["read", "write", "admin"].includes(body.access)) throw new S3Error(400, "InvalidArgument");
    authorize(auth.key, null, body.access ?? auth.key.scope);
    for (const drive of body.drives) {
      if (auth.key.drives && !auth.key.drives.includes(drive)) throw new S3Error(403, "AccessDenied");
    }
    const result = await control(() => deps.controlPlane.mintChildKey(auth.key.keyId, {drives:body.drives, ...(body.access ? {access:body.access} : {}), ...(body.label !== undefined ? {label:body.label} : {})}));
    await deps.resolver.recordUse?.(auth.key.keyId);
    const minted = result as {key?: Record<string, unknown>; secretAccessKey?: string};
    return Response.json(compatible && minted.key ? {...minted.key, secretAccessKey: minted.secretAccessKey} : result, {status:201});
  } catch (error) {
    const e = error instanceof S3Error ? error : new S3Error(503, "ServiceUnavailable");
    return Response.json({error:e.code === "XAmzContentSHA256Mismatch" || e.code === "BadDigest" ? "InvalidArgument" : e.code}, {status:e.code === "XAmzContentSHA256Mismatch" || e.code === "BadDigest" ? 400 : e.status});
  }
}
