import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
import { AuthStore } from "./auth";
import { AuthContext } from "./context";
import "./styles.css";
// OAuth callbacks and browser CORS use the API's configured web origin.
if (import.meta.env.PROD && window.location.hostname === "orbit-web.naveen-f3d.workers.dev") {
  window.location.replace(`https://orbitfs.io${window.location.pathname}${window.location.search}${window.location.hash}`);
} else {
const auth = new AuthStore();
void auth.start();
createRoot(document.getElementById("root")!).render(
  <BrowserRouter>
    <AuthContext value={auth}>
      <App />
    </AuthContext>
  </BrowserRouter>,
);
}
