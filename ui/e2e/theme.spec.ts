import { expect, test } from "@playwright/test";
import { fixtureFetch } from "../src/fixtures";

test("applies a saved theme before the application JavaScript loads", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.addInitScript(() =>
    localStorage.setItem("rocm-readiness-theme", "dark"),
  );
  await page.route("**/assets/*.js", (route) => route.abort());
  await page.goto("./");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator("html")).toHaveCSS("color-scheme", "dark");
});

test("follows the device, preserves overrides and returns to system", async ({
  page,
}) => {
  const fixture = fixtureFetch();
  await page.route("https://raw.githubusercontent.com/**", async (route) => {
    const response = await fixture(route.request().url());
    await route.fulfill({
      status: response.status,
      body: await response.text(),
      contentType: "application/json",
    });
  });
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("./?version=10.1&platform=linux");
  const themeButton = page.getByRole("button", { name: "Change color theme" });
  await expect(themeButton).toHaveAttribute("title", "Theme: System (Light)");
  await expect(page.locator("html")).toHaveCSS("color-scheme", "light");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(themeButton).toHaveAttribute("title", "Theme: System (Dark)");
  await expect(page.locator("html")).toHaveCSS("color-scheme", "dark");
  await themeButton.click();
  await page.getByRole("button", { name: "Light", exact: true }).click();
  await expect(page.locator("html")).toHaveCSS("color-scheme", "light");
  await expect(page).toHaveURL(/platform=linux/);
  await page.reload();
  await expect(themeButton).toHaveAttribute("title", "Theme: Light (Light)");
  await expect(
    page.getByRole("rowheader", { name: /Linux/ }).first(),
  ).toBeVisible();
  await themeButton.click();
  await page.getByRole("button", { name: "System", exact: true }).click();
  await expect(themeButton).toHaveAttribute("title", "Theme: System (Dark)");
  await expect(page.locator("html")).toHaveCSS("color-scheme", "dark");
  await themeButton.click();
  await page.keyboard.press("Escape");
  await expect(themeButton).toBeFocused();
  await expect(themeButton).toHaveAttribute("aria-expanded", "false");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
