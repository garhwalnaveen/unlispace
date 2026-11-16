import { Button } from "./components/ui/button";
import { useCallback } from "react";
import { useAuth } from "./context";
import { formatBytes, useLoad } from "./ui";

export function UsageMeter({ usedBytes, quotaBytes }: { usedBytes: number; quotaBytes: number }) {
  return <div className="usage-meter">
    <p>{formatBytes(usedBytes)} of {formatBytes(quotaBytes)} used</p>
    <meter aria-label="Workspace storage usage" min={0} max={Math.max(1, quotaBytes)} value={Math.min(usedBytes, Math.max(1, quotaBytes))} />
    <p className="muted small">Usage includes retained versions and pending uploads. Deleting a file keeps its history and may not immediately free storage.</p>
    {usedBytes > quotaBytes && <p className="notice" role="alert">Your workspace is over its storage quota. Writes are paused. Existing files remain readable. Add storage in Billing or contact support about retained data.</p>}
  </div>;
}
export function OrgUsage({ orgId }: { orgId: string }) {
  const { auth } = useAuth();
  const load = useCallback(() => auth.api.billing.summary(orgId), [auth, orgId]);
  const usage = useLoad(load);
  return usage.data ? <UsageMeter {...usage.data} /> : <p className="muted small">{usage.error ? <>Storage usage unavailable. <Button onClick={usage.reload}>Retry usage</Button></> : "Loading storage usage…"}</p>;
}
