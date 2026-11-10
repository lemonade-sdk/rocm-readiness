import { expect, test } from "@playwright/test";
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
        metrics: { tg_tps: version === "10.1" ? 12 : 10, ttft_ms_mean: 250 },
      },
    ],
  };
}

for (const compatible of [true, false]) {
  test(
    compatible
      ? "shares model details and compares compatible measurements without refreshing the pointer"
      : "refuses incompatible quantizations",
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
            data = measurements(
              version,
              !compatible && version === "10.2" ? "Q8_0" : "Q4_K_M",
            );
          } else return route.fulfill({ status: 404, body: "{}" });
          return route.fulfill({ json: data });
        },
      );
      await page.goto("./?version=10.1&view=performance&platform=linux");
      await page
        .getByRole("link", { name: "Fixture model", exact: true })
        .click();
      await expect(
        page.getByRole("heading", { name: "Fixture model", level: 2 }),
      ).toBeVisible();
      const pointerReads = reads.filter((url) =>
        url.endsWith("/main/data/latest.json"),
      ).length;
      await page
        .getByRole("combobox", { name: "Compare ROCm version", exact: true })
        .selectOption("10.2");
      if (compatible)
        await expect(page.getByText(/Δ \+2 tok\/s/)).toBeVisible();
      else {
        await expect(
          page.getByText("No compatible comparison", { exact: true }),
        ).toBeVisible();
        await expect(page.getByText(/Δ /)).toHaveCount(0);
      }
      expect(
        reads.filter((url) => url.endsWith("/main/data/latest.json")),
      ).toHaveLength(pointerReads);
      const shared = page.url();
      await page.reload();
      await expect(
        page.getByRole("heading", { name: "Fixture model", level: 2 }),
      ).toBeVisible();
      await expect(page).toHaveURL(shared);
      await expect(
        page.getByRole("combobox", {
          name: "Compare ROCm version",
          exact: true,
        }),
      ).toHaveValue("10.2");
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
  const performance = {
    ...data,
    measurements: [{
      ...data.measurements[0], model, channel: "stable",
      engine_repository: "lemonade-sdk/llama.cpp",
      fork_id: "llamacpp-rocm-stable",
      package_url: "https://github.com/lemonade-sdk/llama.cpp/releases/download/b100/llama-b100-bin-ubuntu-rocm-10.1-x64.tar.gz",
      metrics: { ...data.measurements[0].metrics, tps_mean: 12 },
      qualification_build_id: "linux-build",
    }],
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
  const trigger = page.getByRole("button", { name: "Run details for b100 · Performance data available", exact: true });
  await trigger.focus();
  const popup = page.getByRole("dialog");
  await expect(popup).toBeVisible();
  await expect(popup.locator(".tooltip-arrow")).toBeVisible();
  await expect(popup.getByRole("heading", { name: /^Windows / })).toBeVisible();
  await expect(popup.getByRole("heading", { name: /^Linux / })).toBeVisible();
  const name = popup.getByRole("rowheader", { name: model, exact: true });
  await name.scrollIntoViewIfNeeded();
  expect(await name.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  const box = await popup.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  await page.keyboard.press("Escape");
  await expect(popup).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await trigger.click();
  await expect(popup).toBeVisible();
  await popup.getByRole("button", { name: "Close popup" }).click();
  await expect(popup).toHaveCount(0);
});
