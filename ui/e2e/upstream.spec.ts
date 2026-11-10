import { expect, test } from "@playwright/test";
import {
  index,
  indexUrl,
  overview,
  pointer,
  historyFixture,
} from "../src/fixtures";
import { upstreamOverview, upstreamRuns } from "../src/upstream/fixtures";

test.beforeEach(async ({ page }) => {
  await page.route("https://raw.githubusercontent.com/**", async (route) => {
    const url = route.request().url();
    let data: unknown;
    if (url.endsWith("/main/data/latest.json")) data = pointer;
    else if (url === indexUrl)
      data = {
        ...index,
        upstream: {
          schema_version: 1,
          overview: "upstream/overview.json",
          project_count: 2,
          status: "fresh",
        },
      };
    else if (url === new URL("rocm/10.1/overview.json", indexUrl).href)
      data = overview();
    else if (url.endsWith("/history/2026-10.json")) data = historyFixture();
    else if (url === new URL("upstream/overview.json", indexUrl).href)
      data = upstreamOverview;
    else if (
      url === new URL("upstream/llamacpp/ci/2026-10.json", indexUrl).href
    )
      data = upstreamRuns;
    else return route.fulfill({ status: 404, body: "{}" });
    await route.fulfill({ json: data });
  });
});

test("upstream health opens a project, filters it and links a day's runs", async ({
  page,
}) => {
  await page.goto("./");
  await page.getByRole("link", { name: "Upstream health" }).click();
  await expect(page).toHaveURL(/track=upstream/);
  await expect(page.getByText("Configured coverage unknown")).toBeVisible();
  await page.getByRole("link", { name: "llama.cpp" }).click();
  await expect(page).toHaveURL(/project=llamacpp/);
  await expect(page.getByText("of 12 results on main passed")).toBeVisible();
  await page.getByRole("button", { name: "vulkan" }).click();
  await expect(page).toHaveURL(/lens=vulkan/);
  await expect(page.getByText("of 8 results on main passed")).toBeVisible();
  await page.getByRole("button", { name: "Everything AMD" }).click();
  await page
    .getByRole("region", { name: "Per day" })
    .getByRole("button", { name: "2026-10-27: 3 passed, 1 failed of 4 runs" })
    .click();
  const panel = page.getByRole("region", { name: "Runs on 2026-10-27" });
  await expect(panel.getByRole("link", { name: "#501 red" })).toHaveAttribute(
    "href",
    "https://github.com/ggml-org/llama.cpp/pull/501",
  );
  await page.goBack();
  await expect(page).not.toHaveURL(/day=/);
  await page.goBack();
  await expect(page).toHaveURL(/lens=vulkan/);
  await page.goBack();
  await expect(page).not.toHaveURL(/lens=/);
});

for (const theme of ["light", "dark"] as const) {
  for (const width of [390, 1440]) {
    test(`project navigation and evidence fit ${width}px in ${theme}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 1000 });
      await page.emulateMedia({ colorScheme: theme });
      await page.goto("./?track=upstream");
      const project = page.getByRole("article").filter({ has: page.getByRole("heading", { name: "llama.cpp" }) });
      await expect(project.getByRole("link", { name: /Repository:/ })).toHaveCount(0);
      await expect(project.getByText("1 fork", { exact: true })).toHaveCount(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await expect(page.getByRole("table", { name: "Daily CI activity" })).toHaveCount(1);
      await expect(project.getByRole("heading", { name: "llama.cpp" }).getByRole("link")).toHaveCount(1);
      await page.screenshot({ path: testInfo.outputPath("overview.png"), fullPage: true });
      const link = project.getByRole("link", { name: "llama.cpp", exact: true });
      await link.focus();
      await page.keyboard.press("Enter");
      const navigation = page.getByRole("navigation", { name: "Project navigation" });
      await expect(navigation.getByText("llama.cpp")).toBeVisible();
      await expect(page.getByRole("link", { name: "Repository: ggml-org/llama.cpp" })).toBeVisible();
      await page.getByText("1 fork", { exact: true }).click();
      await expect(page.getByRole("link", { name: "lemonade-sdk/llama.cpp" })).toBeVisible();
      await expect(page.getByRole("table", { name: "Daily CI activity" })).toHaveCount(0);
      await page.getByRole("region", { name: "Per day", exact: true }).getByRole("button", { name: "2026-10-27: 3 passed, 1 failed of 4 runs" }).click();
      await expect(page.getByRole("link", { name: "Job log at 10:00 UTC · failed" })).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath("before-scroll.png"), fullPage: true });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const coverage = page.getByRole("region", { name: "Platform coverage table", exact: true });
      await coverage.focus();
      await expect(coverage).toBeFocused();
      if (width === 390) {
        await page.keyboard.press("ArrowRight");
        await expect.poll(() => coverage.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
      }
      await page.screenshot({ path: testInfo.outputPath("project.png"), fullPage: true });
      await navigation.getByRole("link", { name: /All projects/ }).click();
      await expect(page).not.toHaveURL(/project=/);
      await expect(page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();
    });
  }
}

test("upstream sub-pages preserve project and filter scope through navigation and reload", async ({ page }) => {
  await page.goto("./?track=upstream&view=ci&project=llamacpp&lens=vulkan");
  const views = page.getByRole("list", { name: "Upstream health views" });
  await expect(views.getByRole("link", { name: "CI Activity" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("heading", { level: 1, name: "CI Activity" })).toBeVisible();
  await expect(page.getByRole("group", { name: "Project" }).getByRole("button", { name: "llama.cpp" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "vulkan" })).toHaveAttribute("aria-pressed", "true");
  await views.getByRole("link", { name: "Overview", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Upstream Overview" })).toBeVisible();
  await expect(page.getByRole("group", { name: "Project" })).toHaveCount(0);
  await views.getByRole("link", { name: "CI Activity" }).click();
  await expect(page.getByRole("button", { name: "vulkan" })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("group", { name: "Project" }).getByRole("button", { name: "vLLM" }).click();
  await expect(page).not.toHaveURL(/lens=/);
  await page.reload();
  await expect(page.getByRole("group", { name: "Project" }).getByRole("button", { name: "vLLM" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("heading", { level: 2, name: "vLLM" })).toBeVisible();
});

test("overview day links restore the selected date and run evidence after reload", async ({ page }) => {
  await page.goto("./?track=upstream");
  const calendar = page.getByRole("region", { name: "llama.cpp activity calendar" });
  await calendar.getByRole("link", { name: "2026-10-27: 3 passed, 1 failed of 4 runs" }).click();
  await expect(page).toHaveURL(/view=ci/);
  await expect(page).toHaveURL(/day=2026-10-27/);
  await expect(page.getByRole("region", { name: "Runs on 2026-10-27" })).toBeVisible();
  await page.reload();
  const runs = page.getByRole("region", { name: "Runs on 2026-10-27" });
  await expect(runs.getByRole("link", { name: "Job log at 10:00 UTC · failed" })).toBeVisible();
  await runs.getByRole("button", { name: "Next day" }).click();
  await expect(page).toHaveURL(/day=2026-10-28/);
  await page.goBack();
  await expect(page.getByRole("region", { name: "Runs on 2026-10-27" })).toBeVisible();
});
