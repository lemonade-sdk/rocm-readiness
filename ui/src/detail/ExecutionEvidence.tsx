import { useEffect, useState } from "react";
import type { Build, Fetcher, Session } from "../data";
import { loadExecutions, type ExecutionAttempt } from "../overview/executions";
import { scopeBuilds } from "./scope";
import "./detail.css";

export function scopedAttempts(
  attempts: ExecutionAttempt[],
  params: URLSearchParams,
  builds: Build[] | null,
) {
  const matches = builds
    ? scopeBuilds(builds, params).filter(
        (b) =>
          !params.get("platform") ||
          params.get("platform") === "all" ||
          b.os === params.get("platform"),
      )
    : [];
  return attempts.filter((row) => {
    if (params.get("engine") && row.engine !== params.get("engine"))
      return false;
    if (params.get("channel") && row.channel !== params.get("channel"))
      return false;
    if (
      params.get("platform") &&
      params.get("platform") !== "all" &&
      row.package_os !== params.get("platform")
    )
      return false;
    if (params.get("model") && row.model !== params.get("model")) return false;
    if (params.get("workload") && row.scenario !== params.get("workload"))
      return false;
    if (
      params.get("system") &&
      params.get("system") !== "all" &&
      row.system_id !== params.get("system")
    )
      return false;
    // A qualification source identifies a build, not the benchmark producer.
    if (params.get("build") || params.get("source") || params.get("date")) {
      return (
        matches.filter(
          (b) =>
            row.qualification_build_id === b.build_id &&
            row.engine === b.engine &&
            row.channel === b.channel &&
            row.package_os === b.os &&
            row.rocm_version === b.rocm_version &&
            row.engine_version === b.tag &&
            (!b.artifact || packageName(row.package_url) === b.artifact) &&
            (!b.source_url ||
              repository(b.source_url) === row.engine_repository),
        ).length === 1
      );
    }
    return true;
  });
}
function packageName(url: string) {
  return decodeURIComponent(new URL(url).pathname.split("/").at(-1) ?? "");
}
function repository(url: string) {
  return new URL(url).pathname.split("/").filter(Boolean).slice(0, 2).join("/");
}
function hardware(row: ExecutionAttempt) {
  const gpu = row.hardware.gpu;
  const names = Array.isArray(gpu)
    ? gpu
        .map((v) =>
          typeof v === "object" && v !== null && "name" in v
            ? String(v.name)
            : "GPU unavailable",
        )
        .join(", ")
    : "GPU unavailable";
  return [
    row.hardware.cpu ?? "CPU unavailable",
    names,
    row.hardware.os ?? row.package_os,
  ].join(" · ");
}
export function ExecutionEvidence({
  session,
  fetcher,
  params,
  builds,
}: {
  session: Session;
  fetcher: Fetcher;
  params: URLSearchParams;
  builds: Build[] | null;
}) {
  const [retry, setRetry] = useState(0);
  const [state, setState] = useState<{
    session: Session;
    rows?: ExecutionAttempt[];
    error?: string;
  } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setState(null);
    loadExecutions(session, fetcher, controller.signal)
      .then((rows) => {
        if (!controller.signal.aborted) setState({ session, rows });
      })
      .catch((reason) => {
        if (!controller.signal.aborted)
          setState({
            session,
            error:
              reason instanceof Error
                ? reason.message
                : "Execution evidence unavailable",
          });
      });
    return () => controller.abort();
  }, [session, fetcher, retry]);
  const rows =
    state?.session === session && state.rows
      ? scopedAttempts(state.rows, params, builds)
      : [];
  return (
    <section
      className="execution-evidence card"
      aria-label="Model execution evidence"
    >
      <h2>Model execution evidence</h2>
      <p>
        Attempts include metricless failures. Execution does not establish
        speed, answer accuracy, qualification or artifact publication.
      </p>
      {!session.overview?.execution ? (
        <p>Execution evidence unavailable for this dataset.</p>
      ) : !state || state.session !== session ? (
        <p role="status">Loading execution attempts…</p>
      ) : state.error ? (
        <div role="alert">
          <p>{state.error}</p>
          <button onClick={() => setRetry((n) => n + 1)}>
            Retry execution evidence
          </button>
        </div>
      ) : (
        <>
          <p>
            {rows.length} recorded attempts in this scope ·{" "}
            {new Set(rows.map((row) => row.model)).size} unique{" "}
            {new Set(rows.map((row) => row.model)).size === 1
              ? "model"
              : "models"}
          </p>
          {!rows.length ? (
            <p>
              No execution attempts match this scope. Unmatched packages are not
              attributed to a selected build.
            </p>
          ) : (
            <details>
              <summary>Inspect execution attempts</summary>
              <div className="detail-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Model / workload</th>
                      <th>Outcome</th>
                      <th>Measured package / date</th>
                      <th>Physical system / OS</th>
                      <th>Evidence</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row, i) => (
                      <tr key={`${row.source_url}-${row.source_pointer}-${i}`}>
                        <th scope="row">
                          {row.model}
                          <small>
                            {row.scenario} ·{" "}
                            {row.quant ?? "Quantization unavailable"} ·{" "}
                            {row.context_size ?? "Unknown"} context tokens
                          </small>
                        </th>
                        <td>
                          {row.execution_status}
                          <small>Cause: not inferred</small>
                        </td>
                        <td>
                          {row.engine_version ?? "Unknown package"}
                          <small>
                            {row.measured_at} · {row.channel} · ROCm{" "}
                            {row.rocm_version}
                          </small>
                        </td>
                        <td>{hardware(row)}</td>
                        <td>
                          <a
                            href={row.source_url}
                            target="_blank"
                            rel="noreferrer"
                          >
                            Producer record ↗
                          </a>
                          <small>{row.source_id}</small>
                          {row.run_url && (
                            <a
                              href={row.run_url}
                              target="_blank"
                              rel="noreferrer"
                            >
                              Run ↗
                            </a>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          )}
        </>
      )}
    </section>
  );
}
