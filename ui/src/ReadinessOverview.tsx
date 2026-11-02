import { useEffect, useState } from "react";
import {
  loadVersion,
  loadHistory,
  type Build,
  type Fetcher,
  type Session,
} from "./data";
import { BuildLegend, EngineOverview } from "./EngineOverview";
import { loadExecutions, type ExecutionAttempt } from "./overview/executions";
import sources from "../../sources.json";

type VersionEvidence = {
  version: string;
  session?: Session;
  builds: Build[] | null;
  attempts: ExecutionAttempt[];
  error?: string;
  historyError?: string;
  executionError?: string;
};
const versionCollator = new Intl.Collator("en", {
  numeric: true,
  sensitivity: "base",
});
export function compareVersions(a: string, b: string): number {
  const split = (v: string) => {
    const m = /^(\d+(?:\.\d+)*)(.*)$/.exec(v);
    return {
      numbers: (m?.[1] ?? "0").split(".").map(Number),
      suffix: m?.[2] ?? v,
    };
  };
  const x = split(a),
    y = split(b);
  for (let i = 0; i < Math.max(x.numbers.length, y.numbers.length); i++) {
    const difference = (x.numbers[i] ?? 0) - (y.numbers[i] ?? 0);
    if (difference) return difference;
  }
  if (!x.suffix && y.suffix) return 1;
  if (x.suffix && !y.suffix) return -1;
  return versionCollator.compare(x.suffix, y.suffix);
}

export function ReadinessOverview({
  session,
  fetcher,
  onRetry,
  stableAnchor = sources.views.readiness.stable_anchor,
}: {
  session: Session;
  fetcher: Fetcher;
  onRetry: () => void;
  stableAnchor?: string;
}) {
  const [state, setState] = useState<{
    revision: string;
    rows: VersionEvidence[];
  } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void Promise.all(
      session.index.versions
        .filter(
          (entry) => compareVersions(entry.rocm_version, stableAnchor) >= 0,
        )
        .map(async (entry): Promise<VersionEvidence> => {
          const row: VersionEvidence = {
            version: entry.rocm_version,
            builds: null,
            attempts: [],
          };
          try {
            row.session =
              session.version === entry.rocm_version && session.overview
                ? session
                : await loadVersion(
                    session,
                    entry.rocm_version,
                    fetcher,
                    controller.signal,
                  );
            const [history, execution] = await Promise.allSettled([
              loadHistory(row.session, fetcher, controller.signal),
              loadExecutions(row.session, fetcher, controller.signal),
            ]);
            if (history.status === "fulfilled") row.builds = history.value;
            else row.historyError = String(history.reason);
            if (execution.status === "fulfilled")
              row.attempts = execution.value;
            else row.executionError = String(execution.reason);
          } catch (error) {
            row.error = String(error);
          }
          return row;
        }),
    ).then((rows) => {
      if (!controller.signal.aborted)
        setState({ revision: session.indexUrl, rows });
    });
    return () => controller.abort();
  }, [session, fetcher, stableAnchor]);
  if (state?.revision !== session.indexUrl)
    return <p role="status">Loading recorded ROCm versions…</p>;
  const records = (row: VersionEvidence) =>
    row.builds ??
    row.session?.overview?.engines.flatMap((engine) => engine.latest_builds) ??
    [];
  const visible = state.rows.filter(
    (row) =>
      row.error ||
      row.historyError ||
      row.executionError ||
      records(row).length ||
      row.attempts.length ||
      row.session?.overview?.performance.status === "available",
  );
  // The catalog default is the highest observed version, not a GA declaration.
  // Release policy is explicitly owned in sources.json, independent of build channel.
  const stable = stableAnchor;
  const rows = [...visible].sort((a, b) =>
    compareVersions(a.version, b.version),
  );
  return (
    <div className="readiness-versions">
      {!!rows.length && <BuildLegend />}
      {state.rows.some((row) => row.historyError) && (
        <button onClick={onRetry}>Retry history</button>
      )}
      {state.rows.some((row) => row.executionError) && (
        <button onClick={onRetry}>Retry benchmark evidence</button>
      )}
      {rows.map((row) => (
        <section
          key={row.version}
          className="readiness-version"
          aria-label={`ROCm ${row.version}`}
        >
          <h2>
            ROCm {row.version}
            {row.version === stable ? " · Latest stable" : ""}
          </h2>
          {row.error && (
            <div role="alert">
              {row.error} <button onClick={onRetry}>Retry data</button>
            </div>
          )}
          {row.historyError && (
            <p role="alert">
              Qualification history unavailable: {row.historyError}
            </p>
          )}
          {row.executionError && (
            <p role="alert">
              Benchmark evidence unavailable: {row.executionError}
            </p>
          )}
          {row.session?.overview && (
            <EngineOverview
              version={row.version}
              history={row.builds}
              nested
              engines={row.session.overview.engines.map((engine) => ({
                ...engine,
                platforms:
                  sources.engines.find(
                    (configured) => configured.id === engine.id,
                  )?.platforms ?? engine.platforms,
              }))}
              executions={row.attempts}
            />
          )}
          {!records(row).length &&
            !row.attempts.length &&
            row.session?.overview?.performance.status === "available" && (
              <p>
                Measurements are available, but build qualification and
                execution outcomes are not recorded.
              </p>
            )}
        </section>
      ))}
      {!rows.some((row) => row.version === stable) && (
        <p>No recorded evidence for configured stable ROCm {stable}.</p>
      )}
      {!rows.length && <p>No build or benchmark records are available.</p>}
    </div>
  );
}
