import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { execFileSync } from "node:child_process";
import { defineConfig } from "vitest/config";

function uiRevision(): string | null {
  let revision = process.env.GITHUB_SHA;
  if (!revision) {
    try {
      revision = execFileSync("git", ["rev-parse", "HEAD"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      return null;
    }
  }
  if (!/^[a-f0-9]{40}$/.test(revision)) {
    throw new Error("UI revision must be a full Git commit hash");
  }
  return revision;
}

export default defineConfig({
  plugins: [tailwindcss(), react()],
  base: process.env.VITE_BASE_PATH || "/",
  define: { __UI_COMMIT__: JSON.stringify(uiRevision()) },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test-setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
