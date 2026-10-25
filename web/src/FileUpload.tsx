import { useRef, useState, type ReactNode } from "react";
import { type DriveApi } from "./api";
import { uploadFile, type UploadProgress } from "./upload";
import { ErrorNotice, formatBytes } from "./ui";

export function Upload({ api, path, onDone, children }: { api: DriveApi; path: string; onDone: () => void; children: ReactNode }) {
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<unknown>();
  const [progress, setProgress] = useState<UploadProgress>();
  const [name, setName] = useState("");
  async function upload(files: File[]) {
    if (running.current || !files.length) return;
    running.current = true; setBusy(true); setError(undefined); setProgress(undefined);
    let failed = false;
    try {
      for (const file of files) {
        setName(file.name);
        await uploadFile(api, file, path + file.name, setProgress);
        onDone();
      }
    } catch (reason) { failed = true; setError(reason); setProgress(undefined); }
    finally {
      running.current = false; setBusy(false);
      if (!failed) setName(`${files.length} file${files.length === 1 ? "" : "s"}`);
    }
  }
  return <section aria-label="File upload and folder contents" className={dragging ? "upload-area dragging" : "upload-area"}
    onDragOver={(event) => { event.preventDefault(); if (!busy) setDragging(true); }}
    onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }}
    onDrop={(event) => { event.preventDefault(); setDragging(false); void upload(Array.from(event.dataTransfer.files)); }}>
    <div className="upload-toolbar"><div><strong>Upload to this folder</strong><p className="muted small">Drop files here or choose files. Matching names create a new version.</p></div>
      <label className="button upload-picker">Choose files<input type="file" multiple disabled={busy} aria-label="Choose files to upload" onChange={(event) => { void upload(Array.from(event.target.files || [])); event.target.value = ""; }} /></label>
    </div>
    <ErrorNotice error={error} />
    {progress && <div role="status" className="upload-progress">
      <p>{progress.phase === "done" && !busy ? `Uploaded ${name}.` : `${progress.phase === "hashing" ? "Preparing" : progress.phase === "committing" ? "Saving version of" : "Uploading"} ${name}…`}</p>
      {busy && <><progress aria-label="Upload progress" max={progress.total || 1} value={progress.bytes} /><p className="muted small">{formatBytes(progress.bytes)} of {formatBytes(progress.total)}{progress.phase === "hashing" ? " prepared" : " transferred or already stored"}</p></>}
    </div>}
    {children}
  </section>;
}
