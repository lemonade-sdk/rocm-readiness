import { expect, test } from "@playwright/test";
import {
  fixtureFetch,
  overview,
  historyFixture,
  indexUrl,
  index,
} from "../src/fixtures";

test("individual build marks retain outcomes and exact identity in a clean session", async ({
  page,
  browser,
}) => {
  await page.clock.setFixedTime(new Date("2026-11-02T15:00:00Z"));
  const data = overview();
  const base = data.engines[0].latest_builds[0];
  const builds = [
    { ...base, build_id: "warning", tag: "b-warning", overall: "warn" },
    {
      ...base,
      build_id: "failed",
      tag: "b-failed",
      qualified: false,
      overall: "fail",
      os: "windows",
      report_url: null,
    },
    { ...base, build_id: "unknown", tag: "b-unknown", qualified: null },
  ];
  data.engines[0].latest_builds = [
    { ...base, build_id: "warning", tag: "b-warning", overall: "warn" },
  ];
  data.engines[0].build_count = 3;
  data.history[0].build_count = 3;
  const fixture = fixtureFetch({
    [indexUrl]: {
      ...index,
      versions: index.versions.map((row, i) =>
        i === 0 ? { ...row, build_count: 3 } : row,
      ),
    },
    [new URL("rocm/10.1/overview.json", indexUrl).href]: data,
    [new URL("rocm/10.1/history/2026-10.json", indexUrl).href]: {
      ...historyFixture(),
      builds,
    },
  });
  const routeFixture = async (route: import("@playwright/test").Route) => {
    const response = await fixture(route.request().url());
    await route.fulfill({
      status: response.status,
      body: await response.text(),
      contentType: "application/json",
    });
  };
  await page.route("https://raw.githubusercontent.com/**", routeFixture);
  await page.goto("./");
  await expect(page.getByRole("link", { name: /b-warning.*Qualified with warnings/ })).toHaveClass(
    /build-mark pass/,
  );
  const failed = page.getByRole("link", { name: /b-failed.*Fail/ });
  await expect(failed).toHaveClass(/build-mark fail/);
  await expect(
    page.getByRole("link", { name: /b-unknown.*Evidence unavailable/ }),
  ).not.toHaveClass(/build-mark/);
  for (const text of ["Compiled GPU targets", "Checks passed", "Qualified"])
    await expect(page.getByText(text, { exact: true })).toHaveCount(0);
  const href = await failed.getAttribute("href");
  expect(href).toContain("view=build-review");
  expect(href).toContain("platform=windows");
  expect(href).toContain("source=llamacpp-stable-qualification");
  await failed.click();
  await expect(
    page.getByRole("heading", { name: "Build review", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "b-failed", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Windows · stable · 2026-10-29 UTC")).toBeVisible();
  const url = page.url();
  const clean = await browser.newContext();
  try {
    await clean.route("https://raw.githubusercontent.com/**", routeFixture);
    const fresh = await clean.newPage();
    await fresh.goto(url);
    await expect(
      fresh.getByRole("heading", { name: "b-failed", exact: true }),
    ).toBeVisible();
    await expect(fresh.getByText("Windows · stable · 2026-10-29 UTC")).toBeVisible();
  } finally {
    await clean.close();
  }
});
