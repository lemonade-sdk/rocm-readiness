import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { expect, it } from "vitest";
import { EngineOverview } from "./EngineOverview";
import { overview } from "./fixtures";

it("omits unsupported evidence without inventing a passing count or qualification", () => {
  const engines = overview().engines;
  const build = engines[0].latest_builds[0];
  render(
    <MemoryRouter>
      <EngineOverview
        version="10.1"
        engines={[
          {
            ...engines[0],
            latest_builds: [
              {
                ...build,
                qualified: null,
                overall: null,
                hardware_validated: null,
                report_url: null,
              },
            ],
          },
        ]}
      />
    </MemoryRouter>,
  );
  expect(screen.getByRole("link", { name: /b11972/ })).toBeInTheDocument();
  for (const label of [
    "Qualified",
    "Test outcome",
    "GPU hardware verification",
    "Models passing",
    "Unavailable",
    "Check breakdown unavailable",
  ])
    expect(screen.queryByText(label, { exact: true })).not.toBeInTheDocument();
});

it("does not create engine placeholders from absent build evidence", () => {
  const engine = overview().engines[0];
  render(
    <MemoryRouter>
      <EngineOverview
        version="10.1"
        engines={[{ ...engine, latest_builds: [] }]}
      />
    </MemoryRouter>,
  );
  expect(screen.queryByRole("article")).not.toBeInTheDocument();
});
