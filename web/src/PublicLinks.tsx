import { useEffect, useState } from "react";
import { API_URL, errorMessage, jsonInit, readResponse, type Manifest } from "./api";
import { useAuth } from "./context";
import { assembleFile } from "./download";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";

type Share = { id:string; kind:"upload"|"download"; path:string; expiresAt:number; revokedAt:number|null; consumedAt:number|null };
export function LinkManager({ driveId, folder, file, canWrite }: { driveId:string; folder:string; file?:string; canWrite:boolean }) {
 const {auth} = useAuth(); const [open,setOpen] = useState(false); const [links,setLinks] = useState<Share[]>([]); const [name,setName] = useState(""); const [url,setUrl] = useState(""); const [error,setError] = useState("");
 const base = `/drives/${encodeURIComponent(driveId)}/links`;
 const refresh = async () => setLinks((await auth.api.request<{links:Share[]}>(base)).links);
 useEffect(() => { if (open) void refresh().catch(e => setError(errorMessage(e))); }, [open, driveId]); // eslint-disable-line react-hooks/exhaustive-deps
 async function create(kind:"upload"|"download", path:string) {
  setError(""); setUrl("");
  try { const result = await auth.api.request<{token:string}>(base,jsonInit("POST",{kind,path,expiresAt:Date.now()+7*86400000})); setUrl(`${window.location.origin}/share#${result.token}`); await refresh(); }
  catch(e) { setError(errorMessage(e)); }
 }
 return <section className="public-links"><Button size="sm" onClick={() => setOpen(!open)}>{file ? "Share file" : "Public links"}</Button>{open && <div className="public-links-panel">
  <h3>Public links</h3><p>Anyone with a link can use it. Links expire after 7 days. Public downloads support files up to 512 MB.</p>
  {file && <Button size="sm" onClick={() => void create("download",file)}>Create download link</Button>}
  {canWrite && !file && <form onSubmit={e => {e.preventDefault(); if (name && !name.includes("/")) void create("upload",folder+name); else setError("Enter a single file name.");}}><label>Requested file name <Input value={name} onChange={e=>setName(e.target.value)} required /></label> <Button size="sm" type="submit">Create upload request</Button><p>One upload up to 16 MB; an existing file cannot be overwritten.</p></form>}
  {url && <p>Copy and share this link: <Input aria-label="Public link" readOnly value={url} onFocus={e=>e.currentTarget.select()} /> <Button size="sm" onClick={() => void (async () => { try { await navigator.clipboard.writeText(url); } catch { setError("Could not copy. Select the link and copy it manually."); } })()}>Copy</Button></p>}
  {error && <p role="alert">{error}</p>}
  <ul>{links.filter(l => !l.revokedAt && !l.consumedAt && l.expiresAt>Date.now() && (!file || l.path===file)).map(l=><li key={l.id}>{l.kind === "upload" ? "Upload request" : "Download"}: {l.path} · expires {new Date(l.expiresAt).toLocaleDateString()} <Button size="sm" onClick={() => void auth.api.request(`${base}/${encodeURIComponent(l.id)}`,{method:"DELETE"}).then(refresh).catch(e=>setError(errorMessage(e)))}>Revoke</Button></li>)}</ul>
 </div>}</section>;
}
type Info = {kind:"upload"|"download";name:string;expiresAt:number;maxBytes?:number;manifest?:Manifest};
export function PublicLinkPage() {
 const token = window.location.hash.slice(1); const [info,setInfo] = useState<Info>(); const [error,setError] = useState(""); const [busy,setBusy] = useState(false); const [done,setDone] = useState(false); const [file,setFile] = useState<File>();
 const base = `${API_URL}/public`;
 const headers = { authorization: `Bearer ${token}` };
 useEffect(() => { void fetch(`${base}/link`, { headers }).then(r => readResponse<Info>(r)).then(setInfo).catch(() => setError("This link is unavailable or has expired.")); }, [base]);
 async function download() { if (!info?.manifest) return; setBusy(true); setError(""); try { const blob = await assembleFile(info.manifest, async hash => { const r=await fetch(`${base}/shards/${hash}`, { headers }); if (!r.ok) throw new Error("The link is unavailable."); return r.arrayBuffer(); }, () => {}); const url=URL.createObjectURL(blob); const a=document.createElement("a"); a.href=url; a.download=info.name; a.click(); setTimeout(()=>URL.revokeObjectURL(url),30000); } catch(e) {setError(errorMessage(e));} finally {setBusy(false);} }
 async function upload() { if (!file || !info) return; setBusy(true); setError(""); try { if (file.size > (info.maxBytes ?? 0)) throw new Error("This file exceeds the 16 MB limit."); await readResponse(await fetch(`${base}/upload`,{method:"POST",body:file,headers:{...headers,"content-type":"application/octet-stream"}})); setDone(true); } catch(e) {setError(errorMessage(e));} finally {setBusy(false);} }
 return <section><h1>{info?.kind === "upload" ? "Upload a file" : "Shared file"}</h1>{info && <><p>{info.name} · expires {new Date(info.expiresAt).toLocaleString()}</p>{info.kind === "download" ? <Button disabled={busy} onClick={() => void download()}>Download</Button> : done ? <p>Upload complete.</p> : <><p>One file, up to 16 MB.</p><label>Choose a file<Input type="file" onChange={e=>setFile(e.target.files?.[0])} /></label><Button disabled={!file || busy} onClick={() => void upload()}>Upload</Button></>}</>}{error && <p role="alert">{error}</p>}{!info && !error && <p>Loading…</p>}</section>;
}
