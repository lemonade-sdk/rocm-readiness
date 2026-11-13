import { expect, test } from "@playwright/test";
import { fixtureFetch, historyFixture, indexUrl, overview, pointer } from "../src/fixtures";

const model = "Qwen3-very-long-model-name-with-recorded-configuration";
test.use({ hasTouch: true });
test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-11-02T15:00:00Z"));
  const fixture = fixtureFetch({
    [new URL("rocm/10.1/overview.json", indexUrl).href]: {
      ...overview(), performance: { status: "available", path: "rocm/10.1/performance.json", measurement_count: 1 },
    },
    [new URL("rocm/10.1/performance.json", indexUrl).href]: {
      schema_version: 2, systems: [], measurements: [{
        source_id: "bench", engine: "llamacpp", channel: "stable", backend: "rocm", engine_version: "b11972",
        model, scenario: "context-4k", quant: "Q4_K_M", context_size: 4096, input_tokens: 128,
        measured_at: "2026-10-29T12:00:00Z", package_os: "linux", rocm_version: "10.1",
        metrics: { tps_mean: 72.4, ttft_ms_mean: 310 },
      }],
    },
  });
  await page.route("https://raw.githubusercontent.com/**", async (route) => {
    const response = await fixture(route.request().url());
    await route.fulfill({ status: response.status, body: await response.text(), contentType: "application/json" });
  });
});

for (const width of [430, 540, 768]) {
  test(`warning spacing and qualification tier disclosures at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 1024 });
    await page.route("**/main/data/latest.json", (route) => route.fulfill({ json: {
      ...pointer, sync: { ...pointer.sync, status: "failed", errors: [{ source_id: "stable", record: "", field: "feed", reason: "Controlled feed failure" }] },
    } }));
    await page.route("**/history/2026-10.json", (route) => route.fulfill({ json: {
      ...historyFixture(), builds: historyFixture().builds.map((build) => ({ ...build,
        tier_verdicts: { tier0: "pass", tier1: "fail" }, results: { "T0.1": "pass", "T1.1": "fail" },
      })),
    } }));
    await page.goto("./?view=engine&version=10.1");
    const notice = page.locator("main > .notice.warning");
    await expect(notice).toContainText("Controlled feed failure");
    const spacing = await notice.evaluate((element) => {
      const style = getComputedStyle(element);
      return { padding: parseFloat(style.padding), bottom: parseFloat(style.marginBottom), radius: style.borderRadius };
    });
    expect(spacing.padding).toBeGreaterThanOrEqual(16);
    expect(spacing.bottom).toBeGreaterThanOrEqual(16);
    expect(spacing.radius).toBe("0px");
    if (width <= 540) {
      const card = page.getByRole("article", { name: "b11972 · Linux", exact: true }).first();
      const tier0 = card.getByText("Tier 0", { exact: true });
      const tier1 = card.getByText("Tier 1", { exact: true });
      await expect(tier0).toBeVisible();
      await expect(tier1).toBeVisible();
      const first = await tier0.boundingBox();
      const check = await card.getByRole("button", { name: "T0.1 · Pass", exact: true }).boundingBox();
      expect(check!.y - (first!.y + first!.height)).toBeGreaterThanOrEqual(6);
      const toggle = card.getByRole("button", { name: "Package details for b11972", exact: true });
      const before = await toggle.evaluate((element) => ({ content: getComputedStyle(element, "::before").content, transform: getComputedStyle(element, "::before").transform }));
      expect(before.content).not.toBe("none");
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-expanded", "true");
      expect(await toggle.evaluate((element) => getComputedStyle(element, "::before").transform)).not.toBe(before.transform);
      await card.screenshot({ path: testInfo.outputPath("tier-card.png") });
    }
    await page.screenshot({ path: testInfo.outputPath("warning.png") });
  });
}

for (const theme of ["light", "dark"] as const) {
  for (const [width, height] of [[320, 700], [390, 844], [430, 932], [540, 720], [541, 720], [768, 1024], [834, 1194], [1024, 1366], [1024, 768], [1194, 834], [1279, 800], [1280, 800], [1366, 1024]]) {
    test(`records and navigation fit ${width}x${height} ${theme}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height });
      await page.emulateMedia({ colorScheme: theme });
      await page.goto("./?view=performance&version=10.1");
      const compact = width < 1280;
      const navigation = page.getByRole("button", { name: "Navigation", exact: true });
      if (compact) {
        await expect(navigation).toBeVisible();
        const menuButton = await navigation.boundingBox();
        const brand = await page.locator(".header .brand").boundingBox();
        expect(menuButton!.x + menuButton!.width).toBeLessThanOrEqual(brand!.x);
        expect(Math.abs(menuButton!.y + menuButton!.height / 2 - (brand!.y + brand!.height / 2))).toBeLessThan(2);
        await expect(page.getByRole("complementary", { name: "Workspaces" })).toBeHidden();
        await navigation.click();
        const menu = page.getByRole("complementary", { name: "Workspaces" });
        const overviewLink = menu.getByRole("link", { name: "Overview", exact: true });
        const qualificationLink = menu.getByRole("link", { name: "Build Qualification", exact: true });
        const performanceLink = menu.getByRole("link", { name: "Performance", exact: true });
        const positions = await Promise.all([overviewLink, qualificationLink, performanceLink].map((link) => link.boundingBox()));
        expect(positions[1]!.x).toBeGreaterThan(positions[0]!.x);
        expect(positions[2]!.x).toBeGreaterThan(positions[1]!.x);
        expect(positions[1]!.y).toBeGreaterThan(positions[0]!.y);
        expect(positions[2]!.y).toBeGreaterThan(positions[1]!.y);
        await expect(menu.getByRole("list", { name: "Overview pages", exact: true }).getByRole("link", { name: "Build Qualification", exact: true })).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath("navigation.png") });
        // Selecting the current page closes the menu too, without needing a URL change.
        await performanceLink.click();
        await expect(menu).toBeHidden();
        await navigation.click();
        await menu.getByRole("link", { name: "Overview", exact: true }).focus();
        await page.keyboard.press("Escape");
        await expect(menu).toBeHidden();
        await expect(navigation).toBeFocused();
      } else {
        await expect(navigation).toBeHidden();
        await expect(page.getByRole("complementary", { name: "Workspaces" })).toBeVisible();
      }
      if (width <= 640) {
        const card = page.getByRole("article", { name: `${model} · 4K` });
        await expect(card).toBeVisible();
        await expect(page.getByRole("table")).toHaveCount(0);
        await expect(card.getByText("72.4 tok/s", { exact: true }).first()).toBeVisible();
        await expect(card.getByText("Not recorded", { exact: true }).first()).toBeVisible();
        // Keep the first card near the header as its description wraps on phones.
        const header = await page.locator("header.header").boundingBox();
        expect((await card.boundingBox())!.y - (header!.y + header!.height)).toBeLessThan(160);
        await card.locator("summary").tap();
        await expect(card.getByText("Test configuration")).toBeVisible();
        await expect(card.getByText("Hardware metadata unavailable")).toBeVisible();
        await expect(page.getByRole("dialog")).toHaveCount(0);
        const filter = page.getByRole("button", { name: "Performance filters", exact: true });
        await filter.click();
        await expect(page.getByRole("combobox", { name: "Model", exact: true })).toBeVisible();
        await page.getByRole("combobox", { name: "Sort measurements", exact: true }).selectOption("tps");
        await expect(page).toHaveURL(/sort=tps/);
        await filter.click();
        await expect(page.getByRole("combobox", { name: "Model", exact: true })).toBeHidden();
      } else {
        await expect(page.getByRole("table")).toBeVisible();
        await expect(page.getByRole("article", { name: `${model} · 4K` })).toHaveCount(0);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath("performance.png"), fullPage: false });
      if (compact) await navigation.click();
      await page.getByRole("link", { name: "Build Qualification", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Package qualification", exact: true })).toBeVisible();
      if (width <= 640) {
        const card = page.getByRole("article", { name: "b11972 · Linux", exact: true }).first();
        await expect(card).toBeVisible();
        await card.getByRole("button", { name: "Package details for b11972", exact: true }).click();
        const evidence = card.getByRole("region", { name: "Package details for b11972", exact: true });
        await expect(evidence).toBeVisible();
        expect(await evidence.evaluate((element) => Boolean(element.closest("table")))).toBe(false);
        if (width <= 540) await card.getByRole("button", { name: "Package details for b11972", exact: true }).click();
        else await evidence.getByRole("button", { name: "Close evidence" }).click();
        await expect(evidence).toHaveCount(0);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath("qualification.png"), fullPage: false });
    });
  }
}

for (const width of [430, 540, 541]) {
  test(`shared evidence formatting and filter alignment at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 932 });
    await page.goto("./?view=performance&version=10.1");
    await page.getByRole("button", { name: "Performance filters", exact: true }).click();
    const model = await page.getByRole("combobox", { name: "Model", exact: true }).boundingBox();
    const search = await page.getByRole("searchbox", { name: "Find build" }).boundingBox();
    expect(Math.abs(model!.x - search!.x)).toBeLessThan(1);
    expect(Math.abs(model!.width - search!.width)).toBeLessThan(1);
    const sorting = await page.getByRole("combobox", { name: "Sort measurements", exact: true }).boundingBox();
    const reverse = await page.getByRole("button", { name: "Reverse measurement sort" }).boundingBox();
    expect(Math.abs(sorting!.y - reverse!.y)).toBeLessThan(1);
    expect(reverse!.width).toBeGreaterThanOrEqual(44);
    await page.screenshot({ path: testInfo.outputPath("aligned-filters.png"), fullPage: false });
    await page.getByRole("button", { name: "Performance filters", exact: true }).click();
    const measurement = page.getByRole("article").first();
    await measurement.locator("summary").click();
    const measuredTerm = measurement.locator("dt").filter({ hasText: /^Quantization$/ });
    const geometry = await measuredTerm.evaluate((term) => ({ label: term.getBoundingClientRect().toJSON(), value: term.nextElementSibling!.getBoundingClientRect().toJSON() }));
    if (width <= 540) expect(geometry.value.y).toBeGreaterThanOrEqual(geometry.label.bottom);
    else expect(geometry.value.x).toBeGreaterThan(geometry.label.x);
    await page.route("**/history/2026-10.json", (route) => route.fulfill({ json: {
      ...historyFixture(), builds: historyFixture().builds.map((build) => ({ ...build, tier_verdicts: { tier0: "pass" }, results: { "T0.1": "pass" } })),
    } }));
    await page.goto("./?view=engine&version=10.1");
    const card = page.getByRole("article", { name: "b11972 · Linux", exact: true }).first();
    const toggle = card.getByRole("button", { name: "Package details for b11972", exact: true });
    await card.getByRole("button", { name: "T0.1 · Pass", exact: true }).click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    if (width <= 540) await expect(card.getByRole("button", { name: "Close evidence" })).toHaveCount(0);
    await toggle.click();
    await expect(card.getByRole("region", { name: "T0.1 · Pass", exact: true })).toHaveCount(0);
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await toggle.click();
    const term = card.locator("dt").filter({ hasText: /^Feed build ID$/ });
    const packageGeometry = await term.evaluate((element) => ({ label: element.getBoundingClientRect().toJSON(), value: element.nextElementSibling!.getBoundingClientRect().toJSON() }));
    if (width <= 540) expect(packageGeometry.value.y).toBeGreaterThanOrEqual(packageGeometry.label.bottom);
    else expect(packageGeometry.value.x).toBeGreaterThan(packageGeometry.label.x);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await card.screenshot({ path: testInfo.outputPath("shared-package-evidence.png") });
  });
}

for (const width of [320, 430, 540, 541, 768]) {
  test(`overview and qualification trends change direction at 540px (${width}px)`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 932 });
    await page.goto("./?view=overview&version=10.1");
    const history = page.getByRole("region", { name: "ROCm 10.1", exact: true }).getByRole("region", { name: "llama.cpp stable build history", exact: true });
    if (width <= 540) {
      await expect(history.getByRole("columnheader", { name: "Date · UTC", exact: true })).toBeVisible();
      await expect(history.getByRole("rowheader")).toHaveCount(14);
      expect(await history.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    } else await expect(history.locator(".build-timeline")).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("overview-calendar.png"), fullPage: false });
    await page.goto("./?view=engine&version=10.1");
    const bars = page.locator(".qualification-trend-stack").first();
    if (width <= 540) {
      await expect(bars).toHaveAttribute("data-horizontal", "true");
      const scroll = page.getByRole("region", { name: "Linux chart dates", exact: true });
      expect(await scroll.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    } else await expect(bars).not.toHaveAttribute("data-horizontal", "true");
    if (width <= 640) await expect(page.getByRole("heading", { name: "ROCm 10.1", exact: true })).toHaveCount(1);
    const groups = page.locator(".qualification-mobile-release");
    const legends = groups.getByRole("list", { name: "Check outcomes", exact: true });
    await expect(legends).toHaveCount(await groups.count());
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("vertical-qualification.png"), fullPage: false });
  });
}

for (const theme of ["light", "dark"] as const) {
  test(`qualification date expands packages inside its own row in ${theme}`, async ({ page }) => {
    await page.route("**/history/2026-10.json", (route) => route.fulfill({ json: {
      ...historyFixture(), builds: historyFixture().builds.map((build) => ({ ...build,
        tier_verdicts: { tier0: "pass", tier1: "fail" }, results: { "T0.1": "pass", "T1.1": "fail" },
      })),
    } }));
    await page.setViewportSize({ width: 430, height: 932 });
    await page.emulateMedia({ colorScheme: theme });
    await page.goto("./?view=engine&version=10.1&platform=linux");
    const row = page.locator(".qualification-phone-day").filter({ has: page.locator('time[datetime="2026-10-29"]') });
    const toggle = row.getByRole("button", { name: /^2026-10-29 UTC/ });
    await toggle.tap();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(row.getByRole("heading", { name: "Package qualification", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Package qualification", exact: true })).toHaveCount(1);
    await page.reload();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(row.locator(".qualification-mobile-card").first()).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const check = row.locator(".qualification-check-block").first();
    const checkBox = await check.boundingBox();
    expect(checkBox?.width).toBeGreaterThanOrEqual(40);
    expect(Math.abs(checkBox!.width - checkBox!.height)).toBeLessThan(2);
    await toggle.tap();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(row.locator(".qualification-day-evidence")).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}
