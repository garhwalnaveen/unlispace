import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
import { AuthStore } from "./auth";
import { AuthContext } from "./context";
import "./styles.css";
const auth = new AuthStore();
void auth.start();
createRoot(document.getElementById("root")!).render(
  <BrowserRouter>
    <AuthContext value={auth}>
      <App />
    </AuthContext>
  </BrowserRouter>,
);
