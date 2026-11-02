import { useEffect, useState } from "react";
import { Link } from "react-router";
import type { Build, Overview } from "./data";
import { EvidenceUnavailableIcon } from "./EvidenceUnavailableIcon";
import { BenchmarkExecutions } from "./overview/BenchmarkExecutions";
import type { ExecutionAttempt } from "./overview/executions";
import {
  buildDate,
  buildIdentity,
  calendarDays,
  exactBuildHref,
  qualificationOutcome,
} from "./overview/buildTimeline";
import "./overview/BuildTimeline.css";

type Props = {
  engines: Overview["engines"];
  version: string;
  history?: Build[] | null;
  now?: Date;
  executions?: ExecutionAttempt[];
  nested?: boolean;
};

function platformLabel(os: string) {
  return os === "linux" ? "Linux" : os === "windows" ? "Windows" : os;
}

function BuildMark({ build }: { build: Build }) {
  const outcome = qualificationOutcome(build);
  const label = `${build.tag ?? build.build_id} · ${build.build_id} · ${platformLabel(build.os)} · ${build.generated_at} · ${outcome === null ? "Evidence unavailable" : outcome === "pass" ? "Pass (producer qualified)" : "Fail (producer unqualified)"}`;
  return (
    <Link
      to={exactBuildHref(build)}
      aria-label={label}
      title={label}
      className={
        outcome === null ? "build-evidence-missing" : `build-mark ${outcome}`
      }
    >
      {outcome === null ? <EvidenceUnavailableIcon /> : null}
    </Link>
  );
}

function BenchmarkIssues({ attempts }: { attempts: ExecutionAttempt[] }) {
  return (
    <>
      {(["failed", "partial", "unknown"] as const).map((status) => {
        const rows = attempts.filter((row) => row.execution_status === status);
        if (!rows.length) return null;
        const label =
          status === "failed"
            ? "Bench fail"
            : status === "partial"
              ? "Bench partial"
              : "Bench incomplete";
        return (
          <a
            key={status}
            href={rows[0].source_url}
            target="_blank"
            rel="noreferrer"
            className={`build-benchmark-issue ${status}`}
            aria-label={`${label}: ${rows.length} recorded attempt${rows.length === 1 ? "" : "s"}; ${rows[0].engine_version}; ${rows[0].package_os}; separate from qualification`}
            title={`${label}: ${rows.length} recorded attempts; execution evidence, separate from qualification`}
          >
            {label}
          </a>
        );
      })}
    </>
  );
}

export function BuildLegend() {
  return (
    <p className="build-legend">
      <span>
        <i className="build-key pass" /> Pass: producer qualified
      </span>{" "}
      <span>
        <i className="build-key fail" /> Fail: producer unqualified
      </span>{" "}
      <span>
        <EvidenceUnavailableIcon /> Evidence unavailable
      </span>
    </p>
  );
}

export function EngineOverview({
  engines,
  version,
  history = null,
  now,
  executions = [],
  nested = false,
}: Props) {
  const EngineHeading = nested ? "h3" : "h2";
  const TrackHeading = nested ? "h4" : "h3";
  const OSHeading = nested ? "h5" : "h4";
  const [clock, setClock] = useState(() => new Date());
  useEffect(() => {
    if (now) return;
    const timer = window.setInterval(() => setClock(new Date()), 60_000);
    return () => window.clearInterval(timer);
  }, [now]);
  const days = calendarDays(now ?? clock);
  const today = days.at(-1)!;
  return (
    <section aria-label="Engine readiness" className="grid items-start gap-6">
      {!nested && <BuildLegend />}
      {history === null && (
        <p role="status">
          History loading or unavailable; showing latest recorded builds only.
        </p>
      )}
      {engines.map((engine) => {
        const records = history ?? engine.latest_builds;
        const builds = [
          ...new Map(
            records
              .filter(
                (build) =>
                  build.engine === engine.id && build.rocm_version === version,
              )
              .map((build) => [buildIdentity(build), build]),
          ).values(),
        ].sort(
          (a, b) =>
            Date.parse(a.generated_at) - Date.parse(b.generated_at) ||
            buildIdentity(a).localeCompare(buildIdentity(b)),
        );
        const engineAttempts = executions.filter(
          (row) => row.engine === engine.id && row.rocm_version === version,
        );
        if (!builds.length && !engineAttempts.length) return null;
        const channels = [
          ...new Set(builds.map((build) => build.channel)),
        ].sort((a, b) => Number(b === "stable") - Number(a === "stable"));
        return (
          <article
            className="card engine-card build-timeline-card"
            key={engine.id}
            aria-label={engine.label}
          >
            <EngineHeading>{engine.label}</EngineHeading>
            {!builds.length && <p>No qualification build records</p>}
            {channels.map((channel) => {
              const channelBuilds = builds.filter(
                (build) => build.channel === channel,
              );
              const platforms = [
                ...new Set([
                  ...engine.platforms,
                  ...channelBuilds.map((build) => build.os),
                ]),
              ];
              return (
                <section
                  key={channel}
                  className="build-tile"
                  aria-label={`${engine.label} ROCm ${version} ${channel}`}
                >
                  <TrackHeading>
                    ROCm {version}
                    {` · ${channel === "stable" ? "Stable" : "Nightly"}`}
                  </TrackHeading>
                  {platforms.length > 0 && (
                    <div
                      className="build-timeline-scroll"
                      tabIndex={0}
                      role="region"
                      aria-label={`${engine.label} ${channel} build history`}
                    >
                      <table className="build-timeline">
                        <thead>
                          <tr>
                            <th scope="col">OS</th>
                            {days.map((day) => (
                              <th
                                scope="col"
                                key={day}
                                aria-label={`${day} UTC`}
                                aria-current={
                                  day === today ? "date" : undefined
                                }
                              >
                                <time dateTime={day}>{day.slice(5)}</time>
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {platforms.map((os) => {
                            const rows = channelBuilds.filter(
                              (build) => build.os === os,
                            );
                            return (
                              <tr key={os}>
                                <th scope="row">
                                  <OSHeading>{platformLabel(os)}</OSHeading>
                                  {!rows.length && (
                                    <small>No qualification evidence</small>
                                  )}
                                </th>
                                {days.map((day) => (
                                  <td key={day}>
                                    <div className="build-day">
                                      {!rows.some(
                                        (build) => buildDate(build) === day,
                                      ) && (
                                        <span className="build-no-data">
                                          No data
                                        </span>
                                      )}
                                      {rows
                                        .filter(
                                          (build) => buildDate(build) === day,
                                        )
                                        .map((build) => (
                                          <div
                                            className="build-evidence"
                                            key={buildIdentity(build)}
                                          >
                                            <BuildMark build={build} />
                                            <BenchmarkIssues
                                              attempts={engineAttempts.filter(
                                                (row) =>
                                                  row.qualification_build_id ===
                                                    build.build_id &&
                                                  row.channel ===
                                                    build.channel &&
                                                  row.package_os === build.os,
                                              )}
                                            />
                                          </div>
                                        ))}
                                    </div>
                                  </td>
                                ))}
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </section>
              );
            })}
            <BenchmarkExecutions
              attempts={engineAttempts}
              visibleBuilds={builds.filter((build) =>
                days.includes(buildDate(build) ?? ""),
              )}
            />
          </article>
        );
      })}
    </section>
  );
}
