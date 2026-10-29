import { defineConfig, devices } from "@playwright/test";

const basePath = process.env.VITE_BASE_PATH || "/";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  use: { baseURL: `http://127.0.0.1:4175${basePath}`, trace: "retain-on-failure" },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
    { name: "mobile", use: { ...devices["iPhone 13"] } },
  ],
  webServer: {
    command: "npm run build && npm run preview -- --port 4175 --strictPort",
    url: `http://127.0.0.1:4175${basePath}`,
    reuseExistingServer: false,
  },
});
