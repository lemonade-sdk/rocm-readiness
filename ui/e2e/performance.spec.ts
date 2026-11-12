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

function measurements(version: string, quant = "Q4_K_M") {
  return {
    schema_version: 2,
    benchmark_assessment: {
      message: "Measurements are from benchmarked llama.cpp builds. Benchmarks may trail releases.",
      last_run_label: "Last run: 2026-10-29 12:00:00 UTC.",
    },
    systems: [
      {
        id: "rig",
        source_id: "bench",
        cpu: "Fixture CPU",
        gpu: "Fixture GPU",
        gpu_full: [{ name: "Fixture GPU" }],
        os: "linux",
        ram_gb: 64,
        vram_gb: 16,
        gfx_target: "gfx1151",
      },
    ],
    measurements: [
      {
        source_id: "bench",
        engine: "llamacpp",
        channel: "nightly",
        backend: "rocm",
        fork_id: "llamacpp-rocm-nightly",
        engine_repository: "lemonade-sdk/llamacpp-rocm",
        engine_version: "b100",
        model: "Fixture model",
        scenario: "short-prompt",
        quant,
        system_id: "rig",
        context_size: 4096,
        input_tokens: 128,
        measured_at: "2026-10-29T12:00:00Z",
        rocm_version: version,
        package_os: "linux",
        qualification_build_id: null,
        package_url: `https://github.com/lemonade-sdk/llamacpp-rocm/releases/download/b100/llama-b100-ubuntu-rocm-gfx1151-x64.tar.gz`,
        metrics: { pp_tps: 120, tg_tps: version === "10.1" ? 12 : 10, ttft_ms_mean: 250 },
      },
    ],
  };
}

{
  test(
    "shares model details without refreshing the pointer",
    async ({ page }) => {
      const reads: string[] = [];
      page.on("request", (request) => {
        if (request.url().includes("raw.githubusercontent.com"))
          reads.push(request.url());
      });
      await page.route(
        "https://raw.githubusercontent.com/**",
        async (route) => {
          const url = route.request().url();
          let data: unknown;
          if (url.endsWith("/main/data/latest.json")) data = pointer;
          else if (url === indexUrl) data = index;
          else if (url.includes("/overview.json")) {
            const version = url.match(/\/rocm\/([^/]+)\//)![1];
            const entry = overview(version);
            data = {
              ...entry,
              performance: { ...entry.performance, measurement_count: 1 },
            };
          } else if (url.includes("/history/"))
            data = historyFixture(url.match(/\/rocm\/([^/]+)\//)![1]);
          else if (url.endsWith("/performance.json")) {
            const version = url.match(/\/rocm\/([^/]+)\//)![1];
            data = measurements(version);
          } else return route.fulfill({ status: 404, body: "{}" });
          return route.fulfill({ json: data });
        },
      );
      await page.goto("./?version=10.1&view=performance&platform=linux");
      await page
        .getByRole("combobox", { name: "Model", exact: true })
        .selectOption("Fixture model");
      await expect(
        page.getByRole("button", { name: /^Measurement details for Fixture model/ }),
      ).toBeVisible();
      await expect(page.getByText("Measurements are from benchmarked llama.cpp builds. Benchmarks may trail releases.")).toBeVisible();
      await expect(page.getByRole("region", { name: "Model performance", exact: true }).getByText("Last run: 2026-10-29 12:00:00 UTC.")).toBeVisible();
      await page.getByRole("button", { name: "Sort by Decode TPS", exact: true }).click();
      await expect(page).toHaveURL(/sort=decode/);
      await expect(page.locator('th[aria-sort="descending"]')).toContainText("TPS");
      const pointerReads = reads.filter((url) =>
        url.endsWith("/main/data/latest.json"),
      ).length;
      await expect(page.getByRole("group", { name: "Compare ROCm version" })).toHaveCount(0);
      expect(
        reads.filter((url) => url.endsWith("/main/data/latest.json")),
      ).toHaveLength(pointerReads);
      const shared = page.url();
      await page.reload();
      await expect(
        page.getByRole("button", { name: /^Measurement details for Fixture model/ }),
      ).toBeVisible();
      await expect(page).toHaveURL(shared);

    },
  );
}

test("anchors package performance popups and keeps model names readable", async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-11-02T15:00:00Z"));
  const original = historyFixture();
  const history = {
    ...original,
    builds: original.builds.map((build, index) => ({
      ...build, tag: index < 2 ? "b100" : build.tag,
      run_id: index < 2 ? "123" : undefined,
    })),
  };
  const data = measurements("10.1");
  const model = "NVIDIA-Nemotron-3.5-Lightning-30B-A3B-GGUF";
  const measured = {
      ...data.measurements[0], model, channel: "stable",
      engine_repository: "lemonade-sdk/llama.cpp",
      fork_id: "llamacpp-rocm-stable",
      package_url: "https://github.com/lemonade-sdk/llama.cpp/releases/download/b100/llama-b100-bin-ubuntu-rocm-10.1-x64.tar.gz",
      metrics: { ttft_ms_mean: 10000, tps_mean: 12, vram_peak_gb: 16 },
      qualification_build_id: "linux-build",
      run_id: "12345",
      run_url: "https://github.com/lemonade-sdk/lemonade/actions/runs/12345",
  };
  const performance = {
    ...data,
    measurements: [
      measured,
      { ...measured, scenario: "context-4k", context_size: 4096 },
      { ...measured, package_os: "windows", qualification_build_id: "history-1",
        package_url: "https://github.com/lemonade-sdk/llama.cpp/releases/download/b100/llama-b100-bin-win-rocm-10.1-x64.zip",
        run_id: "12346", run_url: "https://github.com/lemonade-sdk/lemonade/actions/runs/12346",
        metrics: { ttft_ms_mean: 8000, tps_mean: 10, vram_peak_gb: 16 } },
      { ...measured, measured_at: "2026-10-28T12:00:00Z", run_id: "12344",
        run_url: "https://github.com/lemonade-sdk/lemonade/actions/runs/12344",
        metrics: { ttft_ms_mean: 20000, tps_mean: 5, vram_peak_gb: 16 } },
      { ...measured, model: "A small model", metrics: { ttft_ms_mean: 2000, tps_mean: 100, vram_peak_gb: 1 } },
      { ...measured, model: "Z missing metrics", metrics: {} },
    ],
  };
  await page.route("https://raw.githubusercontent.com/**", async (route) => {
    const url = route.request().url();
    if (url.endsWith("/main/data/latest.json")) return route.fulfill({ json: pointer });
    if (url === indexUrl) return route.fulfill({ json: index });
    if (url.endsWith("/rocm/10.1/overview.json")) return route.fulfill({ json: overview() });
    if (url.endsWith("/rocm/10.1/history/2026-10.json")) return route.fulfill({ json: history });
    if (url.endsWith("/rocm/10.1/performance.json")) return route.fulfill({ json: performance });
    return route.fulfill({ status: 404, body: "{}" });
  });
  await page.goto("./?version=10.1&view=engine&platform=all");
  const platforms = page.getByRole("group", { name: "Platforms", exact: true });
  await expect(platforms.locator("img")).toHaveCount(2);
  const windows = platforms.getByRole("button", { name: "Windows", exact: true });
  const selectedBackground = await windows.evaluate((element) => getComputedStyle(element).backgroundColor);
  const selectedText = await windows.evaluate((element) => getComputedStyle(element).color);
  await windows.hover();
  expect(await windows.evaluate((element) => getComputedStyle(element).backgroundColor)).not.toBe(selectedBackground);
  expect(await windows.evaluate((element) => getComputedStyle(element).color)).toBe(selectedText);
  await expect(windows).toHaveAttribute("aria-pressed", "true");
  const trigger = page.getByRole("button", { name: "Run details for b100", exact: true });
  await trigger.focus();
  const popup = page.getByRole("dialog");
  await expect(popup).toBeVisible();
  await expect(popup.locator(".tooltip-arrow")).toBeVisible();
  await expect(popup.getByRole("heading", { name: "Windows", exact: true })).toBeVisible();
  await expect(popup.getByRole("heading", { name: "Linux", exact: true })).toBeVisible();
  await expect(popup.locator(".performance-preview")).toHaveCount(0);
  await popup.getByRole("button", { name: "Close popup" }).click();
  const performanceTrigger = page.getByRole("button", { name: "Performance data for b100", exact: true });
  await performanceTrigger.focus();
  await expect(popup).toBeVisible();
  await expect(popup.getByText("Lower is better", { exact: true })).toBeVisible();
  await expect(popup.getByText("Higher is better", { exact: true })).toBeVisible();
  const ttft = popup.getByRole("group", { name: model + " · TTFT", exact: true });
  await expect(ttft.getByRole("link")).toHaveCount(2);
  await popup.getByRole("button", { name: "Windows", exact: true }).click();
  await expect(ttft.getByRole("link")).toHaveCount(1);
  await expect(ttft.getByRole("link")).toContainText("10 s");
  await popup.getByRole("button", { name: "Windows", exact: true }).click();
  await expect(ttft.getByRole("link")).toHaveCount(2);
  await popup.getByRole("button", { name: "Windows", exact: true }).click();
  await expect(popup.getByText("VRAM", { exact: true })).toHaveCount(0);
  const name = popup.getByRole("link", { name: model, exact: true });
  await name.scrollIntoViewIfNeeded();
  const box = await popup.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  await page.keyboard.press("Escape");
  await expect(popup).toHaveCount(0);
  await expect(performanceTrigger).toBeFocused();
  await performanceTrigger.click();
  await expect(popup).toBeVisible();
  await popup.getByRole("button", { name: "Close popup" }).click();
  await expect(popup).toHaveCount(0);
  await performanceTrigger.click();
  await popup.getByRole("button", { name: "Windows", exact: true }).click();
  await popup.getByRole("link", { name: model, exact: true }).click();
  await expect(page.getByRole("link", { name: "Performance", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(page.locator(".performance-measurement-row")).toHaveCount(2);
  await expect(page.getByRole("button", { name: "Clear Build: b100", exact: true })).toBeVisible();
  await page.getByRole("button", { name: /^Measurement details for NVIDIA/ }).first().click();
  await expect(page.getByRole("dialog")).toHaveAttribute("data-placement", /^(right|left)-/);
  await expect(page.getByRole("link", { name: "12345 ↗", exact: true })).toHaveAttribute("href",
    "https://github.com/lemonade-sdk/lemonade/actions/runs/12345");
  await expect(page.locator(".performance-measurement-row").first()).toContainText("10");
  await page.reload();
  await expect(page.locator(".performance-measurement-row")).toHaveCount(2);
  await expect(page.getByRole("group", { name: "Workload", exact: true }).getByRole("button", { name: "4K", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Reset filters" }).click();
  await expect(page).not.toHaveURL(/build=|model=|observation=/);
  await page.getByRole("searchbox", { name: "Find build" }).fill("missing-build");
  await expect(page.locator(".performance-measurement-row")).toHaveCount(0);
  await page.getByRole("button", { name: "Reset filters" }).click();
  await expect(page.locator(".performance-measurement-row").first()).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "Show history" })).toHaveCount(0);
});
