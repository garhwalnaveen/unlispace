// Drive-token verification: EdDSA (Ed25519) JWTs, WebCrypto only. See docs/design/m1-contract.md §2-§3.
//
// Wire format (what the issuer in cloud/api must produce):
//   token   = b64url(header) "." b64url(payload) "." b64url(signature)       (base64url, no padding)
//   header  = {"alg":"EdDSA","typ":"JWT","kid":"<key id>"}
//   payload = {"iss","sub","sid","org","typ":"drive","drives":[{"id","access"}],"jti","iat","exp"}  (iat/exp in seconds)
//   signature = Ed25519 over the ASCII bytes of  b64url(header) "." b64url(payload)  (raw 64-byte signature)
// The JWKS is {"keys":[{"kty":"OKP","crv":"Ed25519","kid":"...","x":"..."}, ...]}; the key is picked by header `kid`.

import { verifyJwt } from "../../shared/jwt";
import type { Access } from "../../shared/access";

export { ACCESS_RANK, type Access } from "../../shared/access";

export interface DriveGrant {
	id: string;
	access: Access;
}
export interface DriveClaims {
	org: string;
	sub: string;
	exp: number; // seconds since epoch
	drives: DriveGrant[];
	upload?: {hash: string; length: number};
}

export const LEEWAY_SECONDS = 30;
export interface VerifyOptions {
	jwks: string | undefined;
	issuer: string | undefined;
	/** epoch milliseconds, injectable for tests */
	now?: number;
}

/** Returns the claims of a valid drive token, or null for any failure (callers answer 401). */
export async function verifyDriveToken(token: string, opts: VerifyOptions): Promise<DriveClaims | null> {
	if (!opts.jwks || !opts.issuer) return null;
	let c: Record<string, unknown>;
	try {
		c = await verifyJwt(token, opts.jwks, { issuer: opts.issuer, typ: "drive", now: opts.now, leewaySec: LEEWAY_SECONDS, notBefore: "nbf", sigLength: 64, fractionalNow: true });
	} catch {
		return null;
	}
	const nowSec = (opts.now ?? Date.now()) / 1000;
	if (typeof c.org !== "string" || !c.org || c.org.length > 128) return null;
	if (typeof c.sub !== "string" || c.sub.length > 128) return null;
	if (!Array.isArray(c.drives)) return null;
	const drives: DriveGrant[] = [];
	for (const d of c.drives as unknown[]) {
		const g = d as { id?: unknown; access?: unknown } | null;
		if (g && typeof g.id === "string" && (g.access === "read" || g.access === "write" || g.access === "admin")) {
			drives.push({ id: g.id, access: g.access });
		}
	}
	if (c.upload !== undefined) {
		const upload = c.upload as {hash?: unknown; length?: unknown} | null;
		if (!upload || typeof upload.hash !== "string" || !/^[a-f0-9]{64}$/.test(upload.hash) || !Number.isSafeInteger(upload.length) || (upload.length as number) < 1 || (upload.length as number) > 16 * 1024 * 1024 || drives.length !== 1 || drives[0]!.access !== "write" || (c.exp as number) <= nowSec) return null;
		return { sub: c.sub, org: c.org, exp: c.exp as number, drives, upload: {hash: upload.hash, length: upload.length as number} };
	}
	return { sub: c.sub, org: c.org, exp: c.exp as number, drives };
}
