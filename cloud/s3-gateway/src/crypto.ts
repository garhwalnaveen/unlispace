export const utf8 = new TextEncoder();
export const hex = (bytes: Uint8Array): string => Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
export async function digest(bytes: Uint8Array): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}
export const base64 = (bytes: Uint8Array): string => btoa(Array.from(bytes, b => String.fromCharCode(b)).join(""));
export const base64url = (bytes: Uint8Array): string => base64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
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
