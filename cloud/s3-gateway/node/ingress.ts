import { createServer, type Server } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { handle, type Deps } from "../src/index";
import { ControlPlaneKeyResolver, type ControlPlane } from "../src/control-plane";
import { Ed25519TokenMinter } from "../src/data-plane";
import type { StateStore } from "../src/state";
import { S3Error } from "../src/errors";

export interface IngressConfig {
  bridgeUrl: string; dataPlaneUrl: string; secret: string; host: string; issuer: string;
  signingKey: JsonWebKey & {kid?: string}; protocol?: "http" | "https";
}

export function ingressDeps(config: IngressConfig): Deps {
  for (const value of [config.bridgeUrl, config.dataPlaneUrl]) {
    const url = new URL(value);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))) throw new Error("Backend URLs require HTTPS or loopback HTTP");
    if (url.username || url.password || url.search || url.hash) throw new Error("Backend URLs must be plain origins");
  }
  if (config.secret.length < 32 || !config.host || !config.issuer || !config.signingKey.kid) throw new Error("Ingress configuration is incomplete");
  const call = async (service: string, method: string, args: unknown[], scope: {org: string; keyId: string} = {org: "", keyId: ""}): Promise<unknown> => {
    const response = await fetch(new URL("/_uls/ingress", config.bridgeUrl), {method: "POST", headers: {authorization: `Bearer ${config.secret}`, "content-type": "application/json"}, body: JSON.stringify({service, method, args, ...scope}), redirect: "error"});
    const answer = await response.json() as {value?: unknown; error?: string};
    if (!response.ok) throw new S3Error(response.status, answer.error ?? "ServiceUnavailable");
    return answer.value;
  };
  const cp = new Proxy({}, {get: (_target, method: string) => (...args: unknown[]) => call("control", method, args)}) as ControlPlane;
  const state = (org: string, keyId: string): StateStore => new Proxy({}, {get: (_target, method: string) => (...args: unknown[]) => call("state", method, args, {org, keyId})}) as StateStore;
  return {
    resolver: new ControlPlaneKeyResolver(cp), controlPlane: cp,
    state: state("", ""), workspaceState: state,
    sessionAPI: {async fetch(request) {
      const url = new URL(request.url);
      const answer = await call("session", "fetch", [{path: url.pathname + url.search, method: request.method, headers: Object.fromEntries(request.headers), body: request.method === "POST" ? await request.text() : null}]) as {status: number; headers: Record<string, string>; body: string};
      return new Response(answer.status === 204 ? null : answer.body, {status: answer.status, headers: answer.headers});
    }},
    tokens: new Ed25519TokenMinter(config.signingKey, config.issuer),
    dataPlane: {fetch(request) {
      const url = new URL(request.url), target = new URL(url.pathname + url.search, config.dataPlaneUrl);
      return fetch(target, {method: request.method, headers: request.headers, body: request.body, duplex: "half", redirect: "error"} as RequestInit);
    }},
    host: config.host, publicDataEndpoint:config.dataPlaneUrl, now: Date.now,
  };
}

/** The HTTP socket, checksum verifier and chunk uploader all apply backpressure. */
export function ingressServer(deps: Deps, protocol: "http" | "https" = "https"): Server {
  const server = createServer(async (incoming, outgoing) => {
    incoming.setTimeout(60_000,()=>incoming.destroy());
    const abort = new AbortController();
    incoming.once("aborted", () => abort.abort());
    outgoing.once("close", () => { if (!outgoing.writableEnded) abort.abort(); });
    try {
      const headers = new Headers();
      for (let i = 0; i < incoming.rawHeaders.length; i += 2) headers.append(incoming.rawHeaders[i]!, incoming.rawHeaders[i + 1]!);
      if (!headers.get("host")) { outgoing.writeHead(400).end(); return; }
      const body = incoming.method === "GET" || incoming.method === "HEAD" ? null : Readable.toWeb(incoming);
      const request = new Request(`${protocol}://${headers.get("host")}${incoming.url}`, {method: incoming.method, headers, body, signal: abort.signal, duplex: "half"} as RequestInit);
      const response = await handle(request, deps);
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body) await pipeline(Readable.fromWeb(response.body as import("node:stream/web").ReadableStream), outgoing);
      else outgoing.end();
    } catch {
      if (!outgoing.headersSent) outgoing.writeHead(503, {"content-type": "application/xml"});
      outgoing.end("<Error><Code>ServiceUnavailable</Code></Error>");
    }
  });
  // Large uploads are bounded by bytes, not Node's five-minute request deadline.
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;
  return server;
}
