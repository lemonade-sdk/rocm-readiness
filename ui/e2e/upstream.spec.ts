import { expect, test } from "@playwright/test";

// Baseline table/popup scenarios use desktop dimensions; responsive cases override this.
test.use({ viewport: { width: 1440, height: 1000 } });
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
  await expect(page.getByText("unconfigured")).toBeVisible();
  await page.getByRole("link", { name: "llama.cpp" }).click();
  await expect(page).toHaveURL(/project=llamacpp/);
  await expect(page.getByText("of 12", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "rocm", exact: true }).click();
  await expect(page).toHaveURL(/stack=vulkan/);
  await expect(page.getByText("of 8", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "rocm", exact: true }).click();
  await page
    .getByRole("region", { name: "Daily activity" })
    .getByRole("button", { name: "2026-10-27: 3 passed, 1 failed of 4 runs", exact: true })
    .click();
  const panel = page.getByRole("region", { name: "Runs on 2026-10-27" });
  await expect(panel.getByRole("link", { name: "#501" })).toHaveAttribute(
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
      if (width <= 540) await expect(page.getByRole("article", { name: /^CI activity on / })).toHaveCount(14);
      else await expect(page.getByRole("table", { name: "Daily CI activity" })).toHaveCount(1);
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
      if (width <= 640) await page.getByRole("button", { name: "Navigation", exact: true }).click();
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
  await expect(page.getByText("of 8", { exact: true })).toBeVisible();
  await stacks.getByRole("button", { name: "rocm", exact: true }).click();
  await expect(page.getByText("of 12", { exact: true })).toBeVisible();
  await expect(page).not.toHaveURL(/stack=|target=/);
});

for (const width of [390, 1440]) {
  test(`daily count popup supports keyboard dismissal at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto("./?track=upstream&view=ci&project=llamacpp");
    const day = page.getByRole("button", { name: "2026-10-27: 3 passed, 1 failed of 4 runs", exact: true });
    if (width > 540) await expect(day).toHaveText("");
    await day.focus();
    const table = width <= 540 ? page.getByRole("article", { name: "CI activity on 2026-10-27 UTC", exact: true }) : page.getByRole("table", { name: "Daily CI activity" });
    const before = await table.boundingBox();
    await day.press("Enter");
    const popup = width <= 540 ? table.getByRole("region", { name: "Runs on 2026-10-27", exact: true }) : page.getByRole("dialog", { name: "2026-10-27: 3 passed, 1 failed of 4 runs", exact: true });
    await expect(popup.getByRole("link", { name: "Job log at 10:00 UTC · failed" })).toBeVisible();
    await expect(popup).toContainText("4 runs");
    if (width <= 540) expect((await table.boundingBox())!.height).toBeGreaterThan(before!.height);
    else expect(await table.boundingBox()).toEqual(before);
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
        const charts = page.locator(width <= 540 ? ".up-mobile-day-toggle .up-horizontal-chart" : ".up-daily-chart");
        await expect(charts).toHaveCount(14);
        for (const filtered of [false, true]) {
          if (filtered) {
            if (width <= 640) await page.getByRole("button", { name: /^CI filters/ }).click();
            await page.getByRole("group", { name: "Stack", exact: true }).getByRole("button", { name: "rocm", exact: true }).click();
          }
          const geometry = await charts.evaluateAll((elements) => elements.map((element) => {
            const rect = element.getBoundingClientRect();
            return { bottom: rect.bottom, top: rect.top, left: rect.left, right: rect.right,
              segments: [...element.querySelectorAll(".qualification-segment")].map((segment) => {
                const box = segment.getBoundingClientRect();
                return { top: box.top, bottom: box.bottom, left: box.left, right: box.right };
              }),
            };
          }));
          const baseline = width <= 540 ? geometry[0].left : geometry[0].bottom;
          for (const bar of geometry) {
            expect(Math.abs((width <= 540 ? bar.left : bar.bottom) - baseline)).toBeLessThan(0.1);
            for (const segment of bar.segments) {
              if (width <= 540) {
                expect(segment.left).toBeGreaterThanOrEqual(bar.left - 0.1);
                expect(segment.right).toBeLessThanOrEqual(bar.right + 0.1);
              } else {
                expect(segment.bottom).toBeLessThanOrEqual(baseline);
                expect(segment.top).toBeGreaterThanOrEqual(bar.top - 0.1);
              }
            }
          }
        }
      }
    });
  }
}

for (const theme of ["light", "dark"] as const) {
  for (const width of [390, 1440]) {
    test(`CI evidence uses shared qualification detail rows at ${width}px in ${theme}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 1000 });
      await page.emulateMedia({ colorScheme: theme });
      await page.goto("./?track=upstream&view=ci&project=llamacpp&day=2026-10-27&activity=cat:tests");
      const popup = width <= 540 ? page.locator(".up-mobile-day-evidence") : page.getByRole("dialog");
      await expect(popup.getByRole("link", { name: "Job log at 10:00 UTC · failed" })).toBeVisible();
      await expect(popup.getByText("Failed on the merged commit", { exact: true })).toBeVisible();
      const logStyle = await popup.getByRole("link", { name: "Job log at 10:00 UTC · failed" }).evaluate((link) => ({
        color: getComputedStyle(link).color,
        surroundingColor: getComputedStyle(link.parentElement!).color,
        underline: getComputedStyle(link).textDecorationStyle,
      }));
      expect(logStyle.color).toBe(logStyle.surroundingColor);
      expect(logStyle.underline).toBe("dotted");
      const details = popup.locator('.structured-tooltip-body[data-format="details"]');
      const rows = await details.locator("dl").evaluateAll((lists) => lists.map((list) => ({
        labels: [...list.querySelectorAll("dt")].map((label) => label.getBoundingClientRect().left),
        values: [...list.querySelectorAll("dd")].map((value) => ({
          left: value.getBoundingClientRect().left,
          align: getComputedStyle(value).textAlign,
          border: getComputedStyle(value).borderBottomWidth,
        })),
      })));
      for (const row of rows) {
        expect(new Set(row.labels).size).toBe(1);
        expect(new Set(row.values.map((value) => value.left)).size).toBe(1);
        for (const value of row.values) {
          expect(["start", "left"]).toContain(value.align);
          expect(value.border).toBe("1px");
        }
      }
      expect(await popup.evaluate((element) => element.getBoundingClientRect().width)).toBeLessThanOrEqual(Math.min(width - 24, 400));
      await popup.screenshot({ path: testInfo.outputPath("tooltip-detail.png") });
      await page.screenshot({ path: testInfo.outputPath("evidence-tooltip.png"), fullPage: true });
    });
  }
}

for (const theme of ["light", "dark"] as const) {
  for (const width of [390, 1440]) {
    test(`latest job evidence preserves the historical view at ${width}px in ${theme}`, async ({ page }, testInfo) => {
      const data = structuredClone(upstreamOverview);
      Object.assign(data.projects[0].jobs[0], { latest: {
        state: "failed", conclusion: "failure", at: "2026-10-29T11:00:00Z",
        url: "https://github.com/ggml-org/llama.cpp/actions/runs/100/job/101",
        runner: "ephemeral-devlab-gfx1151-slot-1",
      }, devlab_observed: true, runner_evidence_text: "Observed on devlab · 14-day collection window" });
      data.projects[0].status_labels.push({ id: "devlab", text: "devlab", tone: "neutral", tooltip: "gpu-rocm used an ephemeral-devlab-* runner in the 14-day collection window." });
      await page.route(new URL("upstream/overview.json", indexUrl).href, (route) => route.fulfill({ json: data }));
      await page.setViewportSize({ width, height: 1000 });
      await page.emulateMedia({ colorScheme: theme });
      await page.goto("./?track=upstream");
      const devlab = page.getByRole("button", { name: "devlab", exact: true });
      if (width <= 540) await devlab.click(); else await devlab.focus();
      await expect(page.getByRole(width <= 540 ? "region" : "tooltip", { name: "devlab" })).toContainText("ephemeral-devlab-*");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath("devlab-overview.png"), fullPage: true });
      await page.keyboard.press("Escape");
      await page.goto("./?track=upstream&view=ci&project=llamacpp");
      const labels = page.locator(".up-page-head .up-status-labels");
      await expect(labels.getByRole("button", { name: "devlab", exact: true })).toBeVisible();
      await expect(labels.locator("[title]")).toHaveCount(0);
      const upstream = labels.getByRole("button", { name: "upstream", exact: true });
      if (width <= 540) await upstream.click(); else await upstream.focus();
      await expect(width <= 540 ? page.getByRole("region", { name: "upstream", exact: true }) : page.getByRole("tooltip")).toContainText("Configured jobs:");
      await page.keyboard.press("Escape");
      await page.screenshot({ path: testInfo.outputPath("ci-header-labels.png"), fullPage: true });
      const job = page.locator(".up-mobile-job").filter({ has: page.locator("summary").filter({ hasText: /^gpu-rocm/ }) }).first();
      if (width <= 540) await job.locator("summary").click();
      else await page.getByRole("button", { name: "gpu-rocm", exact: true }).focus();
      const popup = width <= 540 ? job.locator(".mobile-evidence").first() : page.getByRole("dialog", { name: "gpu-rocm", exact: true });
      await expect(popup.locator(".up-latest-result")).toContainText("Failed");
      if (width <= 540) await expect(popup.getByText(/75%/)).toBeVisible();
      else await expect(popup.getByText("75%", { exact: true })).toBeVisible();
      await expect(popup.getByText("2026-10-29 11:00 UTC", { exact: true })).toBeVisible();
      await expect(popup.getByText("Observed on devlab · 14-day collection window", { exact: true })).toBeVisible();
      await expect(popup.getByRole("link", { name: "View latest job log" })).toHaveAttribute("href", "https://github.com/ggml-org/llama.cpp/actions/runs/100/job/101");
      expect(await popup.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
      await popup.screenshot({ path: testInfo.outputPath("latest-job-tooltip.png") });
      await page.screenshot({ path: testInfo.outputPath("latest-job-page.png"), fullPage: true });
      if (width <= 540) {
        await job.locator("summary").click();
        await expect(popup).toBeHidden();
        await expect(page.getByRole("article", { name: /^CI activity on / })).toHaveCount(14);
      } else {
        await page.keyboard.press("Escape");
        await expect(popup).toHaveCount(0);
        await expect(page.getByRole("table", { name: "Daily CI activity" })).toBeVisible();
      }
    });
  }
}

for (const theme of ["light", "dark"] as const) {
  for (const width of [390, 1440]) {
    test(`filter explanations and platform icons at ${width}px in ${theme}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 1000 });
      await page.emulateMedia({ colorScheme: theme });
      await page.goto("./?view=engine&version=10.1");
      if (width <= 540) await page.getByRole("button", { name: /^Qualification filters/ }).click();
      await expect(page.getByRole("button", { name: "Measured", exact: true })).toBeVisible();
      await page.getByRole("button", { name: "10.1", exact: true }).focus();
      await expect(page.getByRole("tooltip")).toContainText("Latest stable qualification track");
      await page.screenshot({ path: testInfo.outputPath("version-help.png"), fullPage: true });
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "10.2", exact: true }).hover();
      await expect(page.getByRole("tooltip")).toContainText("Nightly qualification track");
      await page.keyboard.press("Escape");
      const measured = page.getByRole("button", { name: "Measured", exact: true });
      await measured.focus();
      await expect(page.getByRole("tooltip")).toContainText("matching recorded performance measurements");
      await measured.click();
      await expect(measured).toHaveAttribute("aria-pressed", "true");
      await expect(page).toHaveURL(/performance=measured/);
      await page.goto("./?track=upstream&view=ci&project=llamacpp");
      if (width <= 540) await page.getByRole("button", { name: /^CI filters/ }).click();
      const platforms = page.getByRole("group", { name: "Platform", exact: true });
      await expect(platforms.locator('[data-platform="linux"]')).toBeVisible();
      await expect(platforms.locator('[data-platform="windows"]')).toBeVisible();
      await page.getByRole("button", { name: "About Stack", exact: true }).focus();
      await expect(page.getByRole("tooltip")).toContainText("configured software stack");
      await page.screenshot({ path: testInfo.outputPath("upstream-filter-help.png"), fullPage: true });
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "About Target", exact: true }).focus();
      await expect(page.getByRole("tooltip")).toContainText("configured hardware target");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    });
  }
}

test.describe("touch filter help", () => {
  test.use({ hasTouch: true });
  test("opens filter explanations by touch", async ({ page }) => {
    await page.goto("./?track=upstream&view=ci&project=llamacpp");
    const filters = page.getByRole("button", { name: /^CI filters/ });
    if (await filters.isVisible()) await filters.tap();
    await page.getByRole("button", { name: "About Target", exact: true }).tap();
    await expect(page.getByRole("tooltip")).toContainText("configured hardware target");
  });
});


test.describe("phone daily activity disclosures", () => {
  test.use({ hasTouch: true });
  for (const width of [320, 430, 540]) {
    for (const theme of ["light", "dark"] as const) {
      test(`day evidence stays in its row at ${width}px in ${theme}`, async ({ page }, testInfo) => {
        await page.setViewportSize({ width, height: 932 });
        await page.emulateMedia({ colorScheme: theme });
        await page.route(new URL("upstream/overview.json", indexUrl).href, (route) => route.fulfill({ json: {
          ...upstreamOverview, projects: upstreamOverview.projects.map((project) => project.id !== "llamacpp" ? project : {
            ...project, jobs: [...project.jobs, { ...project.jobs[0], id: "build-example", label: "Example build", category: "builds", daily: { "2026-10-27": { passed: 2, failed: 0, running: 0, other: 0, stalled: 0, skipped: 0, slow: 0 } } }],
          }),
        } }));
        await page.goto("./?track=upstream&view=ci&project=llamacpp");
        const row = page.getByRole("article", { name: "CI activity on 2026-10-27 UTC", exact: true });
        const toggle = row.getByRole("button", { name: /^2026-10-27:/ });
        await toggle.tap();
        await expect(toggle).toHaveAttribute("aria-expanded", "true");
        await expect(row.getByRole("link", { name: "Job log at 10:00 UTC · failed" })).toBeVisible();
        await expect(row.getByRole("region", { name: "Runs on 2026-10-27" })).toBeVisible();
        expect(await row.locator(".up-mobile-day-evidence").evaluate((element) => element.closest("table") === null)).toBe(true);
        await row.getByRole("button", { name: /^builds ·/ }).tap();
        await expect(page).toHaveURL(/activity=cat%3Abuilds/);
        await expect(toggle).toHaveAttribute("aria-expanded", "true");
        await expect(row.locator(".up-run-summary")).toContainText("2");
        await page.reload();
        await expect(toggle).toHaveAttribute("aria-expanded", "true");
        await expect(row.getByRole("button", { name: /^builds ·/ })).toHaveAttribute("aria-pressed", "true");
        await page.goBack();
        await expect(row.getByRole("button", { name: /^tests ·/ })).toHaveAttribute("aria-pressed", "true");
        const stats = page.getByRole("group", { name: "CI metrics", exact: true });
        const geometry = await stats.locator(".up-stat").evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().toJSON()));
        expect(geometry.length).toBeGreaterThan(1);
        expect(new Set(geometry.map((box) => box.x)).size).toBe(2);
        expect(geometry[1].y).toBe(geometry[0].y);
        for (const box of geometry) expect(Math.abs(box.width - box.height)).toBeLessThan(2);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await row.screenshot({ path: testInfo.outputPath("inline-day-evidence.png") });
        await toggle.tap();
        await expect(toggle).toHaveAttribute("aria-expanded", "false");
        await expect(row.getByRole("region", { name: "Runs on 2026-10-27" })).toHaveCount(0);
      });
    }
  }
});
