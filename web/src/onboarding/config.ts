/** Set at build time once a Mac release is hosted. */
export const MAC_APP_DOWNLOAD_URL: string | undefined = import.meta.env.VITE_MAC_APP_DOWNLOAD_URL || undefined;

/** Oldest macOS the Mac app supports (mac/Package.swift). */
export const MAC_APP_MINIMUM_MACOS = "14";
