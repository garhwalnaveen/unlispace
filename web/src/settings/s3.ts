import { API_URL, type Drive } from "../api";

/** The gateway accepts any SigV4 region and reports its buckets as `auto` (cloud/s3-gateway/src/index.ts). */
export const S3_REGION = "auto";

/**
 * Public URL of the S3 gateway, or null when it cannot be known from the build.
 * `VITE_S3_URL` wins. Otherwise it follows the deployment naming in cloud/s3-gateway/wrangler.jsonc
 * (`unlispace-api.<domain>` and `unlispace-s3.<domain>` share one domain) and the local stack's
 * ports (API 8788, S3 gateway 8789, see tests/e2e).
 */
export function s3Endpoint(apiUrl: string = API_URL, configured: string | undefined = import.meta.env.VITE_S3_URL): string | null {
  if (configured) return configured.replace(/\/$/, "");
  let url: URL;
  try { url = new URL(apiUrl); } catch { return null; }
  if (url.hostname.startsWith("unlispace-api.")) return `https://unlispace-s3.${url.hostname.slice("unlispace-api.".length)}`;
  if ((url.hostname === "127.0.0.1" || url.hostname === "localhost") && url.port === "8788") return `${url.protocol}//${url.hostname}:8789`;
  return null;
}

/** A drive's bucket is its alias when it has one, otherwise its id (cloud/s3-gateway/README.md). */
export const bucketName = (drive: Pick<Drive, "id" | "alias">) => drive.alias || drive.id;

/** POSIX single quoting, so a malformed server value stays inert when pasted in a shell. */
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

export const ENDPOINT_PLACEHOLDER = "https://YOUR-ORBIT-S3-ENDPOINT";
export const BUCKET_PLACEHOLDER = "YOUR-DRIVE";

export interface SnippetInput { accessKeyId: string; secretAccessKey: string; endpoint: string | null; bucket: string | null }
export type SnippetKind = "env" | "aws" | "rclone";
export const SNIPPET_LABELS: Record<SnippetKind, string> = { env: "Environment variables", aws: "AWS CLI", rclone: "rclone" };

export function snippet(kind: SnippetKind, { accessKeyId, secretAccessKey, endpoint, bucket }: SnippetInput): string {
  const url = endpoint ?? ENDPOINT_PLACEHOLDER, name = bucket ?? BUCKET_PLACEHOLDER;
  const credentials = `export AWS_ACCESS_KEY_ID=${quote(accessKeyId)}\nexport AWS_SECRET_ACCESS_KEY=${quote(secretAccessKey)}`;
  if (kind === "env") return `${credentials}\nexport AWS_ENDPOINT_URL=${quote(url)}\nexport AWS_DEFAULT_REGION=${quote(S3_REGION)}`;
  if (kind === "aws") return `${credentials}\naws s3 ls ${quote(`s3://${name}/`)} --endpoint-url ${quote(url)} --region ${S3_REGION}`;
  return `rclone config create orbit s3 provider=Other access_key_id=${quote(accessKeyId)} secret_access_key=${quote(secretAccessKey)} endpoint=${quote(url)} region=${S3_REGION} force_path_style=true\nrclone ls ${quote(`orbit:${name}`)}`;
}
