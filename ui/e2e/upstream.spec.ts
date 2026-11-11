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
  await page.getByRole("button", { name: "rocm", exact: true }).click();
  await expect(page).toHaveURL(/stack=vulkan/);
  await expect(page.getByText("of 8 results on main passed")).toBeVisible();
  await page.getByRole("button", { name: "rocm", exact: true }).click();
  await page
    .getByRole("region", { name: "Daily activity" })
    .getByRole("button", { name: "2026-10-27: 3 passed, 1 failed of 4 runs", exact: true })
    .click();
  const panel = page.getByRole("region", { name: "Runs on 2026-10-27" });
  await expect(panel.getByRole("link", { name: "#501 red" })).toHaveAttribute(
    "href",
    "https://github.com/ggml-org/llama.cpp/pull/501",
  );
  await page.goBack();
  await expect(page).not.toHaveURL(/day=/);
  await page.goBack();
  await expect(page).toHaveURL(/stack=vulkan/);
  await page.goBack();
  await expect(page).not.toHaveURL(/stack=/);
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
      await expect(page.getByRole("navigation", { name: "Project navigation" })).toHaveCount(0);
      await expect(page.getByRole("link", { name: "Repository: ggml-org/llama.cpp" })).toBeVisible();
      await expect(page.getByRole("link", { name: "lemonade-sdk/llama.cpp" })).toBeVisible();
      await expect(page.getByRole("table", { name: "Daily CI activity" })).toHaveCount(1);
      await page.getByRole("region", { name: "Daily activity", exact: true }).getByRole("button", { name: "2026-10-27: 3 passed, 1 failed of 4 runs", exact: true }).click();
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
      await page.getByRole("list", { name: "Upstream health views" }).getByRole("link", { name: "Overview", exact: true }).click();
      await expect(page.getByRole("region", { name: "Upstream projects" })).toBeVisible();
    });
  }
}

test("upstream sub-pages preserve project and filter scope through navigation and reload", async ({ page }) => {
  await page.goto("./?track=upstream&view=ci&project=llamacpp&lens=vulkan");
  const views = page.getByRole("list", { name: "Upstream health views" });
  await expect(views.getByRole("link", { name: "CI Activity" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("heading", { level: 1, name: "CI Activity" })).toBeVisible();
  await expect(page.getByRole("group", { name: "Project" }).getByRole("button", { name: "llama.cpp" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "vulkan", exact: true })).toHaveAttribute("aria-pressed", "true");
  await views.getByRole("link", { name: "Overview", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Upstream Overview" })).toBeVisible();
  await expect(page.getByRole("group", { name: "Project" })).toHaveCount(0);
  await views.getByRole("link", { name: "CI Activity" }).click();
  await expect(page.getByRole("button", { name: "vulkan", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("group", { name: "Project" }).getByRole("button", { name: "vLLM" }).click();
  await expect(page).not.toHaveURL(/lens=/);
  await page.reload();
  await expect(page.getByRole("group", { name: "Project" }).getByRole("button", { name: "vLLM" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("heading", { level: 2, name: "vLLM" })).toBeVisible();
});

test("overview day links restore the selected date and run evidence after reload", async ({ page }) => {
  await page.goto("./?track=upstream");
  const calendar = page.getByRole("region", { name: "llama.cpp activity calendar" });
  await calendar.getByRole("link", { name: "2026-10-27: 3 passed, 1 failed of 4 runs", exact: true }).click();
  await expect(page).toHaveURL(/view=ci/);
  await expect(page).toHaveURL(/day=2026-10-27/);
  await expect(page.getByRole("region", { name: "Runs on 2026-10-27" })).toBeVisible();
  await page.reload();
  const runs = page.getByRole("region", { name: "Runs on 2026-10-27" });
  await expect(runs.getByRole("link", { name: "Job log at 10:00 UTC · failed" })).toBeVisible();
  await expect(runs.getByRole("button", { name: "Next day" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page).not.toHaveURL(/day=/);
  await page.goBack();
  await expect(page.getByRole("region", { name: "Runs on 2026-10-27" })).toBeVisible();
});

test("independent stack and target selections survive reload and history", async ({ page }) => {
  await page.goto("./?track=upstream&view=ci&project=llamacpp");
  const stacks = page.getByRole("group", { name: "Stack", exact: true });
  const targets = page.getByRole("group", { name: "Target", exact: true });
  await expect(stacks.getByRole("button", { name: "rocm", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(stacks.getByRole("button", { name: "vulkan", exact: true })).toHaveAttribute("aria-pressed", "true");
  await stacks.getByRole("button", { name: "rocm", exact: true }).click();
  await targets.getByRole("button", { name: "gfx1201" }).click();
  await expect(page.getByText("No configured jobs match these filters.")).toBeVisible();
  await page.reload();
  await expect(stacks.getByRole("button", { name: "rocm", exact: true })).toHaveAttribute("aria-pressed", "false");
  await expect(targets.getByRole("button", { name: "gfx1201" })).toHaveAttribute("aria-pressed", "false");
  await page.goBack();
  await expect(page.getByText("of 8 results on main passed")).toBeVisible();
  await stacks.getByRole("button", { name: "rocm", exact: true }).click();
  await expect(page.getByText("of 12 results on main passed")).toBeVisible();
  await expect(page).not.toHaveURL(/stack=|target=/);
});

for (const width of [390, 1440]) {
  test(`daily count popup supports keyboard dismissal at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto("./?track=upstream&view=ci&project=llamacpp");
    const day = page.getByRole("button", { name: "2026-10-27: 3 passed, 1 failed of 4 runs", exact: true });
    await expect(day).toHaveText("");
    await day.focus();
    const table = page.getByRole("table", { name: "Daily CI activity" });
    const before = await table.boundingBox();
    await day.press("Enter");
    const popup = page.getByRole("dialog", { name: "2026-10-27: 3 passed, 1 failed of 4 runs", exact: true });
    await expect(popup.getByRole("link", { name: "Job log at 10:00 UTC · failed" })).toBeVisible();
    await expect(popup).toContainText("4 runs");
    expect(await table.boundingBox()).toEqual(before);
    const bounds = await popup.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
    await page.screenshot({ path: testInfo.outputPath("daily-popup.png"), fullPage: true });
    await page.keyboard.press("Escape");
    await expect(popup).toHaveCount(0);
    await expect(page).not.toHaveURL(/day=/);
    await expect(day).toBeFocused();
  });
}

test("hovering daily evidence leaves the chart position and page scroll unchanged", async ({ page }) => {
  await page.goto("./?track=upstream&view=ci&project=llamacpp");
  const day = page.getByRole("button", { name: "2026-10-27: 3 passed, 1 failed of 4 runs", exact: true });
  await day.scrollIntoViewIfNeeded();
  const table = page.getByRole("table", { name: "Daily CI activity" });
  const before = await table.boundingBox();
  const scrollBefore = await page.evaluate(() => window.scrollY);
  await day.hover();
  await expect(page.getByRole("dialog", { name: "2026-10-27: 3 passed, 1 failed of 4 runs", exact: true })).toBeVisible();
  expect(await table.boundingBox()).toEqual(before);
  expect(await page.evaluate(() => window.scrollY)).toEqual(scrollBefore);
  await page.mouse.move(10, 10);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(await table.boundingBox()).toEqual(before);
  expect(await page.evaluate(() => window.scrollY)).toEqual(scrollBefore);
});

for (const theme of ["light", "dark"] as const) {
  for (const width of [390, 1440]) {
    test(`daily bars share a zero baseline across projects and filters at ${width}px in ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 1000 });
      await page.emulateMedia({ colorScheme: theme });
      const source = upstreamOverview.projects[0];
      const projects = ["llamacpp", "whispercpp", "unsloth", "pytorch", "sdcpp", "vllm"].map((id) => ({
        ...source, id,
        jobs: source.jobs.map((job) => ({ ...job, daily: {
          // Mixed outcomes, no runs and pure successes must share the same zero.
          "2026-10-26": { passed: 20, failed: 0, running: 0, other: 0, stalled: 0, skipped: 0, slow: 0 },
          "2026-10-27": { passed: 19, failed: 1, running: 0, other: 0, stalled: 0, skipped: 0, slow: 0 },
          "2026-10-28": { passed: 0, failed: 1, running: 1, other: 1, stalled: 0, skipped: 0, slow: 0 },
          "2026-10-29": { passed: 0, failed: 0, running: 0, other: 0, stalled: 1, skipped: 0, slow: 0 },
        } })),
      }));
      await page.route(new URL("upstream/overview.json", indexUrl).href, (route) =>
        route.fulfill({ json: { ...upstreamOverview, projects } }));
      for (const project of projects) {
        await page.goto(`./?track=upstream&view=ci&project=${project.id}`);
        const charts = page.locator(".up-daily-chart");
        await expect(charts).toHaveCount(14);
        for (const filtered of [false, true]) {
          if (filtered) await page.getByRole("group", { name: "Stack", exact: true }).getByRole("button", { name: "rocm", exact: true }).click();
          const geometry = await charts.evaluateAll((elements) => elements.map((element) => {
            const rect = element.getBoundingClientRect();
            return { bottom: rect.bottom, top: rect.top,
              segments: [...element.querySelectorAll(".qualification-segment")].map((segment) => {
                const box = segment.getBoundingClientRect();
                return { top: box.top, bottom: box.bottom };
              }),
            };
          }));
          const baseline = geometry[0].bottom;
          for (const bar of geometry) {
            expect(Math.abs(bar.bottom - baseline)).toBeLessThan(0.1);
            for (const segment of bar.segments) {
              expect(segment.bottom).toBeLessThanOrEqual(baseline);
              expect(segment.top).toBeGreaterThanOrEqual(bar.top - 0.1);
            }
          }
        }
      }
    });
  }
}
