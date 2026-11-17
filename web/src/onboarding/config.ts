import { API_URL } from "../api";

/**
 * Where "Download for Mac" points. The repository has no published download location yet
 * (mac/scripts/release.sh only builds `Orbit-<version>.dmg` locally), so this is a placeholder:
 * set `VITE_MAC_APP_DOWNLOAD_URL` at build time, or replace the default once the DMG is hosted.
 */
export const MAC_APP_DOWNLOAD_URL: string =
  import.meta.env.VITE_MAC_APP_DOWNLOAD_URL || "https://orbitfs.io/download/Orbit.dmg";

/** Oldest macOS the Mac app supports (mac/Package.swift). */
export const MAC_APP_MINIMUM_MACOS = "14";

/**
 * Public endpoint of the S3 gateway (cloud/s3-gateway). Set `VITE_S3_URL` to override. Otherwise it
 * follows the deployment naming in the Wrangler configs, where the gateway sits next to the API
 * (`unlispace-api.<domain>` and `unlispace-s3.<domain>`; locally API :8788 and gateway :8789).
 */
export function s3Endpoint(apiUrl: string = API_URL, override: string | undefined = import.meta.env.VITE_S3_URL): string {
  if (override) return override.replace(/\/$/, "");
  try {
    const url = new URL(apiUrl);
    const [first, ...rest] = url.hostname.split(".");
    if (/api$/.test(first) && rest.length) url.hostname = [first.replace(/api$/, "s3"), ...rest].join(".");
    else if (url.port === "8788") url.port = "8789";
    return url.origin;
  } catch { return apiUrl; }
}
export const S3_ENDPOINT = s3Endpoint();
/** The gateway accepts any SigV4 region and reports `auto` as the bucket region. */
export const S3_REGION = "auto";
