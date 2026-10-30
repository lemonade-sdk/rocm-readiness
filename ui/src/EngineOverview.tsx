import { useEffect, useState } from "react";
import { Link } from "react-router";
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
  const days = 14;
  useEffect(() => {
    const controller = new AbortController();
    const versions = [...session.index.versions].sort((a, b) =>
      b.rocm_version.localeCompare(a.rocm_version, "en", { numeric: true }),
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
  const end = session.index.generated_at;
  return (
    <section aria-label="Engine readiness" className="grid items-start gap-6">
      <div className="timeline-intro">
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
      {rows
        .filter((row) => row.builds?.length)
        .map((row) => (
          <section
            className="rocm-version-group"
            key={row.version}
            aria-label={`ROCm ${row.version}`}
          >
            <h2>ROCm {row.version}</h2>
            <div className="grid items-start gap-6">
              {row
                .session!.overview!.engines.filter((engine) =>
                  row.builds!.some((build) => build.engine === engine.id),
                )
                .map((engine) => {
                  const id = engine.id;
                  const label = engine.label;
                  const builds = row.builds!.filter(
                    (build) => build.engine === id,
                  );
                  const groups = [
                    ...new Set(builds.map((build) => build.channel)),
                  ].sort(
                    (a, b) => Number(b === "stable") - Number(a === "stable"),
                  );
                  return (
                    <article className="card engine-card" key={id}>
                      <h3>{label}</h3>
                      {groups.map((channel) => {
                        const latestDay = builds
                          .filter((build) => build.channel === channel)
                          .map((build) =>
                            new Date(build.generated_at)
                              .toISOString()
                              .slice(0, 10),
                          )
                          .sort()
                          .at(-1);
                        return (
                          <section
                            key={channel}
                            aria-label={`${label} ROCm ${row.version} ${channel}`}
                            className="timeline-scope"
                          >
                            <div className="card-heading">
                              <h4>
                                {channel === "stable" ? "Stable" : channel}
                              </h4>
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
                                    <th scope="col">
                                      OS / latest report (UTC)
                                    </th>
                                    {dailyTimeline([], end, days).map((day) => (
                                      <th
                                        scope="col"
                                        key={day.date}
                                        className={
                                          day.date === latestDay
                                            ? "health-latest-date"
                                            : undefined
                                        }
                                        aria-label={
                                          day.date === latestDay
                                            ? `${day.date} · Latest recorded day`
                                            : undefined
                                        }
                                      >
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
                                        .filter(
                                          (build) => build.channel === channel,
                                        )
                                        .map((build) => build.os),
                                    ),
                                  ]
                                    .sort()
                                    .map((os) => {
                                      const platformBuilds = builds.filter(
                                        (build) =>
                                          build.channel === channel &&
                                          build.os === os,
                                      );
                                      const latest = platformBuilds.reduce(
                                        (a, b) =>
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
                                              <time
                                                dateTime={latest.generated_at}
                                              >
                                                {new Date(latest.generated_at)
                                                  .toISOString()
                                                  .replace("T", " ")
                                                  .slice(0, 16)}
                                              </time>
                                            </small>
                                          </th>
                                          {dailyTimeline(
                                            platformBuilds,
                                            end,
                                            days,
                                          ).map((day) => (
                                            <td key={day.date}>
                                              {day.builds.length ? (
                                                <Link
                                                  className={`health-symbol health-${day.status}`}
                                                  title={dayLabel(day)}
                                                  aria-label={`${label} ROCm ${row.version} ${channel} ${os}: ${dayLabel(day)}`}
                                                  to={dayHref(
                                                    day.builds[0],
                                                    day.date,
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
                                          ))}
                                        </tr>
                                      );
                                    })}
                                </tbody>
                              </table>
                            </div>
                          </section>
                        );
                      })}
                    </article>
                  );
                })}
            </div>
          </section>
        ))}
    </section>
  );
}
