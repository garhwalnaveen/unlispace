export class S3Error extends Error {
  constructor(readonly status: number, readonly code: string, message = code, readonly headers: Record<string, string> = {}) {
    super(message);
  }
}

export const xmlEscape = (s: unknown): string => String(s ?? "").replace(/[<>&"']/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]!);
export const tag = (name: string, value: unknown): string => `<${name}>${xmlEscape(value)}</${name}>`;
export function xml(root: string, content: string, status = 200, headers: HeadersInit = {}): Response {
  const h = new Headers(headers);
  h.set("content-type", "application/xml");
  return new Response(`<?xml version="1.0" encoding="UTF-8"?><${root} xmlns="http://s3.amazonaws.com/doc/2006-03-01/">${content}</${root}>`, { status, headers: h });
}
export function errorResponse(error: unknown, requestId: string, resource = "", noBody = false): Response {
  const e = error instanceof S3Error ? error : new S3Error(500, "InternalError", "We encountered an internal error. Please try again.");
  // 304 and HEAD responses must not carry a body.
  if (noBody || e.status === 304) return new Response(null, { status: e.status, headers: e.headers });
  return xml("Error", tag("Code", e.code) + tag("Message", e.message) + tag("Resource", resource) + tag("RequestId", requestId), e.status, e.headers);
}
export function integer(value: string | null, fallback?: number): number {
  if (value === null && fallback !== undefined) return fallback;
  if (value === null || !/^(0|[1-9][0-9]*)$/.test(value)) throw new S3Error(400, "InvalidArgument", "Expected a nonnegative decimal integer");
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new S3Error(400, "InvalidArgument", "Integer exceeds safe range");
  return n;
}
