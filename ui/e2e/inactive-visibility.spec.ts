import { expect, test, type Page } from "@playwright/test";
import { fixtureFetch, historyFixture, index, indexUrl, overview } from "../src/fixtures";
import { upstreamOverview } from "../src/upstream/fixtures";
import type { UpstreamOverview } from "../src/upstream/data";

const upstreamUrl = new URL("upstream/overview.json", indexUrl).href;
const historyUrl = (version: string) => new URL(`rocm/${version}/history/2026-10.json`, indexUrl).href;

function visibilityFixtures(allOld = false): Record<string, unknown> {
  const overrides: Record<string, unknown> = {
    [indexUrl]: { ...index, upstream: { schema_version: 1, overview: "upstream/overview.json", project_count: 2, status: "fresh" } },
  };
  for (const version of ["10.1", "10.2"]) {
    const history = historyFixture(version);
    history.builds = history.builds.map((build, position) => ({
      ...build,
      generated_at: !allOld && version === "10.1" && position === 0 ? "2026-10-20T00:00:00Z" : "2026-10-19T23:59:59Z",
      qualified: false,
      overall: "fail",
    }));
    const versionOverview = overview(version);
    versionOverview.engines[0].latest_builds = [history.builds[0]];
    overrides[new URL(`rocm/${version}/overview.json`, indexUrl).href] = versionOverview;
    overrides[historyUrl(version)] = history;
  }
  const upstream = structuredClone(upstreamOverview) as UpstreamOverview;
  upstream.generated_at = "2026-11-02T12:00:00Z";
  upstream.window = { start: "2026-10-04", end: "2026-11-02", days: 30 };
  const project = upstream.projects[0];
  const observed = { passed: 0, failed: 1, running: 0, other: 0, stalled: 0, skipped: 0, slow: 0 };
  project.jobs[0].daily = { [allOld ? "2026-10-19" : "2026-10-20"]: observed };
  project.jobs[1].daily = { "2026-10-19": observed };
  project.files = [];
  upstream.projects[1] = {
    ...project, id: "inactive-project", label: "Inactive upstream project", files: [],
    jobs: [{ ...project.jobs[1], id: "inactive-job", label: "Inactive upstream job" }],
  };
  overrides[upstreamUrl] = upstream;
  return overrides;
}

async function routeFixtures(page: Page, overrides: Record<string, unknown>) {
  const fixture = fixtureFetch(overrides);
  await page.route("https://raw.githubusercontent.com/**", async (route) => {
    const response = await fixture(route.request().url());
    await route.fulfill({ status: response.status, body: await response.text(), contentType: "application/json" });
  });
}

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-11-02T15:00:00Z"));
});

for (const theme of ["light", "dark"] as const) {
  for (const width of [390, 1440]) {
    test(`inactive rows stay hidden and recent failures remain at ${width}px in ${theme}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 1000 });
      await page.emulateMedia({ colorScheme: theme });
      await routeFixtures(page, visibilityFixtures());
      await page.goto("./");
      const stable = page.getByRole("region", { name: "ROCm 10.1", exact: true });
      await expect(stable).toBeVisible();
      await expect(stable.getByRole("link", { name: /2026-10-20T00:00:00Z · Failed/ })).toBeVisible();
      await expect(page.getByRole("region", { name: "ROCm 10.2", exact: true })).toHaveCount(0);
      await expect(stable.getByRole(width <= 540 ? "columnheader" : "rowheader", { name: "Windows", exact: true })).toHaveCount(0);
      await expect(stable.getByRole(width <= 540 ? "columnheader" : "rowheader", { name: "Linux", exact: true })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath("readiness-active-only.png"), fullPage: true });

      await page.goto("./?track=upstream");
      await expect(page.getByRole("heading", { name: "llama.cpp", exact: true })).toBeVisible();
      await expect(page.getByRole("heading", { name: "Inactive upstream project", exact: true })).toHaveCount(0);
      const calendar = page.getByRole("region", { name: "llama.cpp activity calendar", exact: true });
      await expect(calendar.getByRole("button", { name: "2026-10-20: 0 passed, 1 failed of 1 runs", exact: true })).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath("upstream-active-only.png"), fullPage: true });
      await page.goto("./?track=upstream&view=ci&project=llamacpp");
      await expect(page.getByRole("heading", { name: "llama.cpp", exact: true })).toBeVisible();
      const jobs = page.getByRole("region", { name: "CI jobs", exact: true });
      await expect(jobs).not.toContainText("models-check vulkan-amd");
      await expect(jobs).toContainText("gpu-rocm");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath("upstream-jobs-active-only.png"), fullPage: true });
    });
  }
}

test("all inactive data has an explicit empty state", async ({ page }) => {
  await routeFixtures(page, visibilityFixtures(true));
  await page.goto("./");
  await expect(page.getByText("No qualification build records are available in the last 14 days.", { exact: true })).toBeVisible();
  await page.goto("./?track=upstream");
  await expect(page.getByText("No upstream observations in the last 14 days.", { exact: true })).toBeVisible();
});

test("missing recent data does not conceal collection and history errors", async ({ page }) => {
  const overrides = visibilityFixtures(true);
  const upstream = overrides[upstreamUrl] as UpstreamOverview;
  upstream.projects[0].coverage = { complete: false, error: "Collection fixture could not read the producer" };
  await routeFixtures(page, overrides);
  await page.route(historyUrl("10.1"), (route) => route.fulfill({ status: 503, body: "{}", contentType: "application/json" }));
  await page.goto("./");
  await expect(page.getByText(/Qualification history unavailable:/)).toBeVisible();
  await page.goto("./?track=upstream");
  await expect(page.getByRole("heading", { name: "llama.cpp", exact: true })).toBeVisible();
  await expect(page.getByText("Collection failed. The displayed results may be incomplete.", { exact: true })).toBeVisible();
});
