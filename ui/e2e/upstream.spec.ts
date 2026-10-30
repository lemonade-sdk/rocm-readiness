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
  await expect(page.getByText("not upstreamed")).toBeVisible();
  await page.getByRole("heading", { name: "llama.cpp" }).click();
  await expect(page).toHaveURL(/project=llamacpp/);
  await expect(page.getByText("of 12 results on main passed")).toBeVisible();
  await page.getByRole("button", { name: "vulkan" }).click();
  await expect(page).toHaveURL(/lens=vulkan/);
  await expect(page.getByText("of 8 results on main passed")).toBeVisible();
  await page.getByRole("button", { name: "Everything AMD" }).click();
  await page
    .getByRole("region", { name: "Per day" })
    .getByRole("button", { name: "2026-10-27: 3 passed, 1 failed of 4 runs" })
    .click();
  const panel = page.getByRole("region", { name: "Runs on 2026-10-27" });
  await expect(panel.getByRole("link", { name: "#501 red" })).toHaveAttribute(
    "href",
    "https://github.com/ggml-org/llama.cpp/pull/501",
  );
  await page.goBack();
  await page.goBack();
  await expect(page).not.toHaveURL(/lens=/);
});
