import { DurableObject } from "cloudflare:workers";
import type { Manifest } from "./data-plane";
import type { Shard } from "./chunker";
import { S3Error } from "./errors";

export interface BucketRecord { driveId: string; alias: string; displayName: string; createdAt: number; orgId?: string; placement?: string; forkOf?: { driveId: string; forkPoint: string } }
export interface Upload { id: string; drive: string; key: string; contentType: string; createdAt: number; status: "open" | "completing" | "complete"; versionId?: string; etag?: string; size?: number }
export interface Part { number: number; etag: string; size: number; shards: Shard[]; modified: number }
export interface VersionAnnotation { operation: string; restoredFrom?: string; manifest: Manifest }
export interface StateStore {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  list<T>(prefix: string): Promise<[string, T][]>;
  multipart(id: string, action: "part" | "lock" | "unlock" | "finish" | "abort", value?: Part | Partial<Upload>): Promise<Upload>;
}

/** Persistent per-workspace metadata; part bodies remain content-addressed data-plane shards. */
export class S3State extends DurableObject<Env> {
  override async fetch(request: Request): Promise<Response> {
    const body = await request.json() as { action: string; key: string; value?: unknown; operation?: "part" | "lock" | "unlock" | "finish" | "abort" };
    if (typeof body.key !== "string" || body.key.length > 4096) return new Response(null, { status: 400 });
    if (body.action === "get") return Response.json({ value: await this.ctx.storage.get(body.key) });
    if (body.action === "list") {
      const result: [string, unknown][] = [];
      let startAfter: string | undefined;
      for (;;) {
        const page = await this.ctx.storage.list({ prefix: body.key, limit: 1000, ...(startAfter ? { startAfter } : {}) });
        result.push(...page.entries());
        if (page.size < 1000) break;
        startAfter = [...page.keys()].at(-1);
      }
      return Response.json({ value: result });
    }
    if (body.action === "put") { await this.ctx.storage.put(body.key, body.value); return Response.json({}); }
    if (body.action === "delete") { await this.ctx.storage.delete(body.key); return Response.json({}); }
    if (body.action !== "multipart" || !body.operation) return new Response(null, { status: 400 });
    const result = await this.ctx.storage.transaction(async storage => {
      const upload = await storage.get<Upload>(`upload:${body.key}`);
      if (!upload) return { status: 404, code: "NoSuchUpload" };
      if (body.operation === "finish" && upload.status === "completing") {
        const completed = { ...upload, ...body.value as Partial<Upload>, status: "complete" as const };
        await storage.put(`upload:${body.key}`, completed);
        return { value: completed };
      }
      if (body.operation === "unlock" && upload.status === "completing") {
        upload.status = "open"; await storage.put(`upload:${body.key}`, upload); return { value: upload };
      }
      if (upload.status === "complete" && body.operation === "lock") return { value: upload };
      if (upload.status !== "open") return { status: 409, code: "OperationAborted" };
      if (body.operation === "part") {
        const part = body.value as Part;
        await storage.put(`part:${body.key}:${String(part.number).padStart(5, "0")}`, part);
      } else if (body.operation === "lock") {
        upload.status = "completing"; await storage.put(`upload:${body.key}`, upload);
      } else if (body.operation === "abort") {
        await storage.delete(`upload:${body.key}`);
        // Retain no part manifests after abort. The unreferenced shards are collected by the data plane.
        const parts = await storage.list({ prefix: `part:${body.key}:` });
        for (const key of parts.keys()) await storage.delete(key);
      } else return { status: 409, code: "OperationAborted" };
      return { value: upload };
    });
    return Response.json(result, { status: "status" in result ? result.status : 200 });
  }
}

export class BoundState implements StateStore {
  constructor(private readonly binding: { fetch(request: Request): Promise<Response> }) {}
  private async call<T>(action: string, key: string, value?: unknown, operation?: string): Promise<T> {
    const response = await this.binding.fetch(new Request("https://s3-state.internal/", { method: "POST", body: JSON.stringify({ action, key, value, operation }) }));
    const result = await response.json() as { value: T; code?: string };
    if (!response.ok) throw new S3Error(response.status, result.code ?? "InternalError");
    return result.value;
  }
  get<T>(key: string): Promise<T | undefined> { return this.call("get", key); }
  put<T>(key: string, value: T): Promise<void> { return this.call("put", key, value); }
  delete(key: string): Promise<void> { return this.call("delete", key); }
  list<T>(prefix: string): Promise<[string, T][]> { return this.call("list", prefix); }
  multipart(id: string, action: "part" | "lock" | "unlock" | "finish" | "abort", value?: Part | Partial<Upload>): Promise<Upload> {
    return this.call("multipart", id, value, action);
  }
}
