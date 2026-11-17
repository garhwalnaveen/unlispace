import { Navigate } from "react-router-dom";
import { writeOnboarding } from "./state";

/** Post-sign-up welcome flow. Placeholder until the onboarding work lands: marks setup done and goes home. */
export function Welcome() {
  writeOnboarding({ status: "done" });
  return <Navigate to="/" replace />;
}
