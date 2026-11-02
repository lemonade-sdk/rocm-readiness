import { render, screen, fireEvent } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { loadSession } from "../data";
import {
  executionAttempt,
  fixtureFetch,
  indexUrl,
  overview,
} from "../fixtures";
import { ExecutionEvidence } from "./ExecutionEvidence";

it("shows metricless failures as attempts, separate from unique models and speed", async () => {
  const attempt = executionAttempt();
  const fetcher = fixtureFetch({
    [new URL("rocm/10.1/overview.json", indexUrl).href]: {
      ...overview(),
      execution: {
        path: "rocm/10.1/executions.json",
        attempt_count: 2,
        summaries: [],
      },
    },
    [new URL("rocm/10.1/executions.json", indexUrl).href]: {
      schema_version: 1,
      rocm_version: "10.1",
      attempts: [attempt, { ...attempt, execution_status: "partial" }],
      summaries: [],
    },
  });
  const session = await loadSession(undefined, fetcher);
  render(
    <ExecutionEvidence
      session={session}
      fetcher={fetcher}
      params={new URLSearchParams()}
      builds={[]}
    />,
  );
  expect(
    await screen.findByText(
      "2 recorded attempts in this scope · 1 unique model",
    ),
  ).toBeInTheDocument();
  fireEvent.click(screen.getByText("Inspect execution attempts"));
  expect(screen.getByText("failed")).toBeInTheDocument();
  expect(screen.getByText("partial")).toBeInTheDocument();
  expect(screen.getAllByText("Cause: not inferred")).toHaveLength(2);
});
it("keeps fetch errors recoverable instead of turning them into zero attempts", async () => {
  const session = await loadSession(
    undefined,
    fixtureFetch({
      [new URL("rocm/10.1/overview.json", indexUrl).href]: {
        ...overview(),
        execution: {
          path: "rocm/10.1/executions.json",
          attempt_count: 1,
          summaries: [],
        },
      },
    }),
  );
  const fetcher = vi.fn().mockRejectedValue(new Error("offline"));
  render(
    <ExecutionEvidence
      session={session}
      fetcher={fetcher}
      params={new URLSearchParams()}
      builds={[]}
    />,
  );
  expect(await screen.findByRole("alert")).toHaveTextContent("offline");
  fireEvent.click(
    screen.getByRole("button", { name: "Retry execution evidence" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent("offline");
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(screen.queryByText(/0 recorded attempts/)).not.toBeInTheDocument();
});
