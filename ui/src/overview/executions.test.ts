import { expect, it, vi } from "vitest";
import { loadSession } from "../data";
import {
  fixtureFetch,
  overview,
  indexUrl,
  executionAttempt,
} from "../fixtures";
import { loadExecutions } from "./executions";

it("loads pinned attempts including metricless failures, partial and incomplete evidence", async () => {
  const fetcher = vi.fn(
    fixtureFetch({
      [new URL("rocm/10.1/overview.json", indexUrl).href]: {
        ...overview(),
        execution: {
          path: "rocm/10.1/executions.json",
          attempt_count: 4,
          summaries: [],
        },
      },
      [new URL("rocm/10.1/executions.json", indexUrl).href]: {
        schema_version: 1,
        rocm_version: "10.1",
        attempts: ["passed", "failed", "partial", "unknown"].map((s) =>
          executionAttempt("10.1", s as "passed"),
        ),
        summaries: [],
      },
    }),
  );
  const session = await loadSession(undefined, fetcher);
  expect(
    (await loadExecutions(session, fetcher)).map((r) => r.execution_status),
  ).toEqual(["passed", "failed", "partial", "unknown"]);
  expect(fetcher.mock.calls.at(-1)?.[0]).toBe(
    new URL("rocm/10.1/executions.json", indexUrl).href,
  );
});

it("rejects execution files with wrong version identity instead of showing healthy counts", async () => {
  const fetcher = fixtureFetch({
    [new URL("rocm/10.1/overview.json", indexUrl).href]: {
      ...overview(),
      execution: {
        path: "rocm/10.1/executions.json",
        attempt_count: 1,
        summaries: [],
      },
    },
    [new URL("rocm/10.1/executions.json", indexUrl).href]: {
      schema_version: 1,
      rocm_version: "10.0",
      attempts: [executionAttempt()],
      summaries: [],
    },
  });
  const session = await loadSession(undefined, fetcher);
  await expect(loadExecutions(session, fetcher)).rejects.toThrow(
    "does not match its overview",
  );
});
