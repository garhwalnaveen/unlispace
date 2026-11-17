import { HardDrive } from "lucide-react";
import { useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { Button } from "../components/ui/button";
import { useAuth } from "../context";
import { DriveDialog } from "../DriveTools";
import { driveLink } from "../links";
import { readOnboarding } from "../onboarding/state";
import { ErrorNotice, Loading } from "../ui";
import { lastDrive, useWorkspace } from "./workspace";

/** Signed-in `/`: files are home, so this forwards to the drive the person last used. */
export function Home() {
  const { auth } = useAuth();
  const workspace = useWorkspace();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const { current, drives, canManage } = workspace;
  if (workspace.error && !workspace.loaded)
    return <section className="empty-state"><h1>Your files could not be loaded</h1><ErrorNotice error={workspace.error} /><Button onClick={workspace.reload}>Try again</Button></section>;
  if (!workspace.loaded) return <Loading>Loading your files…</Loading>;
  if (readOnboarding()?.status === "pending") return <Navigate to="/welcome" replace />;
  const ready = drives.filter((drive) => drive.status === "ready");
  const target = ready.find((drive) => drive.id === lastDrive()) ?? ready[0];
  if (target) return <Navigate to={driveLink(target.id)} replace />;
  const settingUp = drives.length > 0;
  return (
    <section className="empty-state">
      <span className="empty-symbol" aria-hidden="true"><HardDrive /></span>
      {!current ? <>
        <h1>You are not in a workspace yet</h1>
        <p>Ask a workspace owner to invite you, then open the link in the invitation email.</p>
      </> : settingUp ? <>
        <h1>Your drive is being set up</h1>
        <p>This usually takes a few seconds. Your files will appear here when it is ready.</p>
        <Button variant="outline" onClick={workspace.reload}>Check again</Button>
      </> : canManage ? <>
        <h1>Create your first drive</h1>
        <p>A drive is a folder in the cloud. It opens in Finder on your Mac, in this browser, and from your tools and agents.</p>
        <Button onClick={() => setCreating(true)}>Create a drive</Button>
      </> : <>
        <h1>No drives shared with you yet</h1>
        <p>Drives that {current.name} shares with you appear here. Ask an owner or admin for access.</p>
      </>}
      {creating && current && (
        <DriveDialog action={{ kind: "create", org: current }} api={auth.api} onClose={() => setCreating(false)} onDone={(created) => {
          setCreating(false);
          workspace.reload();
          if (created) navigate(driveLink(created.id));
        }} />
      )}
    </section>
  );
}
