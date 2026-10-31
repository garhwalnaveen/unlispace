import { DurableObject } from "cloudflare:workers";
import type { CommitOp } from "./data-plane";
import type { Shard } from "./chunker";
import { S3Error } from "./errors";

export interface Upload { id: string; drive: string; key: string; contentType: string; createdAt: number; status: "open" | "completing" | "complete"; versionId?: string; etag?: string; size?: number; lease?: string; lockedUntil?: number; completionPages?: number; completion?: {operation: CommitOp; etag: string; parts: string} }
export interface Part { number: number; etag: string; size: number; shards: Shard[]; shardPages?: number; modified: number }
export interface VersionAnnotation { operation: string; restoredFrom?: string }
export interface StateStore {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  list<T>(prefix: string, after?: string, limit?: number): Promise<[string, T][]>;
  multipart(id: string, action: "part" | "lock" | "prepare" | "unlock" | "finish" | "abort", value?: Part | Partial<Upload>): Promise<Upload>;
}

/** Persistent per-workspace metadata; part bodies remain content-addressed data-plane shards. */
export class S3State extends DurableObject<Env> {
  override async fetch(request: Request): Promise<Response> {
    const body = await request.json() as { action: string; key: string; value?: unknown; after?: string; limit?: number; operation?: "part" | "lock" | "prepare" | "unlock" | "finish" | "abort" };
    if (typeof body.key !== "string" || body.key.length > 4096) return new Response(null, { status: 400 });
    if (body.action === "get") return Response.json({ value: await this.ctx.storage.get(body.key) });
    if (body.action === "list") {
      const limit = Math.min(body.limit ?? 1000,1000);
      if (!Number.isInteger(limit) || limit < 1 || (body.after !== undefined && (typeof body.after !== "string" || !body.after.startsWith(body.key)))) return new Response(null,{status:400});
      const page = await this.ctx.storage.list({prefix:body.key,limit,...(body.after ? {startAfter:body.after} : {})});
      return Response.json({value:[...page.entries()]});
    }
    if (body.action === "put") { await this.ctx.storage.put(body.key, body.value); return Response.json({}); }
    if (body.action === "delete") { await this.ctx.storage.delete(body.key); return Response.json({}); }
    if (body.action !== "multipart" || !body.operation) return new Response(null, { status: 400 });
    const result = await this.ctx.storage.transaction(async storage => {
      const upload = await storage.get<Upload>(`upload:${body.key}`);
      if (!upload) return { status: 404, code: "NoSuchUpload" };
      const value = body.value as Partial<Upload> | undefined;
      if (body.operation === "lock") {
        if (upload.status === "complete") return {value: upload};
        if (upload.status === "completing" && (upload.lockedUntil ?? 0) > Date.now()) return {status:409, code:"OperationAborted"};
        upload.status = "completing"; upload.lease = value?.lease; upload.lockedUntil = Date.now() + 120_000;
        await storage.put(`upload:${body.key}`, upload); return {value:upload};
      }
      if (upload.status === "completing") {
        if (!value?.lease || value.lease !== upload.lease) return {status:409,code:"OperationAborted"};
        if (body.operation === "prepare") {
          if (!upload.completion && value.completion) {
            const completion = structuredClone(value.completion);
            if (completion.operation.op === "put") {
              const refs = completion.operation.shards;
              upload.completionPages = Math.ceil(refs.length/1000);
              for (let i=0;i<refs.length;i+=1000) await storage.put(`completion:${body.key}:${String(i/1000).padStart(5,"0")}`,refs.slice(i,i+1000));
              completion.operation.shards = [];
            }
            upload.completion = completion;
          }
        } else if (body.operation === "finish") {
          Object.assign(upload, {versionId:value.versionId, etag:value.etag, size:value.size, status:"complete"});
        } else if (body.operation === "unlock") {
          upload.status = upload.completion ? "completing" : "open"; upload.lockedUntil = 0;
        } else if (body.operation !== "abort") return {status:409,code:"OperationAborted"};
        if (body.operation !== "abort") { await storage.put(`upload:${body.key}`, upload); return {value:upload}; }
      } else if (upload.status !== "open") return {status:409,code:"OperationAborted"};
      if (body.operation === "part") {
        const part = structuredClone(body.value as Part);
        const partKey = `part:${body.key}:${String(part.number).padStart(5, "0")}`;
        const previous = await storage.get<Part>(partKey);
        const refs = part.shards;
        part.shardPages = Math.ceil(refs.length / 1000);
        for (let i = 0; i < refs.length; i += 1000) await storage.put(partPageKey(body.key,part.number,i / 1000),refs.slice(i,i + 1000));
        for (let page = part.shardPages; page < (previous?.shardPages ?? 0); page++) await storage.delete(partPageKey(body.key,part.number,page));
        part.shards = [];
        await storage.put(`part:${body.key}:${String(part.number).padStart(5, "0")}`, part);
      } else if (body.operation === "abort") {
        await storage.delete(`upload:${body.key}`);
        for (const prefix of [`part:${body.key}:`,`part-shards:${body.key}:`,`completion:${body.key}:`]) {
          let after: string | undefined;
          for (;;) {
            const page = await storage.list({prefix,limit:100,...(after ? {startAfter:after} : {})});
            if (!page.size) break;
            after = [...page.keys()].at(-1);
            await storage.delete([...page.keys()]);
          }
        }
      } else return {status:409,code:"OperationAborted"};
      return { value: upload };
    });
    if (body.operation === "lock" && "value" in result && result.value && result.value.status !== "complete" && result.value.completionPages && result.value.completion?.operation.op === "put") {
      const op = result.value.completion.operation;
      for (let i=0;i<result.value.completionPages;i++) {
        const refs = await this.ctx.storage.get<Shard[]>(`completion:${body.key}:${String(i).padStart(5,"0")}`);
        if (!refs) throw new Error("completion manifest missing");
        op.shards.push(...refs);
      }
    }
    return Response.json(result, { status: "status" in result ? result.status : 200 });
  }
}

const partPageKey = (upload: string, part: number, page: number): string => `part-shards:${upload}:${String(part).padStart(5,"0")}:${String(page).padStart(5,"0")}`;

/** Large parts keep bounded state values and stream references into the final manifest. */
export async function* partShards(state: StateStore, upload: string, part: Part): AsyncGenerator<Shard> {
  if (part.shardPages === undefined) { yield* part.shards; return; }
  for (let page = 0; page < part.shardPages; page++) {
    const refs = await state.get<Shard[]>(partPageKey(upload,part.number,page));
    if (!refs) throw new S3Error(500,"InternalError","Multipart shard page is missing");
    yield* refs;
  }
}

export class BoundState implements StateStore {
  constructor(private readonly binding: { fetch(request: Request): Promise<Response> }) {}
  private async call<T>(action: string, key: string, value?: unknown, operation?: string, after?: string, limit?: number): Promise<T> {
    const response = await this.binding.fetch(new Request("https://s3-state.internal/", { method: "POST", body: JSON.stringify({ action, key, value, operation, after, limit }) }));
    const result = await response.json() as { value: T; code?: string };
    if (!response.ok) throw new S3Error(response.status, result.code ?? "InternalError");
    return result.value;
  }
  get<T>(key: string): Promise<T | undefined> { return this.call("get", key); }
  put<T>(key: string, value: T): Promise<void> { return this.call("put", key, value); }
  delete(key: string): Promise<void> { return this.call("delete", key); }
  list<T>(prefix: string, after?: string, limit?: number): Promise<[string, T][]> { return this.call("list", prefix,undefined,undefined,after,limit); }
  multipart(id: string, action: "part" | "lock" | "prepare" | "unlock" | "finish" | "abort", value?: Part | Partial<Upload>): Promise<Upload> {
    return this.call("multipart", id, value, action);
  }
}

/** Pages remain bounded even when callers stream millions of retained annotation keys. */
export async function* stateRows<T>(state: StateStore, prefix: string): AsyncGenerator<[string,T]> {
  let after: string | undefined;
  for (;;) {
    const page = await state.list<T>(prefix,after,100);
    yield* page;
    if (page.length < 100) return;
    after = page.at(-1)![0];
  }
}

/** New writes stay in the workspace; old upload authorities retain their original leases. */
export class WorkspaceState implements StateStore {
  constructor(private readonly current: StateStore, private readonly legacy: StateStore, private readonly drives: () => Promise<Set<string>>) {}
  async get<T>(key: string): Promise<T | undefined> { return (await this.current.get<T>(key)) ?? this.legacy.get<T>(key); }
  put<T>(key: string, value: T): Promise<void> { return this.current.put(key,value); }
  async delete(key: string): Promise<void> {
    if (await this.current.get(key) !== undefined) return this.current.delete(key);
    return this.legacy.delete(key);
  }
  async list<T>(prefix: string, after?: string, limit=1000): Promise<[string,T][]> {
    limit=Math.min(limit,1000);
    // Part keys belong to one upload, so retain one authority throughout its lifetime.
    const uploadId = /^(?:part|part-shards|completion):([^:]+):/.exec(prefix)?.[1];
    if (uploadId) {
      const owner = await this.current.get(`upload:${uploadId}`) !== undefined ? this.current : this.legacy;
      return owner.list(prefix,after,limit);
    }
    const keys = new Map<string,T>(await this.current.list<T>(prefix,after,limit));
    const allowed = prefix === "upload:" ? await this.drives() : null;
    let cursor=after;
    // The legacy global index is read in bounded pages; only this workspace's uploads escape.
    for (;;) {
      const page = await this.legacy.list<T>(prefix,cursor,100);
      for (const [key,value] of page) if (!allowed || allowed.has((value as Upload).drive)) {
        if (!keys.has(key)) keys.set(key,value);
      }
      const sorted=[...keys].sort(([a],[b])=>a<b?-1:a>b?1:0);
      if (page.length<100 || (sorted.length>=limit && page.at(-1)![0]>=sorted[limit-1]![0])) return sorted.slice(0,limit);
      cursor=page.at(-1)![0];
    }
  }
  async multipart(id: string, action: "part" | "lock" | "prepare" | "unlock" | "finish" | "abort", value?: Part | Partial<Upload>): Promise<Upload> {
    const owner = await this.current.get(`upload:${id}`) !== undefined ? this.current : this.legacy;
    return owner.multipart(id,action,value);
  }
}
