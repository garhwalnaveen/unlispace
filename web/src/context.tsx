import { createContext, useContext, useSyncExternalStore } from "react";
import type { AuthStore } from "./auth";
export const AuthContext = createContext<AuthStore | null>(null);
export function useAuth() {
  const auth = useContext(AuthContext);
  if (!auth) throw new Error("Missing auth provider.");
  const state = useSyncExternalStore(auth.subscribe, auth.getSnapshot);
  return { auth, ...state };
}
