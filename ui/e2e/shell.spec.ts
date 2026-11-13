import { expect, test } from "@playwright/test";

// Baseline table/popup scenarios use desktop dimensions; responsive cases override this.
test.use({ viewport: { width: 1440, height: 1000 } });
import {
  index,
  indexUrl,
  overview,
  pointer,
  historyFixture,
} from "../src/fixtures";
import { producerReport } from "../src/builds/fixtures";

const linuxBuild = {
  ...historyFixture().builds[0],
  channel: "stable" as const,
  results: { "T0.1": "warn" },
};

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-11-02T15:00:00Z"));
  await page.route("https://raw.githubusercontent.com/**", async (route) => {
    const url = route.request().url();
    let data: unknown;
    if (url.endsWith("/main/data/latest.json")) data = pointer;
    else if (url === indexUrl) data = index;
    else if (url === new URL("rocm/10.1/overview.json", indexUrl).href)
      data = overview();
    else if (url === new URL("rocm/10.2/overview.json", indexUrl).href)
      data = overview("10.2");
    else if (url.endsWith("/history/2026-10.json"))
      {
        const history = historyFixture(url.match(/\/rocm\/([^/]+)\//)?.[1]);
        data = { ...history, builds: history.builds.map((build) =>
          build.build_id === linuxBuild.build_id ? { ...build, results: linuxBuild.results } : build) };
      }
    else if (url === historyFixture().builds[0].report_url) data = producerReport(linuxBuild);
    else return route.fulfill({ status: 404, body: "{}" });
    await route.fulfill({ json: data });
  });
});

test("overview build marks open qualification and the exact package popup", async ({ page }) => {
  await page.goto("./?version=10.1&view=overview&platform=windows");
  await expect(
    page
      .getByRole("region", { name: "ROCm 10.1", exact: true })
      .getByRole("region", {
        name: "llama.cpp stable build history",
        exact: true,
      })
      .getByRole("heading", { name: "Linux", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Linux", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("region", { name: "ROCm 10.1", exact: true })
    .getByRole("link", { name: /b11972.*linux-build/ })
    .click();
  await expect(page).toHaveURL(/focus=day/);
  await expect(page.getByRole("heading", { name: "Package qualification" })).toBeVisible();
  const details = page.getByRole("button", { name: "Run details for b11972", exact: true }).first();
  await details.click();
  const popup = page.getByRole("dialog");
  await expect(popup.getByText("linux-build", { exact: true })).toBeVisible();
  await expect(popup.getByRole("link", { name: /View record source/ })).toHaveAttribute("href", historyFixture().builds[0].report_url);
  await popup.getByRole("button", { name: "Close popup" }).click();
  await page.getByRole("link", { name: "Build Qualification", exact: true }).click();
  await expect(page.getByRole("button", { name: "Linux", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "Windows", exact: true })).toHaveAttribute("aria-pressed", "true");
});

test("pins data, switches versions and restores scope through browser history", async ({
  page,
}) => {
  const reads: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("raw.githubusercontent.com"))
      reads.push(request.url());
  });
  await page.goto("./");
  await expect(
    page.getByRole("heading", { name: "ROCm Readiness" }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("region", { name: "ROCm 10.1", exact: true })
      .getByRole("heading", { name: "llama.cpp", exact: true }),
  ).toBeVisible();
  const pointerReads = reads.filter((url) =>
    url.endsWith("/main/data/latest.json"),
  ).length;
  await expect(page.getByLabel("ROCm version")).toHaveCount(0);

  await expect(page.locator(".build-legend")).toHaveCount(0);
  await page.getByRole("link", { name: "Build Qualification", exact: true }).click();
  await page.getByRole("group", { name: "ROCm version" }).getByRole("button", { name: "10.2", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Build Qualification" }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Build Qualification", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Build Qualification", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Windows", exact: true }).click();
  await expect(page).toHaveURL(/platform=linux/);
  await expect(page.getByRole("button", { name: "Windows", exact: true })).toHaveAttribute("aria-pressed", "false");
  await page.getByLabel("Find build").fill("linux-build");
  await expect(page).toHaveURL(/build_filter=linux-build/);
  const tiers = page.locator(".qualification-tier-summaries").filter({ hasText: "T0" });
  await expect(tiers.getByRole("link")).toHaveCount(0);
  await expect(tiers.getByText("T0", { exact: true })).toBeVisible();
  const check = tiers.getByRole("button", { name: "T0.1 · Warn", exact: true });
  await check.focus();
  const tooltip = page.getByRole("tooltip");
  await expect(tooltip.getByText("extra binary")).toBeVisible();
  await expect(tooltip.getByText("12 ms")).toBeVisible();
  await expect(tooltip.getByText("ROCm 10.1", { exact: true }).first()).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(tooltip).toHaveCount(0);
  expect(reads.filter((url) => url.endsWith("/main/data/latest.json"))).toHaveLength(pointerReads);
  const shared = new URL(page.url());
  for (const [key, value] of Object.entries({ view: "build", build: "linux-build", tier: "tier0", check: "1" }))
    shared.searchParams.set(key, value);
  await page.goto(shared.href);
  await expect(tooltip.getByText("hipblas missing", { exact: true })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.goBack();
  await expect(page).toHaveURL(/view=engine.*platform=linux/);
  await expect(page.getByRole("button", { name: "Linux", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "Windows", exact: true })).toHaveAttribute("aria-pressed", "false");
  expect(
    reads
      .filter(
        (url) =>
          url.includes("/rocm-readiness/") &&
          !url.endsWith("/main/data/latest.json"),
      )
      .every((url) => url.includes(`/${pointer.data_commit}/data/`)),
  ).toBe(true);
});

test("keeps the current UTC date visible when the selected version has no build today", async ({ page }) => {
  await page.route(new URL("rocm/10.2/history/2026-10.json", indexUrl).href, (route) => {
    const history = historyFixture("10.2");
    return route.fulfill({ json: { ...history, builds: history.builds.map((build) => ({ ...build, channel: "nightly" })) } });
  });
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto("./?view=engine");
  const trend = page.getByRole("region", { name: "Daily qualification charts" });
  const stable = trend.getByRole("list", { name: "Stable packages by day · Linux" });
  await expect(stable.getByRole("listitem")).toHaveCount(14);
  const nightly = trend.getByRole("list", { name: "Nightly packages by day · Linux" });
  await expect(nightly).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  if (page.viewportSize()!.width <= 640) await page.getByRole("button", { name: /^Qualification filters/ }).click();
  await expect(page.getByRole("button", { name: "10.1", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "All versions" })).toHaveCount(0);
  await expect(stable.getByText("October 30, 2026", { exact: true })).toBeVisible();
  await expect(stable.getByText("November 2, 2026", { exact: true })).toBeVisible();
  const today = stable.getByRole("button", { name: "2026-11-02 UTC · 0 packages · Linux", exact: true });
  await expect(today).toBeAttached();
  await page.getByRole("button", { name: "10.2" }).click();
  await expect(page).toHaveURL(/version=10.2/);
  await expect(stable).toHaveCount(0);
  const nightlyToday = nightly.getByRole("button", { name: "2026-11-02 UTC · 0 packages · Linux", exact: true });
  await expect(nightlyToday).toBeAttached();
  await nightly.getByRole("button", { name: /2026-10-29 UTC.*Linux/ }).click();
  await expect(page).toHaveURL(/day=2026-10-29/);
  await expect(page.getByRole("heading", { name: "Package qualification" })).toBeVisible();
  const mobileFilters = page.getByRole("button", { name: /^Qualification filters/ });
  if (await mobileFilters.getAttribute("aria-expanded") === "false") await mobileFilters.click();
  await page.getByRole("button", { name: "Reset filters" }).click();
  await expect(nightlyToday).toBeAttached();
});

test("keeps usable data when ingestion fails or a refresh request fails", async ({
  page,
}) => {
  await page.route("**/main/data/latest.json", (route) =>
    route.fulfill({
      json: {
        ...pointer,
        sync: {
          ...pointer.sync,
          status: "failed",
          errors: [
            {
              source_id: "stable",
              record: "",
              field: "feed",
              reason: "Controlled feed failure",
            },
          ],
        },
      },
    }),
  );
  await page.route("**/history/*.json", (route) =>
    route.fulfill({ status: 503, body: "{}" }),
  );
  await page.goto("./");
  await expect(
    page.getByText("Latest ingestion failed", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "ROCm Readiness" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Retry history" }),
  ).toBeVisible();
  await page.route("**/main/data/latest.json", (route) =>
    route.fulfill({ status: 503, body: "{}" }),
  );
  await page.getByRole("button", { name: "Retry history" }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "HTTP 503" }).first(),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "ROCm Readiness" }),
  ).toBeVisible();
});

test("recovers from an initial malformed pointer and represents empty data", async ({
  page,
}) => {
  await page.route("**/main/data/latest.json", (route) =>
    route.fulfill({ json: {} }),
  );
  await page.goto("./");
  await expect(page.getByRole("alert")).toContainText("schema_version");
  await page.route("**/main/data/latest.json", (route) =>
    route.fulfill({ json: pointer }),
  );
  await page.route(indexUrl, (route) =>
    route.fulfill({
      json: {
        ...index,
        default_version: null,
        readiness: { stable_anchor: "10.1", versions: [] },
        versions: [],
      },
    }),
  );
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "No ROCm versions available" }),
  ).toBeVisible();
});

test("has a keyboard skip link and fits the viewport", async ({
  page,
  browserName,
}, testInfo) => {
  await page.goto("./");
  await expect(
    page.getByRole("heading", { name: "ROCm Readiness" }),
  ).toBeVisible();
  await page.keyboard.press(browserName === "webkit" ? "Alt+Tab" : "Tab");
  await expect(
    page.getByRole("link", { name: "Skip to content" }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("main")).toBeFocused();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("overview-fixture.png"),
    fullPage: true,
  });
});

test("overview shows qualification without benchmark status", async ({
  page,
}) => {
  const o = overview();
  await page.route("**/rocm/10.1/overview.json", (route) =>
    route.fulfill({
      json: {
        ...o,
        execution: {
          path: "rocm/10.1/executions.json",
          attempt_count: 1,
          summaries: [],
        },
      },
    }),
  );
  await page.goto("./");
  const version = page.getByRole("region", { name: "ROCm 10.1", exact: true });
  await expect(version.locator(".build-mark.pass").first()).toBeVisible();
  await expect(
    version.getByRole("columnheader", { name: "October 2026" }),
  ).toHaveAttribute("colspan", "12");
  await expect(
    version.getByRole("columnheader", { name: "November 2026" }),
  ).toHaveAttribute("colspan", "2");
  const mark = version.locator(".build-mark.pass").first();
  await mark.scrollIntoViewIfNeeded();
  await mark.focus();
  await expect(mark).not.toHaveAttribute("title");
  const tooltip = page.getByRole("dialog");
  await expect(tooltip).toBeVisible();
  await expect(tooltip.getByRole("link", { name: "View qualification details" })).toBeVisible();
  const box = await tooltip.boundingBox();
  const viewport = page.viewportSize()!;
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height);
  await mark.press("Escape");
  await expect(tooltip).toHaveCount(0);

  await expect(page.locator(".build-benchmark-issue")).toHaveCount(0);
  await expect(
    page.getByText(/Inspect benchmark attempts|Benchmark execution|Bench fail/),
  ).toHaveCount(0);
});

for (const theme of ["light", "dark"] as const) {
  for (const width of [390, 1440]) {
    test(`renders collected evidence without producer requests at ${width}px in ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme: theme });
      const producerReads: string[] = [];
      page.on("request", (request) => {
        if (request.url() === linuxBuild.report_url) producerReads.push(request.url());
      });
      const path = "reports/" + "a".repeat(64) + ".json";
      const report = producerReport(linuxBuild, { tiers: { tier1: {
          tier_name: "Runtime", status: "pass", tests: [{
            id: "T1.1", name: "Collected accelerator check", source_index: 0, status: "pass",
            display_evidence: [{ label: "GPU execution", value: "Recorded by collection CI" }],
            details: { requested_offload_line: "offloaded 29/29 layers to GPU" },
          }],
        } } });
      await page.route("**/data/" + path, async (route) => {
        await route.fulfill({ json: { source_url: linuxBuild.report_url, report } });
      });
      await page.route("**/history/2026-10.json", async (route) => {
        const history = historyFixture();
        await route.fulfill({ json: { ...history, builds: history.builds.map((build) =>
          build.build_id === linuxBuild.build_id ? { ...build,
            report_snapshot: { source_url: build.report_url, path } } : build) } });
      });
      await page.goto("./?version=10.1&view=build&build=linux-build&tier=tier1&check=0");
      const tooltip = width <= 540 ? page.getByRole("region", { name: "T1.1 · Pass", exact: true }) : page.getByRole("tooltip");
      await expect(tooltip.getByText("GPU execution", { exact: true })).toBeVisible();
      await expect(tooltip.getByText("Recorded by collection CI", { exact: true })).toBeVisible();
      await expect(tooltip.getByText("GPU offload", { exact: true })).toHaveCount(0);
      expect(producerReads).toEqual([]);
      await expect.poll(() => tooltip.evaluate((element) => {
        const box = element.getBoundingClientRect();
        return { left: box.left, right: box.right, viewport: window.innerWidth,
          fits: box.left >= 0 && box.right <= window.innerWidth };
      })).toMatchObject({ fits: true });
    });
  }
}

test("reset and date-scope removal preserve an implicitly selected historical window", async ({ page }) => {
  await page.goto("./?view=engine&version=10.1&day=2026-10-01&focus=day");
  await page.getByRole("button", { name: "Clear Date: October 1, 2026", exact: true }).click();
  await expect(page).toHaveURL(/through=2026-10-01/);
  await expect(page).not.toHaveURL(/day=/);
  await page.goto("./?view=engine&version=10.1&day=2026-10-01&focus=day");
  await page.getByRole("button", { name: "Reset filters", exact: true }).click();
  await expect(page).toHaveURL(/through=2026-10-01/);
  await expect(page).not.toHaveURL(/day=/);
});
