export function desktopParameters(search: string): {
  state: string;
  codeChallenge: string;
} {
  const params = new URLSearchParams(search);
  const state = params.get("state");
  const codeChallenge = params.get("code_challenge");
  if (!state || !codeChallenge || !/^[A-Za-z0-9_-]{43}$/.test(codeChallenge))
    throw new Error(
      "This desktop sign-in link is incomplete or invalid. Start sign-in again from the desktop app.",
    );
  return { state, codeChallenge };
}
export function desktopCallback(code: string, state: string): string {
  return `uls://auth/callback#${new URLSearchParams({ code, state })}`;
}
export function finderLink(drive: string, path: string): string {
  return `uls://open?${new URLSearchParams({ drive, path })}`;
}
export function driveLink(id: string, path = ""): string {
  return `/drives/${encodeURIComponent(id)}/${path.split("/").map(encodeURIComponent).join("/")}`;
}
export function safeReturn(path: string | null): string {
  return path?.startsWith("/") && !path.startsWith("//") && !path.includes("\\")
    ? path
    : "/";
}
