// The control plane's JWTs: the shared EdDSA implementation in cloud/shared/jwt.ts.
export { JwtError, signJwt, verifyJwt, b64urlEncode, b64urlDecodeOrThrow as b64urlDecode } from "../../shared/jwt";
export type { Jwk, Jwks, JwtClaims, JwtErrorCode, VerifyOptions } from "../../shared/jwt";
