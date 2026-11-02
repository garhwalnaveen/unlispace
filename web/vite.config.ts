import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";
import { loadEnv } from "vite";
export default defineConfig(({ command, mode }) => {
  if (command === "build") {
    const endpoint = new URL(loadEnv(mode, process.cwd(), "VITE_").VITE_API_URL || "http://localhost");
    if (endpoint.protocol !== "https:" || ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname) || endpoint.username || endpoint.password)
      throw new Error("Production requires VITE_API_URL to point to a hosted HTTPS API.");
  }
  return {
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    environment: "jsdom",
    maxWorkers: 1,
    testTimeout: 15_000,
    setupFiles: ["./test/setup.ts"],
    restoreMocks: true,
  },
  };
});
