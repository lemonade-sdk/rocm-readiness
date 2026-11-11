import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BuildBrowser, qualificationCheckHref } from "./BuildBrowser";
import {
  buildFixture,
  producerReport,
  reportUrl,
  session,
  sourceUrl,
} from "./fixtures";

const fetchMock = vi.fn();

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function mount(overrides: Partial<ComponentProps<typeof BuildBrowser>> = {}) {
  const onPlatformChange = vi.fn();
  const props: ComponentProps<typeof BuildBrowser> = {
    session,
    history: [
      buildFixture({ build_id: "old-linux", tag: "b10000" }),
      buildFixture({
        build_id: "new-windows",
        os: "windows",
        tag: "b10001",
        artifact: "llama-b10001-bin-win-rocm-10.1-x64.zip",
        report_url: reportUrl("new-windows"),
      }),
      buildFixture({
        build_id: "new-linux",
        tag: "b10002",
        qualified: false,
        hardware_validated: false,
        report_url: reportUrl("new-linux"),
      }),
    ],
    platform: "all",
    selectedBuildId: null,
    buildHref: (build) =>
      `?build=${encodeURIComponent(build.build_id)}&platform=${encodeURIComponent(build.os)}`,
    onPlatformChange,
    ...overrides,
  };
  return { ...render(<BuildBrowser {...props} />), onPlatformChange };
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("BuildBrowser", () => {
  it("filters retained builds by package or build identity", () => {
    mount({ query: "b10001" });
    expect(screen.getAllByText("b10001").length).toBeGreaterThan(0);
    expect(screen.queryAllByText("b10000")).toHaveLength(0);
    expect(screen.queryAllByText("b10002")).toHaveLength(0);
  });
  it("lists every retained row and waits to request reports until a build is selected", () => {
    const { onPlatformChange } = mount();

    expect(
      screen.getByRole("heading", { name: "Build details" }),
    ).toBeInTheDocument();
    expect(screen.getAllByText("b10000").length).toBeGreaterThan(0);
    expect(screen.getAllByText("b10001").length).toBeGreaterThan(0);
    expect(screen.getAllByText("b10002").length).toBeGreaterThan(0);
    expect(screen.getByText("Producer did not qualify")).toBeInTheDocument();
    expect(screen.getByLabelText("Platform")).toHaveValue("all");
    expect(
      screen.getAllByRole("link", {
        name: "Open build old-linux from stable-qualification on Linux",
      }).length,
    ).toBeGreaterThan(0);
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("Platform"), {
      target: { value: "windows" },
    });
    expect(onPlatformChange).toHaveBeenCalledWith("windows");
  });

  it("uses build, platform, and source together rather than picking the first duplicate ID", async () => {
    const first = buildFixture({
      build_id: "same-build",
      source_id: "source-a",
      tag: "b-source-a",
      report_url: reportUrl("same-build"),
      source_url: sourceUrl,
    });
    const second = buildFixture({
      build_id: "same-build",
      source_id: "source-b",
      tag: "b-source-b",
      report_url: reportUrl("same-build", "d".repeat(40)),
      source_url: `https://raw.githubusercontent.com/lemonade-sdk/llama.cpp/${"d".repeat(40)}/qualification/index.json`,
    });
    fetchMock.mockResolvedValue(response(producerReport(second)));

    mount({
      history: [first, second],
      platform: "linux",
      selectedBuildId: "same-build",
      selectedSourceId: "source-b",
    });

    expect(
      await screen.findByRole("heading", { name: "b-source-b" }),
    ).toBeInTheDocument();
    expect(screen.getByText("source-b")).toBeInTheDocument();
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        second.report_url,
        expect.objectContaining({ cache: "no-store" }),
      ),
    );
  });

  it("refuses an ambiguous build selection instead of opening an arbitrary duplicate", () => {
    const first = buildFixture({
      build_id: "same-build",
      source_id: "source-a",
    });
    const second = buildFixture({
      build_id: "same-build",
      source_id: "source-b",
    });

    mount({
      history: [first, second],
      platform: "linux",
      selectedBuildId: "same-build",
    });

    expect(screen.getByRole("alert")).toHaveTextContent("ambiguous");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("renders producer tiers and warn, fail, skip, and missing test evidence", async () => {
    const build = buildFixture({ build_id: "detailed-build" });
    fetchMock.mockResolvedValue(response(producerReport(build)));

    mount({
      history: [build],
      platform: "linux",
      selectedBuildId: "detailed-build",
      selectedSourceId: "stable-qualification",
    });

    expect(
      await screen.findByRole("heading", {
        name: "Static artifact verification",
      }),
    ).toBeInTheDocument();
    expect(screen.getByText("archive contents")).toBeInTheDocument();
    expect(screen.getAllByText("warn").length).toBeGreaterThan(0);
    expect(screen.getAllByText("fail").length).toBeGreaterThan(0);
    expect(screen.getAllByText("skip").length).toBeGreaterThan(0);
    expect(screen.getAllByText("missing").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Gating").length).toBeGreaterThan(0);
    expect(screen.getByText("12 ms")).toBeInTheDocument();
    expect(screen.getByText("ROCm 10.1")).toBeInTheDocument();
    expect(screen.getByText("hipblas.dll missing")).toBeInTheDocument();
    expect(screen.getByText("not exercised")).toBeInTheDocument();
  });

  it("keeps the selected build header and retries after a report is unavailable", async () => {
    const build = buildFixture({ build_id: "retry-build" });
    fetchMock
      .mockResolvedValueOnce(response({ error: "unavailable" }, 503))
      .mockResolvedValueOnce(response(producerReport(build)));

    mount({
      history: [build],
      platform: "linux",
      selectedBuildId: "retry-build",
      selectedSourceId: "stable-qualification",
    });

    expect(await screen.findByRole("alert")).toHaveTextContent("HTTP 503");
    expect(screen.getByRole("heading", { name: "b12345" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry report" }));
    expect(
      await screen.findByRole("heading", {
        name: "Static artifact verification",
      }),
    ).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("opens a real nightly report using release_tag and its exact SDK", async () => {
    const build = buildFixture({ channel: "nightly", rocm_version: "10.3",
      producer_rocm_version: "10.3.0a20261104", run_attempt: 1 });
    fetchMock.mockResolvedValue(response(producerReport(build, { build: {
      llamacpp_tag: undefined, release_tag: build.tag,
      rocm_version: "10.3.0a20261104",
    } })));
    mount({ history: [build], selectedBuildId: build.build_id });
    expect(await screen.findByText("T0.1")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("opens the exact check in a future producer tier even when check IDs repeat", async () => {
    const repository = "https://raw.githubusercontent.com/example/vllm-rocm/" + "d".repeat(40);
    const build = buildFixture({
      build_id: "future-package",
      engine: "vllm",
      source_url: `${repository}/qualification/index.json`,
      report_url: `${repository}/qualification/reports/future-package.json`,
    });
    fetchMock.mockResolvedValue(response(producerReport(build, { tiers: {
      tier3: {
        tier_name: "Extended compatibility",
        status: "warn",
        counts: { warn: 1, not_applicable: 1 },
        tests: [
          { id: "T3.1", name: "First host", status: "warn" },
          null,
          { id: "T3.1", name: "Second host", status: "not_applicable" },
        ],
      },
    } })));
    const params = new URLSearchParams(qualificationCheckHref(build, "tier3", 2));
    expect(params.get("source")).toBe(build.source_id);
    expect(params.get("build")).toBe(build.build_id);
    expect(params.get("report_commit")).toBe("d".repeat(40));
    mount({
      history: [build],
      selectedBuildId: build.build_id,
      selectedTierId: params.get("tier"),
      selectedCheckIndex: params.get("check"),
      selectedReportCommit: params.get("report_commit"),
    });

    const selected = await screen.findByRole("row", { name: /Second host/ });
    expect(selected).toHaveFocus();
    expect(selected).toHaveAttribute("aria-current", "true");
    expect(screen.getByRole("row", { name: /First host/ })).not.toHaveAttribute("aria-current");
    expect(screen.getByText("not_applicable")).toBeInTheDocument();
  });

  it("lists checks in test-id order while check links keep the report position", async () => {
    const build = buildFixture();
    fetchMock.mockResolvedValue(response(producerReport(build, { tiers: {
      tier0: {
        tier_name: "Static artifact verification",
        status: "pass",
        tests: ["T0.10", "T0.11", "T0.1", "T0.2", "T0.12"].map((id) =>
          ({ id, name: `check ${id}`, status: "pass" })),
      },
      tier1: {
        tier_name: "Runtime",
        status: "pass",
        tests: [
          { name: "unnumbered probe", status: "pass" },
          { id: "T1.2", name: "check T1.2", status: "pass" },
          { id: "T1.1", name: "check T1.1", status: "pass" },
        ],
      },
    } })));
    const params = new URLSearchParams(qualificationCheckHref(build, "tier0", 2));
    mount({
      history: [build],
      selectedBuildId: build.build_id,
      selectedTierId: params.get("tier"),
      selectedCheckIndex: params.get("check"),
      selectedReportCommit: params.get("report_commit"),
    });

    const selected = await screen.findByRole("row", { name: /check T0\.1 pass/ });
    expect(screen.getAllByRole("rowheader").map((header) => header.querySelector("strong")?.textContent))
      .toEqual(["T0.1", "T0.2", "T0.10", "T0.11", "T0.12", "T1.1", "T1.2", "tier1.1"]);
    expect(selected).toHaveAttribute("aria-current", "true");
    expect(screen.getByRole("row", { name: /check T0\.10 pass/ })).not.toHaveAttribute("aria-current");
  });

  it("prefers recorded GPU evidence over the requested offload line", async () => {
    const build = buildFixture();
    const requested_offload_line = "offloaded 29/29 layers to GPU";
    fetchMock.mockResolvedValue(response(producerReport(build, { tiers: {
      tier1: {
        tier_name: "Runtime",
        status: "pass",
        tests: [
          { id: "T1.1", name: "llama.cpp proof", status: "pass", details: {
            gpu_proof: ["using device ROCm0 (AMD Radeon 8060S Graphics)", "ROCm0 model buffer size = 358.78 MiB"],
            devices_selected: [{ device: "ROCm0", name: "AMD Radeon 8060S Graphics" }],
            model_buffers_mib: [["ROCm0", 358.78]],
            requested_offload_line,
          } },
          { id: "T1.2", name: "llamacpp-rocm buffers", status: "pass", details: {
            devices_selected: [{ device: "ROCm0", name: "AMD Radeon 8060S Graphics" }],
            model_buffers_mib: [["ROCm0", 358.78]],
            requested_offload_line,
          } },
          { id: "T1.3", name: "llama.cpp no proof", status: "fail", details: {
            gpu_proof: [],
            devices_selected: [{ device: "ROCm0", name: "AMD Radeon 8060S Graphics" }],
            model_buffers_mib: [],
            requested_offload_line,
          } },
          { id: "T1.4", name: "older llama.cpp proof", status: "pass", details: {
            gpu_proof: ["using device ROCm0", "ROCm0 model buffer size"],
            devices_reported: [],
            requested_offload_line,
          } },
          { id: "T1.5", name: "older llama.cpp no proof", status: "fail", details: {
            gpu_proof: [],
            devices_reported: [],
            requested_offload_line,
          } },
          { id: "T1.6", name: "requested only", status: "pass", details: { requested_offload_line } },
        ],
      },
    } })));
    mount({ history: [build], selectedBuildId: build.build_id });

    const offload = async (name: string) =>
      (await screen.findByRole("row", { name: new RegExp(name) })).querySelector(".build-browser-evidence")?.textContent;
    expect(await offload("^T1.1 llama.cpp proof")).toBe(
      "GPU offload: using device ROCm0 (AMD Radeon 8060S Graphics), ROCm0 model buffer size = 358.78 MiB");
    expect(await offload("llamacpp-rocm buffers")).toBe("GPU offload: ROCm0 (AMD Radeon 8060S Graphics): 358.78 MiB model buffer");
    // A record with its own GPU evidence fields never falls back to the requested-offload line.
    expect(await offload("^T1.3 llama.cpp no proof")).toBeUndefined();
    expect(await offload("older llama.cpp proof")).toBe("GPU offload: using device ROCm0, ROCm0 model buffer size");
    expect(await offload("older llama.cpp no proof")).toBeUndefined();
    expect(await offload("requested only")).toBe(`GPU offload: ${requested_offload_line}`);
    expect(screen.getAllByText(/"requested_offload_line": "offloaded 29\/29 layers to GPU"/)).toHaveLength(6);
  });

  it("does not select a test ordinal in a different report revision", async () => {
    const build = buildFixture();
    fetchMock.mockResolvedValue(response(producerReport(build)));

    mount({
      history: [build],
      selectedBuildId: build.build_id,
      selectedTierId: "tier0",
      selectedCheckIndex: "0",
      selectedReportCommit: "d".repeat(40),
    });

    expect(await screen.findByText("This check link points to a different producer report revision.")).toHaveAttribute("role", "status");
    expect(screen.getByRole("row", { name: /archive contents/ })).not.toHaveAttribute("aria-current");
  });

  it("rejects a report whose metadata does not match the selected feed row", async () => {
    const build = buildFixture({ build_id: "mismatch-build" });
    fetchMock.mockResolvedValue(
      response(producerReport(build, { build: { rocm_version: "10.2" } })),
    );

    mount({
      history: [build],
      platform: "linux",
      selectedBuildId: "mismatch-build",
      selectedSourceId: "stable-qualification",
    });

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "ROCm version does not match",
    );
    expect(
      screen.queryByRole("heading", { name: "Static artifact verification" }),
    ).not.toBeInTheDocument();
  });
});
