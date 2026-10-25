import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    maxWorkers: 1,
    testTimeout: 15_000,
    setupFiles: ["./test/setup.ts"],
    restoreMocks: true,
  },
});
