import { expect, test } from "@playwright/test";
import { fixtureFetch, historyFixture, indexUrl } from "../src/fixtures";

for (const theme of ["light", "dark"] as const) {
  for (const width of [390, 768, 1440]) {
    test(`GPU family performance stays beside its label at ${width}px in ${theme}`, async ({ page }, testInfo) => {
      await page.clock.setFixedTime(new Date("2026-11-02T15:00:00Z"));
      await page.setViewportSize({ width, height: 1000 });
      await page.emulateMedia({ colorScheme: theme });
      const original = historyFixture();
      const build = { ...original.builds[0], gfx_family: "gfx1151", artifact: `llama-${original.builds[0].tag}-bin-ubuntu-rocm-10.1-x64.tar.gz` };
      const fetcher = fixtureFetch({
        [new URL("rocm/10.1/history/2026-10.json", indexUrl).href]: { ...original, builds: original.builds.map((row, index) => index === 0 ? build : row) },
        [new URL("rocm/10.1/performance.json", indexUrl).href]: {
          schema_version: 2, systems: [], measurements: [{
            source_id: "bench", engine: "llamacpp", channel: "stable", backend: "rocm",
            engine_repository: "lemonade-sdk/llama.cpp", fork_id: "llamacpp-rocm-stable",
            engine_version: build.tag, qualification_build_id: build.build_id,
            package_os: build.os, rocm_version: "10.1", model: "Fixture model", quant: "Q4_K_M",
            scenario: "short", context_size: 4096, input_tokens: 128,
            package_url: `https://github.com/lemonade-sdk/llama.cpp/releases/download/${build.tag}/${build.artifact}`,
            measured_at: "2026-10-29T12:00:00Z", metrics: { pp_tps: 100, tg_tps: 20, tps_mean: 20 },
          }],
        },
      });
      await page.route("https://raw.githubusercontent.com/**", async (route) => {
        const response = await fetcher(route.request().url());
        await route.fulfill({ status: response.status, body: await response.text(), contentType: "application/json" });
      });
      await page.goto("./?view=engine&version=10.1&through=2026-09-01");
      await expect(page.getByRole("navigation", { name: "Browse qualification dates" })).toHaveCount(0);
      const icon = page.getByRole("button", { name: `Performance data for ${width <= 640 ? build.tag : "gfx1151"}`, exact: true });
      await expect(icon).toBeVisible();
      if (width > 640) {
        const label = page.getByRole("button", { name: "Package details for gfx1151", exact: true });
        const a = (await label.boundingBox())!;
        const b = (await icon.boundingBox())!;
        expect(b.x).toBeGreaterThanOrEqual(a.x + a.width);
        expect(Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)).toBeGreaterThan(0);
        expect(b.x + b.width).toBeLessThanOrEqual((await label.locator("xpath=ancestor::th").boundingBox())!.x + (await label.locator("xpath=ancestor::th").boundingBox())!.width);
        await label.locator("xpath=ancestor::table").screenshot({ path: testInfo.outputPath(`family-row-${theme}-${width}.png`) });
        await icon.focus();
        await expect(icon).toBeFocused();
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`family-${theme}-${width}.png`) });
    });
  }
}
