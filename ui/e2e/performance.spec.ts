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
        channel: "stable",
        backend: "rocm",
        fork_id: "llamacpp-rocm-stable",
        engine_repository: "lemonade-sdk/llama.cpp",
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
        package_url: `https://github.com/lemonade-sdk/llama.cpp/releases/download/b100/llama-b100-bin-ubuntu-rocm-${version}-x64.tar.gz`,
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
              !compatible && version === "10.0" ? "Q8_0" : "Q4_K_M",
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
        .selectOption("10.0");
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
      ).toHaveValue("10.0");
    },
  );
}
