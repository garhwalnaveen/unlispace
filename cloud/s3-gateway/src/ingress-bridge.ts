import { createHash, timingSafeEqual } from "node:crypto";
import type { Deps } from "./index";
import { S3Error } from "./errors";

export const INGRESS_PATH = "/_uls/ingress";
const CONTROL = new Set(["resolveKey", "recordKeyUse", "listDrives", "resolveBucket", "createDrive", "forkDrive", "deleteDrive", "describeDrive", "mintChildKey", "mintMountToken"]);
const STATE = new Set(["get", "put", "delete", "list", "multipart"]);
const MAX_BYTES = 8 * 1024 * 1024;

/** Private service bridge for the streaming ingress; never accepts a user's S3 credential. */
export async function handleIngressBridge(request: Request, deps: Deps, secret: string | undefined): Promise<Response | null> {
  if (new URL(request.url).pathname !== INGRESS_PATH) return null;
  const supplied = request.headers.get("authorization") ?? "";
  if (!secret || secret.length < 32 || !timingSafeEqual(createHash("sha256").update(supplied).digest(), createHash("sha256").update(`Bearer ${secret}`).digest())) return Response.json({error: "access_denied"}, {status: 403});
  if (request.method !== "POST") return Response.json({error: "method_not_allowed"}, {status: 405});
  try {
    const reader = request.body?.getReader();
    if (!reader) throw new S3Error(400, "InvalidArgument");
    const pieces: Uint8Array[] = [];
    let length = 0;
    try {
      for (;;) {
        const {done, value} = await reader.read();
        if (done) break;
        length += value.length;
        if (length > MAX_BYTES) throw new S3Error(413, "EntityTooLarge");
        pieces.push(value);
      }
    } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
    const data = new Uint8Array(length);
    let offset = 0;
    for (const piece of pieces) { data.set(piece, offset); offset += piece.length; }
    const body = JSON.parse(new TextDecoder().decode(data)) as {service: string; method: string; args: unknown[]; org?: string; keyId?: string};
    if (!body || !Array.isArray(body.args) || body.args.length > 5) throw new S3Error(400, "InvalidArgument");
    if (body.service === "control" && CONTROL.has(body.method)) {
      const control = deps.controlPlane as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
      try { return Response.json({value: await control[body.method]!(...body.args)}); }
      catch (error) { return Response.json({error: error instanceof Error ? error.message : "service_unavailable"}, {status: 503}); }
    }
    if (body.service === "state" && STATE.has(body.method)) {
      const key = body.args[0];
      if (typeof key !== "string" || key.length > 4096 || typeof body.org !== "string" || typeof body.keyId !== "string") throw new S3Error(400, "InvalidArgument");
      if (body.method === "list" && body.args[2] !== undefined && (!Number.isInteger(body.args[2]) || Number(body.args[2]) < 1 || Number(body.args[2]) > 1000)) throw new S3Error(400, "InvalidArgument");
      const state = (deps.workspaceState?.(body.org, body.keyId) ?? deps.state) as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
      return Response.json({value: await state[body.method]!(...body.args)});
    }
    if (body.service === "session" && body.method === "fetch") {
      const init = body.args[0] as {path: string; method: string; headers: Record<string, string>; body: string | null};
      if (!init || !/^\/keys(?:\/[^/?]+)?(?:\?.*)?$/.test(init.path) || !["GET", "POST", "DELETE"].includes(init.method)) throw new S3Error(400, "InvalidArgument");
      const response = await deps.sessionAPI.fetch(new Request(`https://api.internal${init.path}`, {method: init.method, headers: init.headers, body: init.body}));
      return Response.json({value: {status: response.status, headers: Object.fromEntries(response.headers), body: await response.text()}});
    }
    throw new S3Error(400, "InvalidArgument");
  } catch (error) {
    const failure = error instanceof S3Error ? error : new S3Error(400, "InvalidArgument");
    return Response.json({error: failure.code}, {status: failure.status});
  }
}
