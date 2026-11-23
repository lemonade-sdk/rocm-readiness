import { expect, test } from "@playwright/test";
import { indexUrl, pointer } from "../src/fixtures";
import { upstreamFetch, upstreamOverview, upstreamRuns } from "../src/upstream/fixtures";
import type { UpstreamOverview } from "../src/upstream/data";

const live = "https://raw.githubusercontent.com/lemonade-sdk/rocm-readiness/main/data/notifications.json";
const finding = "Some tests in the job have failed.";
const jobUrl = (id: number) => `https://github.com/ggml-org/llama.cpp/actions/runs/1/job/${id}`;

test.use({ hasTouch: true });
for (const theme of ["light", "dark"] as const) {
  for (const width of [390, 1440]) {
    test(`groups equivalent failure explanations and retains evidence at ${width}px in ${theme}`, async ({ page }, testInfo) => {
      await page.clock.setFixedTime(new Date("2026-10-29T16:20:05Z"));
      await page.setViewportSize({ width, height: 1000 });
      await page.emulateMedia({ colorScheme: theme });

      const overview = structuredClone(upstreamOverview) as UpstreamOverview;
      const firstJob = overview.projects[0].jobs[0];
      const secondJob = { ...structuredClone(firstJob), id: "gpu-rocm-gfx1201", label: "gpu-rocm-gfx1201", target: "gfx1201" };
      overview.projects[0].jobs.push(secondJob);
      overview.projects[0].files[0].run_count = upstreamRuns.runs.length + 1;
      const failure = {
        id: "gfx1151-failure", rule_id: "producer_failure", rule_version: 1,
        evaluated_at: "2026-10-29T16:20:05Z", actionable: true, classification: "unexplained",
        summary: finding, explanation: "The test command returned a nonzero exit code.",
        scope: { source_id: "llamacpp-upstream", repository: "ggml-org/llama.cpp", workflow: "ci.yml",
          job: "gpu-rocm", platform: "linux", target: "gfx1151", date: "2026-10-27" },
        observed: {}, expected: {}, evidence: [{ label: "Job", url: jobUrl(11) }],
        provenance: { repository: "ggml-org/llama.cpp", run_id: "1", job_id: "11" },
      };
      const secondFailure = { ...failure, id: "gfx1201-failure",
        provenance: { ...failure.provenance, job_id: "12" },
        scope: { ...failure.scope, job: secondJob.id, target: "gfx1201" },
        evidence: [{ label: "Job", url: jobUrl(12) }, { label: "Job", url: jobUrl(11) }],
      };
      const fixture = upstreamFetch({
        "https://raw.githubusercontent.com/lemonade-sdk/rocm-readiness/main/data/latest.json": {
          ...pointer, notifications_url: live,
        },
        [new URL("upstream/overview.json", indexUrl).href]: overview,
        [new URL("upstream/llamacpp/ci/2026-10.json", indexUrl).href]: {
          ...upstreamRuns, runs: [...upstreamRuns.runs,
            { ...upstreamRuns.runs[0], job: secondJob.id, job_id: "12", url: jobUrl(12), created_at: "2026-10-27T12:00:00Z" },
          ],
        },
        [live]: { schema_version: 1, generated_at: failure.evaluated_at, dry_run: true,
          assessments: [failure, secondFailure,
            { ...secondFailure, id: "different-finding", rule_id: "compiler_failure", summary: "The compiler could not find a required header.",
              evidence: [{ label: "Compiler log", url: jobUrl(12) }],
            },
          ],
        },
      });
      await page.route("https://raw.githubusercontent.com/**", async (route) => {
        const response = await fixture(route.request().url());
        await route.fulfill({ status: response.status, body: await response.text(), contentType: "application/json" });
      });
      await page.goto("./?track=upstream");
      const calendar = page.getByRole("region", { name: "llama.cpp activity calendar", exact: true });
      const label = "2026-10-27: 6 passed, 2 failed of 8 runs";
      const day = calendar.getByRole("button", { name: label, exact: true });
      if (width <= 540) await day.tap();
      else await day.click();
      const evidence = page.getByRole(width <= 540 ? "region" : "dialog", { name: label, exact: true });
      const summary = evidence.locator(".up-run-summary");
      await expect(summary.locator("dt")).toHaveText(["Passed", "Failed", "Total runs"]);
      await expect(summary.locator("dd")).toHaveText(["6", "2", "8"]);
      await expect(evidence.getByText(label, { exact: true })).toHaveCount(0);
      const grouped = evidence.locator(".assessment-explanation").filter({ has: page.getByText(finding, { exact: true }) });
      await expect(evidence.getByText(finding, { exact: true })).toHaveCount(1);
      await expect(grouped.locator("dt")).toHaveText(["Finding", "Investigation", "Evidence"]);
      await expect(grouped.getByText("Preview only; no new notification sent.", { exact: true })).toHaveCount(1);
      await expect(grouped.getByRole("link", { name: /^Job(?:\s|$)/ })).toHaveCount(2);
      for (const id of [11, 12]) await expect(grouped.locator(`a[href="${jobUrl(id)}"]`)).toHaveCount(1);
      await expect(evidence.getByText("The compiler could not find a required header.", { exact: true })).toBeVisible();
      await expect(evidence.locator(".assessment-explanation")).toHaveCount(2);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath("grouped-failure-evidence.png"), fullPage: true });

      await evidence.getByRole("link", { name: /^View CI activity(?:\s|$)/ }).click();
      await expect(page).toHaveURL(/view=ci/);
      await expect(page).toHaveURL(/day=2026-10-27/);
      await expect(page.getByRole("region", { name: "Runs on 2026-10-27", exact: true })).toBeVisible();
      await expect(page.getByRole("link", { name: /^Job log at 10:00 UTC · failed(?:\s|$)/ })).toBeVisible();
    });
  }
}
