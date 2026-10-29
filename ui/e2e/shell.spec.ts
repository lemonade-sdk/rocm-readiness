import { expect, test } from "@playwright/test";
import {
  index,
  indexUrl,
  overview,
  pointer,
  historyFixture,
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

test("visible platform choices preserve counts and shared URL scope", async ({
  page,
}) => {
  await page.goto("./?version=10.1&view=overview");
  await page.getByRole("button", { name: "Linux", exact: true }).click();
  await expect(page).toHaveURL(/platform=linux/);
  await expect(
    page.getByRole("button", { name: "Linux", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByLabel("Build qualification")).toContainText("13 / 13");
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Linux", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page
    .getByRole("button", { name: "All platforms", exact: true })
    .click();
  await expect(page.getByLabel("Build qualification")).toContainText("26 / 26");
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
    page.getByRole("heading", { name: "ROCm 10.1 readiness" }),
  ).toBeVisible();
  await expect(page.getByLabel("Build qualification")).toContainText("26 / 26");
  const pointerReads = reads.filter((url) =>
    url.endsWith("/main/data/latest.json"),
  ).length;
  await page.getByLabel("ROCm version").selectOption("10.0");
  await expect(
    page.getByRole("heading", { name: "ROCm 10.0 readiness" }),
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
    page.getByRole("heading", { name: "ROCm 10.1 readiness" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Retry history" }),
  ).toBeVisible();
  await page.route("**/main/data/latest.json", (route) =>
    route.fulfill({ status: 503, body: "{}" }),
  );
  await page.getByRole("button", { name: "Retry history" }).click();
  await expect(page.getByRole("alert")).toContainText("HTTP 503");
  await expect(
    page.getByRole("heading", { name: "ROCm 10.1 readiness" }),
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
    page.getByRole("heading", { name: "ROCm 10.1 readiness" }),
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
