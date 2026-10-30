import { expect, test } from "@playwright/test";
import {
  fixtureFetch,
  overview,
  historyFixture,
  indexUrl,
} from "../src/fixtures";

test("comparison tooltips disclose dated qualification and result changes", async ({
  page,
}, testInfo) => {
  const data = overview();
  const current = {
    ...data.engines[0].latest_builds[0],
    tests: {
      passed: 1,
      failed: 0,
      warned: 0,
      skipped: 0,
      missing: 1,
      total: 2,
    },
    results: { "T0.1": "pass", "T0.2": "missing" },
  };
  data.engines[0].latest_builds = [current];
  const history = historyFixture();
  const rows = history.builds.map((row, i) =>
    i === 0
      ? current
      : {
          ...row,
          tag: `b${11972 - i}`,
          generated_at: new Date(
            Date.parse(current.generated_at) - i * 86400000,
          ).toISOString(),
          tests: {
            passed: 2,
            failed: 0,
            warned: 0,
            skipped: 0,
            missing: 0,
            total: 2,
          },
          results: { "T0.1": "pass", "T0.2": "pass" },
        },
  );
  const fixture = fixtureFetch({
    [new URL("rocm/10.1/overview.json", indexUrl).href]: data,
    [new URL("rocm/10.1/history/2026-10.json", indexUrl).href]: {
      ...history,
      builds: rows,
    },
  });
  await page.route("https://raw.githubusercontent.com/**", async (route) => {
    const response = await fixture(route.request().url());
    await route.fulfill({
      status: response.status,
      body: await response.text(),
      contentType: "application/json",
    });
  });
  await page.goto("./");
  const qualification = page.getByRole("button", {
    name: "Qualified. Compare linux shipping readiness with previous build",
  });
  await expect(qualification).toBeVisible();
  if (testInfo.project.name === "mobile") await qualification.click();
  else await qualification.hover();
  await expect(page.getByRole("tooltip")).toContainText(
    "Shipping readiness unchanged: qualified",
  );
  await expect(
    page.getByRole("tooltip").getByRole("row", { name: /Previous/ }),
  ).toContainText("b11970");
  await expect(page.getByRole("tooltip")).toContainText("UTC");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("tooltip")).toHaveCount(0);
  const checks = page.getByRole("button", {
    name: "Checks passed 1 of 2. Compare linux check results with previous build",
  });
  await checks.click();
  await expect(page.getByRole("tooltip")).toContainText(
    "1 check: passed → missing",
  );
  const box = await page.getByRole("tooltip").evaluate((node) => {
    const b = node.getBoundingClientRect();
    return { left: b.left, right: b.right, width: innerWidth };
  });
  expect(box.left).toBeGreaterThanOrEqual(0);
  expect(box.right).toBeLessThanOrEqual(box.width);
  await page.getByRole("heading", { name: "ROCm 10.1 readiness" }).click();
  await expect(page.getByRole("tooltip")).toHaveCount(0);
});
