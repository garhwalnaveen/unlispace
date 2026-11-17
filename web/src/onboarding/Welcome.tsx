import { ArrowLeft, Check, ChevronRight, Download, Globe, HardDrive, KeyRound, Laptop, LoaderCircle, Terminal, TriangleAlert, Upload } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { DriveApi, type Drive } from "../api";
import { Button, buttonVariants } from "../components/ui/button";
import { useAuth } from "../context";
import type { KeySecret } from "../keys";
import { OrbitMark } from "../OrbitMark";
import { useWorkspace } from "../shell/workspace";
import { ErrorNotice, formatBytes } from "../ui";
import { uploadFile, type UploadProgress } from "../upload";
import { Card, CopyButton } from "./Card";
import { MAC_APP_DOWNLOAD_URL, MAC_APP_MINIMUM_MACOS, S3_ENDPOINT, S3_REGION } from "./config";
import { writeOnboarding, type OnboardingPath } from "./state";

const PATHS: { id: OnboardingPath; icon: ReactNode; title: string; detail: string }[] = [
  { id: "mac", icon: <Laptop />, title: "On my Mac", detail: "Open your drive in Finder like any other disk." },
  { id: "tools", icon: <Terminal />, title: "With an agent or S3 tool", detail: "Give an agent, a script or an S3 client its own key." },
  { id: "browser", icon: <Globe />, title: "In the browser", detail: "Upload your first files from this page." },
];
const isPath = (value: string | null): value is OnboardingPath => PATHS.some((path) => path.id === value);

/** Shown once after an account is created: one question, then the shortest route to a first result. */
export function Welcome() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const requested = params.get("path");
  const path = isPath(requested) ? requested : null;
  // A secret that is on screen must not be lost to a stray click on Back or Skip.
  const [locked, setLocked] = useState(false);
  useEffect(() => {
    setLocked(false);
    document.getElementById("ob-title")?.focus({ preventScroll: true });
  }, [path]);
  function finish() {
    writeOnboarding({ status: "done", ...(path ? { path } : {}) });
    navigate("/", { replace: true });
  }
  return (
    <div className="ob-welcome">
      <div className="ob-topline">
        {path && !locked
          ? <button type="button" className="ob-link ob-back" onClick={() => setParams({})}><ArrowLeft aria-hidden="true" />Back</button>
          : <span className="brand"><OrbitMark />Orbit</span>}
        <span>Step {path ? 2 : 1} of 2</span>
      </div>
      {path === "mac" ? <MacStep onDone={finish} />
        : path === "tools" ? <NeedsDrive onDone={finish}>{(drive) => <ToolsStep drive={drive} onDone={finish} onSecret={setLocked} />}</NeedsDrive>
        : path === "browser" ? <NeedsDrive onDone={finish}>{(drive) => <BrowserStep drive={drive} onDone={finish} />}</NeedsDrive>
        : (
          <Card wide title="Welcome to Orbit" lead="One drive for your files that opens in Finder, in the browser and from your tools.">
            <h2 className="ob-question" id="ob-question">How will you use Orbit?</h2>
            <div className="ob-choices" role="group" aria-labelledby="ob-question">
              {PATHS.map((choice) => (
                <button key={choice.id} type="button" className="ob-choice" onClick={() => setParams({ path: choice.id })}>
                  <span aria-hidden="true">{choice.icon}</span>
                  <span><strong>{choice.title}</strong><small>{choice.detail}</small></span>
                  <ChevronRight aria-hidden="true" />
                </button>
              ))}
            </div>
            <p className="ob-muted">Pick one to start. The others stay on your Get started list.</p>
          </Card>
        )}
      {!locked && <button type="button" className="ob-link ob-skip" onClick={finish}>Skip for now</button>}
    </div>
  );
}

function MacStep({ onDone }: { onDone: () => void }) {
  const [downloaded, setDownloaded] = useState(false);
  const onMac = /mac/i.test(navigator.userAgent);
  const download = (
    <a href={MAC_APP_DOWNLOAD_URL} download onClick={() => setDownloaded(true)}>
      <Download aria-hidden="true" />{downloaded ? "Download again" : "Download for Mac"}
    </a>
  );
  return (
    <Card wide icon={<Laptop />} title="Get Orbit for Mac" lead="Your drive opens in Finder like any other disk.">
      <ol className="ob-steps">
        <li><div><strong>Download Orbit</strong><span>Open the download and drag Orbit to Applications. Needs macOS {MAC_APP_MINIMUM_MACOS} or later.</span></div></li>
        <li><div><strong>Open Orbit and sign in</strong><span>Orbit sends you back to this browser to confirm it is you.</span></div></li>
        <li><div><strong>Find your drive in Finder</strong><span>It appears as soon as the app has connected.</span></div></li>
      </ol>
      {!onMac && <p className="ob-muted">This device is not a Mac. You can download Orbit later on your Mac from Get started.</p>}
      {downloaded ? <>
        <Button variant="default" className="ob-main" onClick={onDone}>Continue to your files</Button>
        <Button asChild variant="ghost" className="ob-main">{download}</Button>
      </> : <Button asChild variant="default" className="ob-main">{download}</Button>}
    </Card>
  );
}

const SETUP_CHECKS = 10;
const SETUP_CHECK_MS = 2000;
/** Waits calmly for the first drive: a new account's drive can take a few seconds to be set up. */
function NeedsDrive({ children, onDone }: { children: (drive: Drive) => ReactNode; onDone: () => void }) {
  const workspace = useWorkspace();
  const { loading, loaded, error, reload, drives, current, canManage } = workspace;
  const [checks, setChecks] = useState(0);
  const drive = drives.find((item) => item.status === "ready");
  const waiting = loaded && !drive && drives.length > 0;
  useEffect(() => {
    if (!waiting || loading || error || checks >= SETUP_CHECKS) return;
    const timer = window.setTimeout(() => { setChecks((value) => value + 1); reload(); }, SETUP_CHECK_MS);
    return () => window.clearTimeout(timer);
  }, [waiting, loading, error, checks, reload]);
  if (drive) return <>{children(drive)}</>;
  if (!loaded && !error)
    return <Card wide title="One moment…"><p className="ob-wait" role="status"><LoaderCircle className="animate-spin" aria-hidden="true" /><span>Loading your account.</span></p></Card>;
  if (error || (waiting && checks >= SETUP_CHECKS))
    return (
      <Card wide icon={<TriangleAlert />} title="Your drive isn't ready yet" lead="Your account is safe. Setting up the drive is taking longer than usual.">
        <ErrorNotice error={error} />
        <Button variant="default" className="ob-main" disabled={loading} onClick={() => { setChecks(0); reload(); }}>{loading ? "Checking…" : "Try again"}</Button>
      </Card>
    );
  if (waiting)
    return (
      <Card wide title="Setting up your drive" lead="This usually takes a few seconds. This step continues as soon as it is ready.">
        <p className="ob-wait" role="status"><LoaderCircle className="animate-spin" aria-hidden="true" /><span>Creating your first drive…</span></p>
      </Card>
    );
  return (
    <Card wide icon={<HardDrive />} title="There is no drive here yet" lead={canManage || !current
      ? "Create a drive first. This step stays on your Get started list."
      : `Ask an owner or admin of ${current.name} to share a drive with you.`}>
      <Button variant="default" className="ob-main" onClick={onDone}>Continue</Button>
    </Card>
  );
}

// POSIX single quotes also make a malformed server value inert when pasted into a shell.
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
type Snippet = "env" | "aws" | "rclone";
const SNIPPETS: { id: Snippet; label: string }[] = [
  { id: "env", label: "Environment variables" },
  { id: "aws", label: "AWS CLI" },
  { id: "rclone", label: "rclone" },
];
/** Copy-paste setup for an access key. `bucket` is the name the S3 gateway resolves to the drive. */
export function s3Snippet(kind: Snippet, key: Pick<KeySecret, "accessKeyId" | "secretAccessKey">, bucket: string, endpoint = S3_ENDPOINT): string {
  const id = quote(key.accessKeyId), secret = quote(key.secretAccessKey), url = quote(endpoint);
  if (kind === "env")
    return [`export AWS_ACCESS_KEY_ID=${id}`, `export AWS_SECRET_ACCESS_KEY=${secret}`, `export AWS_ENDPOINT_URL=${url}`, `export AWS_DEFAULT_REGION=${S3_REGION}`].join("\n");
  if (kind === "aws")
    return [
      `aws configure set aws_access_key_id ${id} --profile orbit`,
      `aws configure set aws_secret_access_key ${secret} --profile orbit`,
      `aws configure set region ${S3_REGION} --profile orbit`,
      `aws s3 ls ${quote(`s3://${bucket}/`)} --profile orbit --endpoint-url ${url}`,
    ].join("\n");
  return [
    `rclone config create orbit s3 provider=Other access_key_id=${id} secret_access_key=${secret} endpoint=${url} region=${S3_REGION}`,
    `rclone lsf ${quote(`orbit:${bucket}`)}`,
    // The gateway's ETag is not an MD5 of the file, so rclone's after-transfer comparison has to be turned off.
    `rclone copy --ignore-checksum ./notes.txt ${quote(`orbit:${bucket}`)}`,
  ].join("\n");
}

function ToolsStep({ drive, onDone, onSecret }: { drive: Drive; onDone: () => void; onSecret: (shown: boolean) => void }) {
  const { auth } = useAuth();
  const [secret, setSecret] = useState<KeySecret | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [tab, setTab] = useState<Snippet>("env");
  const readOnly = drive.access === "read";
  const bucket = drive.alias || drive.id;
  async function create() {
    setBusy(true);
    setError(undefined);
    try {
      const created = await auth.api.keys.create({ workspaceId: drive.orgId, label: "Getting started", access: readOnly ? "read" : "write", drives: [drive.id] });
      setSecret(created);
      onSecret(true);
      writeOnboarding({ keyCreated: true });
    } catch (reason) {
      setError(reason);
    } finally {
      setBusy(false);
    }
  }
  const copyFailed = () => setError("Could not copy. Select the text and copy it yourself.");
  if (!secret)
    return (
      <Card wide icon={<KeyRound />} title="Connect a tool or agent" lead={<>Create an access key for <strong>{drive.name}</strong>. Anything that speaks S3 can then {readOnly ? "read" : "read and write"} its files.</>}>
        <p className="ob-muted">The key works for this drive only. You can remove it at any time in Settings, under Access keys.</p>
        <ErrorNotice error={error} />
        <Button variant="default" className="ob-main" disabled={busy} onClick={() => void create()}>{busy ? "Creating key…" : "Create access key"}</Button>
      </Card>
    );
  const fields: [string, string][] = [
    ["Access key ID", secret.accessKeyId],
    ["Secret access key", secret.secretAccessKey],
    ["Endpoint", S3_ENDPOINT],
    ["Bucket", bucket],
  ];
  const snippet = s3Snippet(tab, secret, bucket);
  return (
    <Card wide icon={<KeyRound />} title="Save your secret now" lead="This is the only time the secret is shown. Copy it somewhere safe before you leave this page.">
      <dl className="ob-fields">
        {fields.map(([label, value]) => (
          <div key={label}><dt>{label}</dt><dd><code>{value}</code></dd><CopyButton text={value} label={`Copy ${label.toLowerCase()}`} onError={copyFailed} /></div>
        ))}
      </dl>
      <div className="ob-tabs" role="tablist" aria-label="Setup for">
        {SNIPPETS.map((item) => (
          <button key={item.id} type="button" role="tab" id={`ob-tab-${item.id}`} aria-selected={tab === item.id} aria-controls="ob-snippet" onClick={() => setTab(item.id)}>{item.label}</button>
        ))}
        <CopyButton text={snippet} label="Copy commands" onError={copyFailed}>Copy</CopyButton>
      </div>
      <div className="ob-snippet" role="tabpanel" id="ob-snippet" aria-labelledby={`ob-tab-${tab}`}>
        <pre><code>{snippet}</code></pre>
      </div>
      <ErrorNotice error={error} />
      <Button variant="default" className="ob-main" onClick={onDone}>I saved the secret</Button>
    </Card>
  );
}

interface UploadItem {
  id: number;
  file: File;
  state: "waiting" | "uploading" | "done" | "failed";
  progress?: UploadProgress;
  error?: unknown;
}
function uploadStatus(item: UploadItem): ReactNode {
  if (item.state === "done") return <><Check className="ob-good" aria-hidden="true" />Uploaded</>;
  if (item.state === "failed") return "Not uploaded";
  if (item.state === "waiting") return "Waiting";
  const phase = item.progress?.phase;
  return phase === "uploading" ? "Uploading…" : phase === "committing" ? "Saving…" : "Preparing…";
}

function BrowserStep({ drive, onDone }: { drive: Drive; onDone: () => void }) {
  const { auth } = useAuth();
  const api = useMemo(() => new DriveApi(auth.api, drive.id, "write"), [auth, drive.id]);
  const [items, setItems] = useState<UploadItem[]>([]);
  const [dragging, setDragging] = useState(false);
  const queue = useRef<UploadItem[]>([]);
  const running = useRef(false);
  const nextId = useRef(0);
  const readOnly = drive.access === "read";
  const update = (id: number, patch: Partial<UploadItem>) =>
    setItems((list) => list.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  async function run() {
    if (running.current) return;
    running.current = true;
    for (let item = queue.current.shift(); item; item = queue.current.shift()) {
      const { id, file } = item;
      update(id, { state: "uploading", error: undefined, progress: undefined });
      try {
        await uploadFile(api, file, file.name, (progress) => update(id, { progress }));
        update(id, { state: "done" });
        writeOnboarding({ uploaded: true });
      } catch (reason) {
        update(id, { state: "failed", error: reason });
      }
    }
    running.current = false;
  }
  function add(files: File[]) {
    if (readOnly || !files.length) return;
    const added = files.map((file): UploadItem => ({ id: nextId.current++, file, state: "waiting" }));
    queue.current.push(...added);
    setItems((list) => [...list, ...added]);
    void run();
  }
  function retry(item: UploadItem) {
    queue.current.push(item);
    update(item.id, { state: "waiting", error: undefined });
    void run();
  }
  // Files can be dropped anywhere on the page, and a missed drop never navigates away from it.
  const addRef = useRef(add);
  addRef.current = add;
  useEffect(() => {
    const hasFiles = (event: DragEvent) => Array.from(event.dataTransfer?.types || []).includes("Files");
    const over = (event: DragEvent) => { if (hasFiles(event)) { event.preventDefault(); setDragging(true); } };
    const leave = (event: DragEvent) => { if (!event.relatedTarget) setDragging(false); };
    const drop = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      setDragging(false);
      addRef.current(Array.from(event.dataTransfer?.files || []));
    };
    window.addEventListener("dragover", over);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragover", over);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", drop);
    };
  }, []);
  if (readOnly)
    return (
      <Card wide icon={<Upload />} title="You can view this drive" lead={<>Your role lets you open files in <strong>{drive.name}</strong>, not add them. Ask an owner or admin if you need to upload.</>}>
        <Button variant="default" className="ob-main" onClick={onDone}>Open your files</Button>
      </Card>
    );
  const active = items.some((item) => item.state === "waiting" || item.state === "uploading");
  const uploaded = items.filter((item) => item.state === "done").length;
  return (
    <Card wide icon={<Upload />} title="Add your first files" lead={<>They go into <strong>{drive.name}</strong>, where every change is kept as a version.</>}>
      <div className="ob-drop" data-dragging={dragging || undefined}>
        <Upload aria-hidden="true" />
        <strong>{dragging ? "Drop to upload" : "Drop files anywhere on this page"}</strong>
        <span className="ob-muted">Up to 3 GB per file in the browser. Use the Mac app for larger files.</span>
        <label className={buttonVariants({ variant: uploaded ? "outline" : "default" })}>
          {items.length ? "Add more files" : "Choose files"}
          <input type="file" multiple aria-label="Choose files to upload" onChange={(event) => { add(Array.from(event.target.files || [])); event.target.value = ""; }} />
        </label>
      </div>
      {items.length > 0 && (
        <ul className="ob-uploads" aria-label="Uploads">
          {items.map((item) => (
            <li key={item.id} data-state={item.state}>
              <span title={item.file.name}>{item.file.name}</span>
              <span role={item.state === "done" || item.state === "failed" ? "status" : undefined}>{uploadStatus(item)}</span>
              {item.state === "uploading" && <progress aria-label={`Upload progress for ${item.file.name}`} max={item.progress?.total || 1} value={item.progress?.bytes || 0} />}
              {item.state === "uploading" && item.progress && <span className="ob-muted">{formatBytes(item.progress.bytes)} of {formatBytes(item.progress.total)}</span>}
              {item.state === "failed" && <>
                <ErrorNotice error={item.error} />
                <button type="button" className="ob-link" onClick={() => retry(item)}>Try again</button>
              </>}
            </li>
          ))}
        </ul>
      )}
      {uploaded > 0 && <Button variant="default" className="ob-main" disabled={active} onClick={onDone}>{active ? "Uploading…" : "Open your files"}</Button>}
    </Card>
  );
}
