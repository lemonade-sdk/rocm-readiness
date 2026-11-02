import { expect, test } from "@playwright/test";
import {
  index,
  indexUrl,
  overview,
  pointer,
  historyFixture,
  executionAttempt,
} from "../src/fixtures";

test("combined engine scope separates historical metrics and supports model/back/reset navigation", async ({
  page,
}, testInfo) => {
  const attempt = { ...executionAttempt(), source_id: "bench" };
  await page.route("https://raw.githubusercontent.com/**", async (route) => {
    const url = route.request().url();
    if (url.endsWith("/main/data/latest.json"))
      return route.fulfill({ json: pointer });
    if (url === indexUrl)
      return route.fulfill({
        json: {
          ...index,
          sources: [
            {
              id: "bench",
              engine: "llamacpp",
              channel: "stable",
              status: "ok",
            },
          ],
        },
      });
    if (url.includes("/overview.json"))
      return route.fulfill({
        json: {
          ...overview(),
          execution: {
            path: "rocm/10.1/executions.json",
            attempt_count: 1,
            summaries: [],
          },
        },
      });
    if (url.includes("/history/"))
      return route.fulfill({ json: historyFixture() });
    if (url.endsWith("executions.json"))
      return route.fulfill({
        json: {
          schema_version: 1,
          rocm_version: "10.1",
          attempts: [attempt],
          summaries: [],
        },
      });
    if (url.endsWith("performance.json"))
      return route.fulfill({
        json: {
          schema_version: 2,
          systems: [],
          measurements: [
            {
              source_id: "bench",
              engine: "llamacpp",
              channel: "stable",
              backend: "rocm",
              model: "Historical ordinary model",
              scenario: "context-32k",
              quant: "Q4_K_M",
              system_id: null,
              context_size: 32768,
              input_tokens: 24035,
              measured_at: "2026-10-27T19:26:37Z",
              rocm_version: "10.1",
              package_os: "linux",
              engine_version: "b-older",
              qualification_build_id: null,
              metrics: {
                tg_tps: 12,
                pp_tps: 240,
                ttft_ms_mean: 250,
                vram_peak_gb: 20,
              },
            },
          ],
        },
      });
    return route.fulfill({ status: 404, body: "{}" });
  });
  await page.goto(
    "./?version=10.1&view=engine&engine=llamacpp&build=linux-build&source=llamacpp-stable-qualification&platform=linux",
  );
  await expect(
    page.getByRole("heading", { name: "Engine build and model overview" }),
  ).toBeVisible();
  await expect(
    page.getByText(/No exactly associated model measurements/),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Historical ordinary model", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("link", { name: "Show all engine builds" }).click();
  const model = page.getByRole("link", {
    name: "Historical ordinary model",
    exact: true,
  });
  await expect(model).toBeVisible();
  await expect(
    page.getByText(/1 recorded attempts in this scope/),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("page2.png"),
    fullPage: true,
  });
  await model.click();
  await expect(page).toHaveURL(/view=model/);
  await expect(
    page.getByRole("heading", { name: "Measurement history" }),
  ).toBeVisible();
  await expect(
    page.getByText(/Answer accuracy: unavailable/).first(),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("page3a.png"),
    fullPage: true,
  });
  await page.getByRole("link", { name: /Back to models/ }).click();
  await expect(page).toHaveURL(/view=engine/);
  await page.goBack();
  await expect(page).toHaveURL(/view=model/);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
