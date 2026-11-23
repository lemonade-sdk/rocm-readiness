import { render, screen, within } from "@testing-library/react";
import { expect, it } from "vitest";
import type { Sync } from "./data";
import { SyncFailure } from "./SyncFailure";

const failure: Sync = {
  status: "failed", attempted_at: "2026-11-23T11:04:45.069582+00:00",
  last_successful_at: "2026-11-20T11:04:54.663841+00:00",
  errors: [{ source_id: "lemonade-performance", record: "/by_model_scenario/K2-Horizon-0.9B-GGUF|context-4k/3",
    field: "package_evidence", reason: "run=44854194006 engine=b12576: benchmark job evidence access failed (exit 1, HTTP 404); authenticated GitHub log access may be required" }],
};

it("explains the published benchmark access failure and links its known source and run", () => {
  render(<SyncFailure sync={failure} />);
  const banner = screen.getByRole("region", { name: "Dashboard data couldn’t be updated" });
  expect(within(banner).getByText("Benchmark measurements could not be refreshed.")).toBeVisible();
  expect(within(banner).getByText(/which software build was tested \(HTTP 404\)/)).toBeVisible();
  expect(within(banner).getByText("Reported software build: b12576")).toBeVisible();
  expect(within(banner).getByText(/Showing the last successful dataset/)).toBeVisible();
  expect(within(banner).getByRole("link", { name: "Benchmark run" })).toHaveAttribute("href", "https://github.com/lemonade-sdk/lemonade/actions/runs/44854194006");
  expect(within(banner).getByRole("link", { name: "Lemonade benchmark leaderboard" })).toHaveAttribute("href", "https://github.com/lemonade-sdk/lemonade/blob/benchmark-data/leaderboard.json");
  const details = within(banner).getByText("Technical details").closest("details")!;
  expect(details).not.toHaveAttribute("open");
  expect(details).toHaveTextContent(failure.errors[0].reason);
  expect(details).toHaveTextContent(failure.errors[0].record);
  expect(within(banner).getAllByRole("time").map(time => time.getAttribute("datetime"))).toEqual([failure.attempted_at, failure.last_successful_at]);
});

it("keeps unknown failures honest and does not turn error text into links", () => {
  const reason = "run=123 https://malicious.invalid/ — unexpected source response";
  render(<SyncFailure sync={{ ...failure, errors: [{ source_id: "unrecognized", field: "feed", record: "/item", reason }] }} />);
  expect(screen.getByText("A data source could not be refreshed.")).toBeVisible();
  expect(screen.getByText(reason)).toBeInTheDocument();
  expect(screen.queryByRole("link")).not.toBeInTheDocument();
});

it("does not fabricate a run link for a malformed run identifier", () => {
  render(<SyncFailure sync={{ ...failure, errors: [{ ...failure.errors[0], reason: failure.errors[0].reason.replace("44854194006", "44854194006evil") }] }} />);
  expect(screen.queryByRole("link", { name: "Benchmark run" })).not.toBeInTheDocument();
});

it("does not claim a last usable dataset when no ingestion has succeeded", () => {
  render(<SyncFailure sync={{ ...failure, last_successful_at: null, errors: [] }} />);
  expect(screen.getByText("No successful dataset has been published yet.")).toBeVisible();
  expect(screen.queryByText(/Showing the last successful dataset/)).not.toBeInTheDocument();
  expect(screen.getAllByRole("time")).toHaveLength(1);
});
