import { utf8 } from "../../shared/bytes";

export { utf8, base64, b64urlEncode as base64url, toHex as hex, sha256Hex as digest } from "../../shared/bytes";
export async function hmac(key: Uint8Array | string, value: string): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", typeof key === "string" ? utf8.encode(key) : key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, utf8.encode(value)));
}
export async function verifyHmac(key: Uint8Array, value: string, signature: string): Promise<boolean> {
  if (!/^[a-f0-9]{64}$/.test(signature)) return false;
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const sig = Uint8Array.from(signature.match(/../g)!, b => parseInt(b, 16));
  return crypto.subtle.verify("HMAC", k, sig, utf8.encode(value));
}
