import { expect, test } from "@playwright/test";
import { fixtureFetch, historyFixture, indexUrl } from "../src/fixtures";

test("daily qualification preserves mixed outcomes and supports keyboard and touch navigation", async ({
  page,
}, testInfo) => {
  const history = historyFixture();
  const fixture = fixtureFetch({
    [new URL("rocm/10.1/history/2026-10.json", indexUrl).href]: {
      ...history,
      builds: history.builds.map((row, i) => ({
        ...row,
        qualified: i === 2 ? false : true,
      })),
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
  await expect(page.getByLabel("Timeline window")).toHaveCount(0);
  const symbol = page.getByRole("link", {
    name: /10.1 stable linux:.*Not qualified/,
  });
  await expect(symbol).toBeVisible();
  await expect(symbol).toHaveAttribute("title", /13 qualification records/);
  if (testInfo.project.name === "mobile") await symbol.click();
  else {
    await symbol.focus();
    await page.keyboard.press("Enter");
  }
  await expect(page).toHaveURL(/date=2026-10-29/);

  await expect(
    page.getByRole("link", { name: /Open build history-2 / }).first(),
  ).toBeVisible();
  await page.goBack();
  await expect(symbol).toBeVisible();
  await expect(page.getByLabel("Timeline window")).toHaveCount(0);
  await page.reload();
  await expect(page.getByLabel("Timeline window")).toHaveCount(0);
  await expect(
    page
      .getByRole("region", { name: "llama.cpp ROCm 10.1 timeline" })
      .getByRole("columnheader"),
  ).toHaveCount(15);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
