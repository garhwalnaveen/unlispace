import { useCallback, useMemo } from "react";
import { useAuth } from "./context";
import { m2 } from "./m2";
import { formatBytes, useLoad } from "./ui";

export function UsageMeter({ usedBytes, quotaBytes }: { usedBytes: number; quotaBytes: number }) {
  return <div className="usage-meter">
    <p>{formatBytes(usedBytes)} of {formatBytes(quotaBytes)} used</p>
    <meter aria-label="Organization storage usage" min={0} max={Math.max(1, quotaBytes)} value={Math.min(usedBytes, Math.max(1, quotaBytes))} />
    {usedBytes > quotaBytes && <p className="notice" role="alert">Your organization is over its storage quota. Writes are paused. Existing files remain readable. Delete data or add storage in Billing to resume writes.</p>}
  </div>;
}
export function OrgUsage({ orgId }: { orgId: string }) {
  const { auth } = useAuth();
  const api = useMemo(() => m2(auth.api), [auth]);
  const load = useCallback(() => api.billing(orgId), [api, orgId]);
  const usage = useLoad(load);
  return usage.data ? <UsageMeter {...usage.data} /> : <p className="muted small">{usage.error ? <>Storage usage unavailable. <button onClick={usage.reload}>Retry usage</button></> : "Loading storage usage…"}</p>;
}
