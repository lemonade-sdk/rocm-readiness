import { expect, test } from "@playwright/test";
import { fixtureFetch, historyFixture, indexUrl } from "../src/fixtures";
import { buildFixture, producerReport } from "../src/builds/fixtures";

test("focused test evidence traps keyboard focus and restores the selected check", async ({
  page,
}) => {
  const build = buildFixture({ build_id: "linux-build" });
  const originalHistory = historyFixture();
  const history = {
    ...originalHistory,
    builds: [build, ...originalHistory.builds.slice(1)],
  };
  const fixture = fixtureFetch({
    [new URL("rocm/10.1/history/2026-10.json", indexUrl).href]: history,
    [build.report_url!]: producerReport(build),
  });
  await page.route("https://raw.githubusercontent.com/**", async (route) => {
    const response = await fixture(route.request().url());
    await route.fulfill({
      status: response.status,
      body: await response.text(),
      contentType: "application/json",
    });
  });
  await page.goto(
    "./?version=10.1&view=build&build=linux-build&platform=linux&source=stable-qualification",
  );
  await expect(
    page.getByRole("heading", { name: "GPU coverage" }),
  ).toBeVisible();
  const trigger = page.getByRole("button", {
    name: "T0.1 archive contents warn",
  });
  await trigger.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "T0.1 · archive contents" });
  await expect(dialog).toBeVisible();
  const close = dialog.getByRole("button", { name: "Close test evidence" });
  await expect(close).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(
    dialog.getByRole("link", { name: "Open pinned test source" }),
  ).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(close).toBeFocused();
  await expect(dialog).not.toContainText("hipblas.dll missing");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect(page.locator("body")).not.toHaveCSS("overflow", "hidden");
});
