import { useEffect, useState } from "react";
import { Link } from "react-router";
import type { Build, Overview } from "./data";
import { EvidenceUnavailableIcon } from "./EvidenceUnavailableIcon";
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

export function EngineOverview({
  engines,
  version,
  history = null,
  now,
}: Props) {
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
        if (!builds.length) return null;
        const channels = [
          ...new Set(builds.map((build) => build.channel)),
        ].sort((a, b) => Number(b === "stable") - Number(a === "stable"));
        return (
          <article
            className="card engine-card build-timeline-card"
            key={engine.id}
            aria-label={engine.label}
          >
            <h2>{engine.label}</h2>
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
                  <h3>
                    ROCm {version}
                    {` · ${channel === "stable" ? "Stable" : "Nightly"}`}
                  </h3>
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
                                  <h4>{platformLabel(os)}</h4>
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
                                          <BuildMark
                                            key={buildIdentity(build)}
                                            build={build}
                                          />
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
          </article>
        );
      })}
    </section>
  );
}
