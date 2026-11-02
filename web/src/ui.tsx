import { Dialog, DialogContent, DialogHeader, DialogTitle } from "./components/ui/dialog";
import { Monitor, Sun, Moon, HardDrive, UserRound, KeyRound, ChevronRight, Folder, File, Sparkles } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { errorMessage } from "./api";

export function ErrorNotice({ error }: { error: unknown }) {
  return error ? (
    <p className="notice error" role="alert" aria-live="assertive">
      {typeof error === "string" ? error : errorMessage(error)}
    </p>
  ) : null;
}
export function Loading({ children = "Loading…" }: { children?: ReactNode }) {
  return (
    <p className="muted" role="status">
      {children}
    </p>
  );
}
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), 4);
  return `${(bytes / 1024 ** unit).toLocaleString(undefined, { maximumFractionDigits: 1 })} ${["B", "KiB", "MiB", "GiB", "TiB"][unit]}`;
}
export function formatDate(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}
export function useLoad<T>(load: () => Promise<T>) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<unknown>();
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(undefined);
    setData(undefined);
    void load()
      .then((value) => {
        if (active) setData(value);
      })
      .catch((reason) => {
        if (active) setError(reason);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [load, revision]);
  return {
    data,
    error,
    loading,
    reload: () => setRevision((value) => value + 1),
  };
}
export function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const [opener] = useState(() => document.activeElement);
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent aria-describedby={undefined} onCloseAutoFocus={(event) => {
        event.preventDefault();
        if (opener instanceof HTMLElement) opener.focus();
      }}>
        <DialogHeader><DialogTitle>{title}</DialogTitle></DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  );
}
const icons = { monitor: Monitor, sun: Sun, moon: Moon, drive: HardDrive, user: UserRound, key: KeyRound, chevron: ChevronRight, folder: Folder, file: File, sparkles: Sparkles };
export function Icon({ name }: { name: keyof typeof icons }) {
  const Component = icons[name];
  return <Component size={18} strokeWidth={1.75} aria-hidden="true" />;
}
export function FileIcon({ folder = false }: { folder?: boolean }) {
  return <span className={`file-icon ${folder ? "folder" : ""}`}><Icon name={folder ? "folder" : "file"} /></span>;
}
