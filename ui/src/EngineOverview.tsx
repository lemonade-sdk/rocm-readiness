import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { loadHistory, loadVersion } from "./data";
import type { Build, Fetcher, Session } from "./data";
import {
  dailyTimeline,
  dayHref,
  dayLabel,
  statusLabels,
  statusSymbols,
} from "./overview/timeline";
import type { DailyStatus } from "./overview/timeline";
import "./overview/Timeline.css";

type VersionState = {
  version: string;
  session?: Session;
  builds?: Build[];
  error?: string;
};
export function EngineOverview({
  session,
  fetcher,
  onRetry,
}: {
  session: Session;
  fetcher: Fetcher;
  onRetry: () => void;
}) {
  const [loaded, setLoaded] = useState<{
    session: Session;
    rows: VersionState[];
  } | null>(null);
  const [params, setParams] = useSearchParams();
  const requestedDays = Number(params.get("days"));
  const days = [14, 20, 30].includes(requestedDays) ? requestedDays : 14;
  const setDays = (value: number) => {
    const next = new URLSearchParams(params);
    next.set("days", String(value));
    setParams(next, { replace: true });
  };
  useEffect(() => {
    const controller = new AbortController();
    const versions = [...session.index.versions].sort(
      (a, b) =>
        Number(b.rocm_version === session.index.default_version) -
        Number(a.rocm_version === session.index.default_version),
    );
    setLoaded({
      session,
      rows: versions.map((row) => ({ version: row.rocm_version })),
    });
    for (const row of versions) {
      (async () => {
        try {
          const scope =
            row.rocm_version === session.version && session.overview
              ? session
              : await loadVersion(
                  session,
                  row.rocm_version,
                  fetcher,
                  controller.signal,
                );
          const builds = await loadHistory(scope, fetcher, controller.signal);
          for (const engine of scope.overview!.engines) {
            if (
              builds.filter((build) => build.engine === engine.id).length !==
              engine.build_count
            )
              throw new Error(
                "Retained history count does not match the overview",
              );
          }
          if (!controller.signal.aborted)
            setLoaded((current) =>
              current?.session === session
                ? {
                    session,
                    rows: current.rows.map((entry) =>
                      entry.version === row.rocm_version
                        ? { version: row.rocm_version, session: scope, builds }
                        : entry,
                    ),
                  }
                : current,
            );
        } catch (reason) {
          if (!controller.signal.aborted)
            setLoaded((current) =>
              current?.session === session
                ? {
                    session,
                    rows: current.rows.map((entry) =>
                      entry.version === row.rocm_version
                        ? {
                            ...entry,
                            error:
                              reason instanceof Error
                                ? reason.message
                                : "Unable to load history",
                          }
                        : entry,
                    ),
                  }
                : current,
            );
        }
      })();
    }
    return () => controller.abort();
  }, [session, fetcher]);
  const rows = loaded?.session === session ? loaded.rows : [];
  const engines = new Map<string, string>();
  for (const row of rows)
    for (const engine of row.session?.overview?.engines ?? [])
      if (row.builds?.some((build) => build.engine === engine.id))
        engines.set(engine.id, engine.label);
  const end = session.index.generated_at;
  return (
    <section aria-label="Engine readiness" className="grid items-start gap-6">
      <div className="timeline-intro">
        <div>
          <label htmlFor="timeline-window">Timeline window</label>{" "}
          <select
            id="timeline-window"
            value={days}
            onChange={(event) => setDays(Number(event.target.value))}
          >
            {[14, 20, 30].map((value) => (
              <option key={value} value={value}>
                {value} days
              </option>
            ))}
          </select>
        </div>
        <p>
          UTC report dates · through {new Date(end).toISOString().slice(0, 10)}{" "}
          · dataset captured {new Date(end).toUTCString()}
        </p>
        <p>
          Each symbol includes every qualification record that day. A
          nonqualified build takes precedence; unknown qualification prevents
          green. Empty days do not prove no build ran.
        </p>
        <div className="timeline-legend" aria-label="Qualification legend">
          {(Object.keys(statusLabels) as DailyStatus[]).map((status) => (
            <span key={status}>
              <i
                className={`health-symbol health-${status}`}
                aria-hidden="true"
              >
                {statusSymbols[status]}
              </i>
              {statusLabels[status]}
            </span>
          ))}
        </div>
      </div>
      {rows
        .filter((row) => row.error || !row.builds)
        .map((row) => (
          <div
            key={row.version}
            className={row.error ? "notice error" : "notice"}
            role={row.error ? "alert" : "status"}
          >
            ROCm {row.version}: {row.error ?? "Loading qualification history…"}
            {row.error && <button onClick={onRetry}>Retry history</button>}
          </div>
        ))}
      {[...engines].map(([id, label]) => (
        <article className="card engine-card" key={id}>
          <div className="card-heading">
            <h2>{label}</h2>
            <span>Qualification history</span>
          </div>
          {rows
            .filter((row) => row.builds?.some((build) => build.engine === id))
            .map((row) => {
              const builds = row.builds!.filter((build) => build.engine === id);
              const groups = [...new Set(builds.map((build) => build.channel))];
              return groups.map((channel) => (
                <section
                  key={`${row.version}:${channel}`}
                  aria-label={`${label} ROCm ${row.version} ${channel}`}
                  className="timeline-scope"
                >
                  <div className="card-heading">
                    <h3>
                      ROCm {row.version} ·{" "}
                      {channel === "stable" ? "Stable engine" : channel}
                    </h3>
                    <Link
                      className="text-link"
                      to={`?${new URLSearchParams({ version: row.version, view: "engine", engine: id, channel })}`}
                    >
                      Explore builds
                    </Link>
                  </div>
                  <div
                    className="timeline-scroll"
                    tabIndex={0}
                    role="region"
                    aria-label={`${label} ROCm ${row.version} timeline`}
                  >
                    <table className="health-table">
                      <thead>
                        <tr>
                          <th scope="col">OS / latest report (UTC)</th>
                          {dailyTimeline([], end, days).map((day) => (
                            <th scope="col" key={day.date}>
                              <time dateTime={day.date}>
                                {day.date.slice(5)}
                              </time>
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {[
                          ...new Set(
                            builds
                              .filter((build) => build.channel === channel)
                              .map((build) => build.os),
                          ),
                        ]
                          .sort()
                          .map((os) => {
                            const platformBuilds = builds.filter(
                              (build) =>
                                build.channel === channel && build.os === os,
                            );
                            const latest = platformBuilds.reduce((a, b) =>
                              Date.parse(a.generated_at) >
                              Date.parse(b.generated_at)
                                ? a
                                : b,
                            );
                            return (
                              <tr key={os}>
                                <th scope="row">
                                  {os === "linux"
                                    ? "Linux"
                                    : os === "windows"
                                      ? "Windows"
                                      : os}
                                  <small>
                                    <time dateTime={latest.generated_at}>
                                      {new Date(latest.generated_at)
                                        .toISOString()
                                        .replace("T", " ")
                                        .slice(0, 16)}
                                    </time>
                                  </small>
                                </th>
                                {dailyTimeline(platformBuilds, end, days).map(
                                  (day) => (
                                    <td key={day.date}>
                                      {day.builds.length ? (
                                        <Link
                                          className={`health-symbol health-${day.status}`}
                                          title={dayLabel(day)}
                                          aria-label={`${label} ROCm ${row.version} ${channel} ${os}: ${dayLabel(day)}`}
                                          to={dayHref(
                                            day.builds[0],
                                            day.date,
                                            days,
                                          )}
                                        >
                                          {statusSymbols[day.status]}
                                        </Link>
                                      ) : (
                                        <span
                                          className="health-symbol health-no-report"
                                          title={dayLabel(day)}
                                          aria-label={dayLabel(day)}
                                        >
                                          —
                                        </span>
                                      )}
                                    </td>
                                  ),
                                )}
                              </tr>
                            );
                          })}
                      </tbody>
                    </table>
                  </div>
                </section>
              ));
            })}
        </article>
      ))}
    </section>
  );
}
