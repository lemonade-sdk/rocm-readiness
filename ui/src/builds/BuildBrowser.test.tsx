import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BuildBrowser } from "./BuildBrowser";
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
      screen.getByRole("heading", { name: "Retained builds" }),
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

  it("rejects a report whose metadata does not match the selected feed row", async () => {
    const build = buildFixture({ build_id: "mismatch-build" });
    fetchMock.mockResolvedValue(
      response(producerReport(build, { build: { rocm_version: "10.0" } })),
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
