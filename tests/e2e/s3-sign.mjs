import { createHash, createHmac } from 'node:crypto';
import { createRequire } from 'node:module';
import { join } from 'node:path';

class Sha256 {
  constructor(secret) { this.hash = secret ? createHmac('sha256', secret) : createHash('sha256'); }
  update(bytes) { this.hash.update(bytes); return this; }
  async digest() { return this.hash.digest(); }
}

/** Returns `sign(url, { method, key, headers, body })`, which resolves to SigV4-signed S3 gateway headers. */
export function s3Signer(root) {
  const require = createRequire(join(root, 'cloud/s3-gateway/package.json'));
  const { SignatureV4 } = require('@smithy/signature-v4');
  const { HttpRequest } = createRequire(require.resolve('@smithy/signature-v4'))('@smithy/core/protocols');
  return async (url, { method, key, headers = {}, body }) => {
    const credentials = { accessKeyId: key.accessKeyId, secretAccessKey: key.secretAccessKey };
    const signer = new SignatureV4({ credentials, region: 'auto', service: 's3', sha256: Sha256, uriEscapePath: false });
    const request = new HttpRequest({ protocol: url.protocol, hostname: url.hostname, port: Number(url.port), path: url.pathname,
      query: Object.fromEntries(url.searchParams), method, headers: { host: url.host, ...headers }, body });
    return (await signer.sign(request)).headers;
  };
}
