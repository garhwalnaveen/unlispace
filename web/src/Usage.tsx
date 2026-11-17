import { Button } from "./components/ui/button";
import { useCallback } from "react";
import { useAuth } from "./context";
import { formatStorage } from "./settings/parts";
import "./settings/settings.css";
import { useLoad } from "./ui";

/** Storage used of the workspace's quota, as one line and a bar. Over quota it reassures first, then says what to do. */
export function UsageMeter({ usedBytes, quotaBytes }: { usedBytes: number; quotaBytes: number }) {
  const over = usedBytes > quotaBytes;
  const percent = quotaBytes > 0 ? Math.round((usedBytes / quotaBytes) * 100) : 0;
  return <div className={`st-usage ${over || percent >= 90 ? "full" : ""}`}>
    <p className="st-usage-line"><strong>{formatStorage(usedBytes)} of {formatStorage(quotaBytes)} used</strong><span>{usedBytes > 0 && percent === 0 ? "Less than 1%" : `${percent}%`}</span></p>
    <meter aria-label="Workspace storage usage" min={0} max={Math.max(1, quotaBytes)} value={Math.min(usedBytes, Math.max(1, quotaBytes))} />
    {over
      ? <p className="notice" role="alert">Your files are safe and readable. This workspace is over its storage, so uploads and changes are paused until you add storage or free some up.</p>
      : <p className="st-help">Earlier versions of your files count too, so deleting a file may not free space straight away.</p>}
  </div>;
}
export function OrgUsage({ orgId }: { orgId: string }) {
  const { auth } = useAuth();
  const load = useCallback(() => auth.api.billing.summary(orgId), [auth, orgId]);
  const usage = useLoad(load);
  return usage.data ? <UsageMeter {...usage.data} /> : <p className="muted small">{usage.error ? <>Storage usage unavailable. <Button onClick={usage.reload}>Retry usage</Button></> : "Loading storage usage…"}</p>;
}
