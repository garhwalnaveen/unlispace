import { Check, Copy } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { OrbitMark } from "../OrbitMark";
import "./onboarding.css";

/** The single centred card used by sign-in, desktop connect, invitations and the welcome flow. */
export function Card({ title, lead, icon, wide = false, children }: {
  title: ReactNode;
  lead?: ReactNode;
  icon?: ReactNode;
  wide?: boolean;
  children?: ReactNode;
}) {
  return (
    <section className={wide ? "ob-card ob-wide" : "ob-card"} aria-labelledby="ob-title">
      <header className="ob-head">
        <span className="ob-mark" aria-hidden="true">{icon ?? <OrbitMark />}</span>
        <h1 id="ob-title" tabIndex={-1}>{title}</h1>
        {lead && <p className="ob-lead">{lead}</p>}
      </header>
      {children}
    </section>
  );
}

/** Copies `text` and confirms in place; `onError` reports a blocked clipboard. */
export function CopyButton({ text, label, children, onError }: { text: string; label: string; children?: ReactNode; onError?: () => void }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return (
    <button type="button" className="ob-copy" aria-label={label} title={label} onClick={() => {
      void navigator.clipboard.writeText(text).then(() => setCopied(true), () => onError?.());
    }}>
      {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
      <span role="status">{copied ? "Copied" : children ?? ""}</span>
    </button>
  );
}
