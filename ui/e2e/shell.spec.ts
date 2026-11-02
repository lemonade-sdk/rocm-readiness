import { expect, test } from "@playwright/test";
import {
  index,
  indexUrl,
  overview,
  pointer,
  historyFixture,
  executionAttempt,
} from "../src/fixtures";

test.beforeEach(async ({ page }) => {
  await page.route("https://raw.githubusercontent.com/**", async (route) => {
    const url = route.request().url();
    let data: unknown;
    if (url.endsWith("/main/data/latest.json")) data = pointer;
    else if (url === indexUrl) data = index;
    else if (url === new URL("rocm/10.1/overview.json", indexUrl).href)
      data = overview();
    else if (url === new URL("rocm/10.0/overview.json", indexUrl).href)
      data = overview("10.0");
    else if (url.endsWith("/history/2026-10.json"))
      data = historyFixture(url.match(/\/rocm\/([^/]+)\//)?.[1]);
    else return route.fulfill({ status: 404, body: "{}" });
    await route.fulfill({ json: data });
  });
});

test("overview build marks open exact Page Two details", async ({ page }) => {
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
  await expect(page).toHaveURL(/view=build/);
  await expect(page).toHaveURL(/build=linux-build/);
  await expect(
    page.getByRole("heading", { name: "Build evidence", exact: true }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Engine builds", exact: true }).click();
  await page.getByRole("link", { name: "Show all engine builds" }).click();
  await expect(page.getByLabel("Platform", { exact: true })).toHaveValue("all");
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
  await expect(page.getByRole("region", {name:"ROCm 10.0",exact:true})).toHaveCount(0);
  await expect(page.locator(".build-legend")).toHaveCount(1);
  await page.getByRole("link", { name: "Engine builds", exact: true }).click();
  await page.getByLabel("ROCm version").selectOption("10.0");
  await expect(
    page.getByRole("heading", { name: "llama.cpp builds" }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Engine builds", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "llama.cpp builds", exact: true }),
  ).toBeVisible();
  await page.getByLabel("Platform", { exact: true }).selectOption("linux");
  await expect(page).toHaveURL(/platform=linux/);
  await page.getByLabel("Find build").fill("linux-build");
  await expect(page).toHaveURL(/build_filter=linux-build/);
  await page
    .getByRole("link", { name: /^Open build linux-build / })
    .first()
    .click();
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
  await expect(page.getByLabel("Platform", { exact: true })).toHaveValue(
    "linux",
  );
  await page.goForward();
  await expect(page).toHaveURL(/build_filter=linux-build/);
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
    route.fulfill({ json: { ...index, default_version: null, versions: [] } }),
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

test("shows benchmark failures and incomplete attempts without qualification marks", async ({
  page,
}) => {
  const version = "10.2";
  const o = overview(version);
  const attempts = (["passed", "failed", "partial", "unknown"] as const).map(
    (status) => executionAttempt(version, status),
  );
  await page.route(indexUrl, (route) =>
    route.fulfill({
      json: {
        ...index,
        versions: [
          ...index.versions,
          {
            rocm_version: version,
            overview: `rocm/${version}/overview.json`,
            build_count: 0,
          },
        ],
      },
    }),
  );
  await page.route(`**/rocm/${version}/overview.json`, (route) =>
    route.fulfill({
      json: {
        ...o,
        engines: [{ ...o.engines[0], build_count: 0, latest_builds: [] }],
        history: [],
        performance: { status: "not_measured" },
        execution: {
          path: `rocm/${version}/executions.json`,
          attempt_count: 4,
          summaries: [],
        },
      },
    }),
  );
  await page.route(`**/rocm/${version}/executions.json`, (route) =>
    route.fulfill({
      json: {
        schema_version: 1,
        rocm_version: version,
        attempts,
        summaries: [],
      },
    }),
  );
  await page.goto("./");
  const section = page.getByRole("region", { name: "ROCm 10.2", exact: true });
  for (const label of [
    "Passed: 1",
    "Failed: 1",
    "Partial: 1",
    "Incomplete evidence: 1",
  ])
    await expect(section.getByText(label, { exact: true })).toBeVisible();
  await expect(section.locator(".build-mark")).toHaveCount(0);
  await section.getByText("Inspect benchmark attempts").click();
  await expect(
    section.getByRole("link", { name: "Source report", exact: true }),
  ).toHaveCount(4);
  await expect(page.getByLabel("ROCm version")).toHaveCount(0);
  await expect(page.getByRole("region", {name:"ROCm 10.0",exact:true})).toHaveCount(0);
  await expect(page.locator(".build-legend")).toHaveCount(1);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
