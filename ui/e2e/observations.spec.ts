import { expect, test, type Page } from "@playwright/test";
import { fixtureFetch, index, indexUrl, pointer } from "../src/fixtures";
import { upstreamOverview } from "../src/upstream/fixtures";
import type { UpstreamOverview } from "../src/upstream/data";

const live = "https://raw.githubusercontent.com/lemonade-sdk/rocm-readiness/main/data/notifications.json";
const assessment = {
  id: "readiness-missing", rule_id: "missing", rule_version: 1, evaluated_at: "2026-11-02T15:00:00Z",
  actionable: true, classification: "unexplained", summary: "Current scope has no observed result.",
  explanation: "No confirmed producer reason is available.", observed: {}, expected: {}, evidence: [],
  scope: { source_id: "llamacpp-stable-qualification", repository: "lemonade-sdk/llama.cpp",
    rocm_version: "10.1", channel: "stable", platform: "linux", date: "2026-11-02" },
  notification: {
    github: { status: "sent", url: "https://github.com/lemonade-sdk/rocm-readiness/issues/123" },
    email: { status: "disabled" }, status: "pending",
  },
};

async function expectConsistentStatusIconSize(page: Page) {
  const sizes = await page.locator("svg.table-status-glyph:visible").evaluateAll((icons) => {
    const expected = parseFloat(getComputedStyle(document.documentElement).fontSize);
    return icons.map((icon) => {
      const { width, height } = icon.getBoundingClientRect();
      return { outcome: icon.getAttribute("data-outcome"), width, height, expected };
    });
  });
  expect(sizes.length).toBeGreaterThan(0);
  for (const { outcome, width, height, expected } of sizes) {
    expect(width, `${outcome} icon width`).toBeCloseTo(expected, 1);
    expect(height, `${outcome} icon height`).toBeCloseTo(expected, 1);
  }
}

test.use({ hasTouch: true });
for (const theme of ["light", "dark"] as const) {
  for (const width of [390, 1440]) {
    test(`missing observations and exact dispatch evidence at ${width}px in ${theme}`, async ({ page }, testInfo) => {
      await page.clock.setFixedTime(new Date("2026-11-02T15:00:00Z"));
      await page.setViewportSize({ width, height: 1000 });
      await page.emulateMedia({ colorScheme: theme });
      const healthyOverview = structuredClone(upstreamOverview) as UpstreamOverview;
      healthyOverview.projects[0].jobs[0].daily["2026-10-25"] = {
        passed: 2, failed: 0, running: 0, other: 0, stalled: 0, skipped: 0, slow: 0,
      };
      const fixture = fixtureFetch({
        "https://raw.githubusercontent.com/lemonade-sdk/rocm-readiness/main/data/latest.json": {
          ...pointer, notifications_url: live,
        },
        [indexUrl]: { ...index, upstream: { schema_version: 1, overview: "upstream/overview.json", project_count: 2, status: "fresh" } },
        [new URL("upstream/overview.json", indexUrl).href]: healthyOverview,
        [live]: { schema_version: 1, generated_at: assessment.evaluated_at, assessments: [
          assessment,
          { ...assessment, id: "readiness-warning", summary: "Producer warning",
            classification: "explained_abnormal", explanation: "Compiler warning.",
            scope: { ...assessment.scope, platform: "windows", date: "2026-10-29" },
            notification: { github: { status: "sent", url: "https://github.com/lemonade-sdk/rocm-readiness/issues/124" },
              email: { status: "disabled" }, status: "sent" },
          },
          { ...assessment, id: "upstream-missing", summary: "No upstream job observation.",
            scope: { source_id: "llamacpp-upstream", repository: "ggml-org/llama.cpp", workflow: "ci.yml",
              job: "gpu-rocm", platform: "linux", target: "gfx1151", date: "2026-10-26" },
            notification: { github: { status: "failed" }, status: "failed" },
          },
        ] },
      });
      await page.route("https://raw.githubusercontent.com/**", async (route) => {
        const response = await fixture(route.request().url());
        await route.fulfill({ status: response.status, body: await response.text(), contentType: "application/json" });
      });
      await page.goto("./");
      const healthy = page.locator("a.build-mark.pass:not([aria-label*='warnings'])").first();
      await expect(healthy).toHaveCSS("text-decoration-line", "none");
      if (width > 540) {
        await healthy.hover();
        const evidence = page.getByRole("dialog");
        await expect(evidence).toContainText("Produced");
        await expect(evidence.locator(".cell-explanation")).toHaveCount(0);
        await expect(evidence).not.toContainText("No applicable assessment");
        await page.keyboard.press("Escape");
        await page.mouse.move(0, 0);
        const warning = page.locator("a.build-mark.pass[aria-label*='warnings']").first();
        await warning.hover();
        const warningEvidence = page.getByRole("dialog");
        await expect(warningEvidence).toContainText("Compiler warning.");
        const existingValue = await warningEvidence.locator(".build-tooltip-details dd").first().boundingBox();
        const addedValue = await warningEvidence.locator(".assessment-explanation dd").first().boundingBox();
        expect(Math.abs(existingValue!.x - addedValue!.x)).toBeLessThan(1);
        await expect(warningEvidence.getByRole("link", { name: "View investigation" })).toHaveAttribute(
          "href", "https://github.com/lemonade-sdk/rocm-readiness/issues/124",
        );
        await page.keyboard.press("Escape");
        await page.mouse.move(0, 0);
      }
      const missing = page.getByRole("button", { name: "2026-11-02 UTC · ROCm 10.1 stable · Linux · No observation", exact: true });
      await expect(missing.locator('svg[data-outcome="unreported"]')).toBeVisible();
      await expectConsistentStatusIconSize(page);
      await expect(missing).toHaveCSS("text-decoration-line", "none");
      await expect(page.locator("details.notification-summary")).toHaveCount(0);
      await expect(page.getByText("Team notified.")).toHaveCount(0);
      if (width > 540) await missing.hover();
      else await missing.tap();
      await expect(missing).toHaveCSS("text-decoration-line", "none");
      const readinessEvidence = width <= 540
        ? page.getByRole("region", { name: await missing.getAttribute("aria-label") as string, exact: true })
        : page.getByRole("dialog", { name: await missing.getAttribute("aria-label") as string, exact: true });
      await expect(readinessEvidence.locator(".structured-tooltip-header strong")).toHaveText("2026-11-02 · Linux");
      await expect(readinessEvidence).toContainText("Team notified.");
      await expect(readinessEvidence.getByText("Email", { exact: true })).toHaveCount(0);
      await expect(readinessEvidence).not.toContainText("Email accepted");
      await expect(readinessEvidence.locator(".assessment-explanation dl")).toHaveCSS("display", "grid");
      await expect(readinessEvidence.locator("dt").filter({ hasText: "Investigation" })).toHaveCount(1);
      await expect(readinessEvidence).not.toContainText("No confirmed producer reason");
      await expect(readinessEvidence.getByRole("link", { name: "View investigation" })).toHaveAttribute("href", assessment.notification.github.url);
      await expect(page.getByRole("region", { name: "llama.cpp ROCm 10.1 stable", exact: true })
        .getByRole("list", { name: "llama.cpp stable qualification legend" })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath("readiness-missing.png"), fullPage: true });
      await page.keyboard.press("Escape");
      await page.goto("./?track=upstream");
      const calendar = page.getByRole("region", { name: "llama.cpp activity calendar", exact: true });
      const healthyUpstream = calendar.getByRole("link", { name: "2026-10-25: 2 passed, 0 failed of 2 runs", exact: true });
      await expect(healthyUpstream).toHaveAttribute("href", /day=2026-10-25/);
      if (width > 540) {
        await healthyUpstream.hover();
        const compact = page.getByRole("tooltip").filter({ hasText: "2026-10-25" });
        await expect(compact).toContainText("2026-10-25");
        await expect(compact.locator(".up-run-summary dt")).toHaveText(["Passed", "Failed", "Total runs"]);
        await expect(compact.locator(".up-run-summary dd")).toHaveText(["2", "0", "2"]);
        await expect(compact.locator(".cell-explanation")).toHaveCount(0);
        await expect(compact).not.toContainText("No applicable assessment");
        await expect(compact).not.toContainText("Snapshot collected");
        const bounds = await compact.boundingBox();
        expect(bounds?.height).toBeLessThan(200);
        await page.keyboard.press("Escape");
        await page.mouse.move(0, 0);
      }
      const upstreamMissing = calendar.getByRole("button", { name: "2026-10-26: No observation", exact: true }).first();
      await expect(upstreamMissing.locator('svg[data-outcome="unreported"]')).toBeVisible();
      await expectConsistentStatusIconSize(page);
      if (width > 540) await upstreamMissing.hover();
      else await upstreamMissing.tap();
      const upstreamEvidence = width <= 540
        ? page.getByRole("region", { name: "2026-10-26: No observation", exact: true })
        : page.getByRole("dialog", { name: "2026-10-26: No observation", exact: true });
      await expect(upstreamEvidence).toContainText("No upstream job observation.");
      await expect(upstreamEvidence).not.toContainText("could not be created");
      await expect(upstreamEvidence.locator(".assessment-investigation")).toHaveCount(0);
      await expect(upstreamEvidence.getByText("Email", { exact: true })).toHaveCount(0);
      await expect(upstreamEvidence).not.toContainText("Team notified");
      await expect(upstreamEvidence.getByRole("link", { name: "View investigation" })).toHaveCount(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath("upstream-missing.png"), fullPage: true });
    });
  }
}
