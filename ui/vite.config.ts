import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { execFileSync } from "node:child_process";
import { createReadStream, existsSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";

/**
 * `npm run dev:local` serves a locally collected dataset at /local-data/ and
 * points the app at it, so data produced by scripts/check.py or
 * scripts/upstream.py can be inspected before it is published. The directory
 * defaults to ../data/local-preview and can be changed with LOCAL_DATA_DIR.
 * Only the dev server uses this; production builds read the published pointer.
 */
function localData(dir: string): Plugin {
  const root = resolve(dir);
  return {
    name: "local-dataset",
    configureServer(server) {
      server.middlewares.use("/local-data", (req, res, next) => {
        const path = decodeURIComponent((req.url ?? "/").split("?")[0]);
        const file = resolve(root, `.${path}`);
        if (!(file === root || file.startsWith(root + sep)) || !file.endsWith(".json")) return next();
        if (!existsSync(file) || !statSync(file).isFile()) {
          res.statusCode = 404;
          return res.end();
        }
        res.setHeader("Content-Type", "application/json");
        res.setHeader("Cache-Control", "no-store");
        createReadStream(file).pipe(res);
      });
    },
  };
}

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

export default defineConfig(({ mode }) => {
  const local = mode === "local-data";
  return {
  plugins: [
    tailwindcss(),
    react(),
    ...(local ? [localData(process.env.LOCAL_DATA_DIR || "../data/local-preview")] : []),
  ],
  base: process.env.VITE_BASE_PATH || "/",
  define: {
    __UI_COMMIT__: JSON.stringify(uiRevision()),
    ...(local ? { "import.meta.env.VITE_LOCAL_DATA": JSON.stringify("/local-data/") } : {}),
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test-setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
  },
};
});
