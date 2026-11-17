/**
 * Where "Download for Mac" points. The repository has no published download location yet
 * (mac/scripts/release.sh only builds `Orbit-<version>.dmg` locally), so this is a placeholder:
 * set `VITE_MAC_APP_DOWNLOAD_URL` at build time, or replace the default once the DMG is hosted.
 */
export const MAC_APP_DOWNLOAD_URL: string =
  import.meta.env.VITE_MAC_APP_DOWNLOAD_URL || "https://orbitfs.io/download/Orbit.dmg";

/** Oldest macOS the Mac app supports (mac/Package.swift). */
export const MAC_APP_MINIMUM_MACOS = "14";
