import { expect, test } from "@playwright/test";
import {
  index,
  indexUrl,
  overview,
  pointer,
  historyFixture,
} from "../src/fixtures";

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
      data = historyFixture(url.match(/\/rocm\/([^/]+)\//)?.[1]);
    else return route.fulfill({ status: 404, body: "{}" });
    await route.fulfill({ json: data });
  });
});

test("overview build marks open qualification and the exact package review", async ({ page }) => {
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
  await details.hover();
  const report = page.getByRole("link", { name: "Package report for linux-build", exact: true });
  await report.hover();
  await expect(report).toBeVisible();
  await report.click();
  await page.getByRole("link", { name: /Build review/ }).click();
  await expect(page).toHaveURL(/view=build/);
  await expect(page).toHaveURL(/build=linux-build/);
  await expect(
    page.getByRole("heading", { name: "Build review", exact: true }),
  ).toBeVisible();
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
  await page.getByRole("button", { name: "Run details for b11972", exact: true }).first().click();
  await page.getByRole("link", { name: "Package report for linux-build", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Build evidence", exact: true }),
  ).toBeVisible();
  expect(
    reads.filter((url) => url.endsWith("/main/data/latest.json")),
  ).toHaveLength(pointerReads);
  const shared = page.url();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Build evidence", exact: true }),
  ).toBeVisible();
  await expect(page).toHaveURL(shared);
  await page.goBack();
  await expect(page).toHaveURL(/view=engine.*platform=linux/);
  await expect(page.getByRole("button", { name: "Linux", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "Windows", exact: true })).toHaveAttribute("aria-pressed", "false");
  await page.goForward();
  await expect(page).toHaveURL(/view=build/);
  await expect(
    page.getByRole("heading", { name: "Build evidence", exact: true }),
  ).toBeVisible();
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
  await expect(page.getByRole("button", { name: "10.1", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "All versions" })).toHaveCount(0);
  await expect(stable.locator("..").getByText("October", { exact: true })).toBeVisible();
  await expect(stable.locator("..").getByText("November", { exact: true })).toBeVisible();
  const today = stable.getByRole("button", { name: "2026-11-02 UTC · 0 packages · Linux", exact: true });
  await expect(today).toBeAttached();
  await page.getByRole("button", { name: "10.2" }).click();
  await expect(page).toHaveURL(/version=10.2/);
  await expect(stable).toHaveCount(0);
  const nightlyToday = nightly.getByRole("button", { name: "2026-11-02 UTC · 0 packages · Linux", exact: true });
  await expect(nightlyToday).toBeAttached();
  await nightly.getByRole("link", { name: /Show Nightly packages for 2026-10-29 UTC.*Linux/ }).click();
  await expect(page).toHaveURL(/day=2026-10-29/);
  await expect(page.getByRole("heading", { name: "Package qualification" })).toBeVisible();
  await page.getByRole("link", { name: "Show all packages in this window" }).click();
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
  const tooltip = page.getByRole("tooltip");
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toContainText("Reported");
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
