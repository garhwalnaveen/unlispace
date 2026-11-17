import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Drive, Org, Workspace } from "../api";
import { useAuth } from "../context";

const CURRENT_KEY = "orbit.workspace";
const LAST_DRIVE_KEY = "orbit.lastDrive";

export interface WorkspaceState {
  orgs: Org[];
  /** Entitlements from /me/access; empty when that request fails. */
  workspaces: Workspace[];
  current: Org | null;
  access: Workspace | null;
  /** Drives of the current workspace that are not deleted. */
  drives: Drive[];
  canManage: boolean;
  loading: boolean;
  loaded: boolean;
  error: unknown;
  setCurrent: (orgId: string) => void;
  reload: () => void;
}
const WorkspaceContext = createContext<WorkspaceState | null>(null);

export function useWorkspace(): WorkspaceState {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error("Missing workspace provider.");
  return value;
}
export const lastDrive = () => localStorage.getItem(LAST_DRIVE_KEY);
export const rememberDrive = (id: string) => localStorage.setItem(LAST_DRIVE_KEY, id);

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const { auth } = useAuth();
  const [orgs, setOrgs] = useState<Org[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<unknown>();
  const [revision, setRevision] = useState(0);
  const [currentId, setCurrentId] = useState(() => localStorage.getItem(CURRENT_KEY));
  const generation = useRef(0);
  useEffect(() => {
    const run = ++generation.current;
    setLoading(true);
    setError(undefined);
    // Readiness comes from /me/access; if it is unavailable the drive list still works from /orgs.
    const access = auth.api.access().then((value) => (Array.isArray(value?.workspaces) ? value.workspaces : []), () => []);
    void Promise.all([auth.api.orgs(), access])
      .then(([list, entitlements]) => {
        if (run !== generation.current) return;
        setOrgs(Array.isArray(list?.orgs) ? list.orgs : []);
        setWorkspaces(entitlements);
        setLoaded(true);
      })
      .catch((reason) => { if (run === generation.current) setError(reason); })
      .finally(() => { if (run === generation.current) setLoading(false); });
    return () => { ++generation.current; };
  }, [auth, revision]);
  const setCurrent = useCallback((orgId: string) => {
    localStorage.setItem(CURRENT_KEY, orgId);
    setCurrentId(orgId);
  }, []);
  const reload = useCallback(() => setRevision((value) => value + 1), []);
  const value = useMemo<WorkspaceState>(() => {
    const current = orgs.find((org) => org.id === currentId) ?? orgs[0] ?? null;
    return {
      orgs, workspaces, current,
      access: workspaces.find((item) => item.id === current?.id) ?? null,
      drives: current?.drives.filter((drive) => drive.status !== "deleted") ?? [],
      canManage: current?.role === "owner" || current?.role === "admin",
      loading, loaded, error, setCurrent, reload,
    };
  }, [orgs, workspaces, currentId, loading, loaded, error, setCurrent, reload]);
  return <WorkspaceContext value={value}>{children}</WorkspaceContext>;
}
