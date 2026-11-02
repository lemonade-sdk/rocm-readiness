import { useEffect, useState } from "react";
import {
  loadVersion,
  loadHistory,
  type Build,
  type Fetcher,
  type Session,
} from "./data";
import { EngineOverview } from "./EngineOverview";
import sources from "../../sources.json";

type VersionEvidence = {
  version: string;
  session?: Session;
  builds: Build[] | null;
  error?: string;
  historyError?: string;
};
export function ReadinessOverview({
  session,
  fetcher,
  onRetry,
}: {
  session: Session;
  fetcher: Fetcher;
  onRetry: () => void;
}) {
  const [state, setState] = useState<{
    revision: string;
    rows: VersionEvidence[];
  } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void Promise.all(
      session.index.versions.map(async (entry): Promise<VersionEvidence> => {
        const row: VersionEvidence = {
          version: entry.rocm_version,
          builds: null,
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
          try {
            row.builds = await loadHistory(
              row.session,
              fetcher,
              controller.signal,
            );
          } catch (error) {
            row.historyError = String(error);
          }
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
  }, [session, fetcher]);

  if (state?.revision !== session.indexUrl)
    return <p role="status">Loading recorded ROCm versions…</p>;
  const records = (row: VersionEvidence) =>
    row.builds ??
    row.session?.overview?.engines.flatMap((engine) => engine.latest_builds) ??
    [];
  const visible = state.rows.filter(
    (row) => row.error || row.historyError || records(row).length,
  );
  const stable = session.index.readiness?.stable_anchor;
  const rows = visible; // The collector owns version selection and ordering.
  return (
    <div className="readiness-versions">
      {!session.index.readiness && (
        <p>This older dataset does not declare its ROCm track scope.</p>
      )}
      {state.rows.some((row) => row.historyError) && (
        <button onClick={onRetry}>Retry history</button>
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
            />
          )}
        </section>
      ))}
      {stable && !rows.some((row) => row.version === stable) && (
        <p>No recorded evidence for configured stable ROCm {stable}.</p>
      )}
      {!rows.length && <p>No qualification build records are available.</p>}
    </div>
  );
}
