import { Check, Copy } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { Button } from "../components/ui/button";
import "./settings.css";

export function PageHeader({ title, description, action }: { title: string; description?: ReactNode; action?: ReactNode }) {
  return <header className="st-header">
    <div><h1>{title}</h1>{description && <p>{description}</p>}</div>
    {action}
  </header>;
}

export function Section({ title, description, action, children, className = "", labelledBy }: { title: string; description?: ReactNode; action?: ReactNode; children?: ReactNode; className?: string; labelledBy: string }) {
  return <section className={`st-card ${className}`} aria-labelledby={labelledBy}>
    <div className="st-card-head">
      <div><h2 id={labelledBy}>{title}</h2>{description && <p>{description}</p>}</div>
      {action}
    </div>
    {children}
  </section>;
}

/** Copies `value`; says "Copied" for a moment, or reports that the browser refused. */
export function CopyButton({ value, label, children = "Copy", onError }: { value: string; label: string; children?: ReactNode; onError?: (error: Error) => void }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  async function copy() {
    try { await navigator.clipboard.writeText(value); setCopied(true); }
    catch { onError?.(new Error("Could not copy. Select the text and copy it yourself.")); }
  }
  return <Button type="button" size="sm" aria-label={label} onClick={() => void copy()}>
    {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
    <span aria-live="polite">{copied ? "Copied" : children}</span>
  </Button>;
}

export const formatDay = (ms: number) => new Date(ms).toLocaleDateString(undefined, { dateStyle: "medium" });
/** "today", "yesterday", "3 days ago", then a date. */
export function formatAgo(ms: number, now = Date.now()): string {
  const days = Math.floor((now - ms) / 86_400_000);
  if (days < 1) return "Today";
  if (days < 2) return "Yesterday";
  if (days < 30) return `${days} days ago`;
  return formatDay(ms);
}

/** Storage as plans describe it: decimal units, so a 500 GB plan reads "500 GB". */
export function formatStorage(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 1000) return `${Math.max(0, Math.round(bytes) || 0)} B`;
  const unit = Math.min(Math.floor(Math.log10(bytes) / 3), 4);
  return `${(bytes / 1000 ** unit).toLocaleString(undefined, { maximumFractionDigits: 1 })} ${["B", "KB", "MB", "GB", "TB"][unit]}`;
}
