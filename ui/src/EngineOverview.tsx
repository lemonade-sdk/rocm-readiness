import { useEffect, useState } from "react";
import { Tooltip } from "./overview/Tooltip";
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
  nested?: boolean;
  emptyChannel?: Build["channel"];
};

function platformLabel(os: string) {
  return os === "linux" ? "Linux" : os === "windows" ? "Windows" : os;
}

function BuildMark({ build, dayCount = 1 }: { build: Build; dayCount?: number }) {
  const outcome = qualificationOutcome(build);
  const failureReasons = [
    ...(build.blocked_by ?? []),
    ...(build.blocking_tests ?? []),
    ...Object.entries(build.results ?? {})
      .filter(([, result]) => ["fail", "failed", "error"].includes(result.toLowerCase()))
      .map(([test]) => `${test} failed`),
  ];
  const status = outcome === null
    ? "Evidence unavailable"
    : outcome === "fail"
      ? "Failed"
      : build.overall === "warn" ? "Qualified with warnings" : "Qualified";
  const label = `${build.tag ?? build.build_id} · ${build.build_id} · ${platformLabel(build.os)} · ${build.generated_at} · ${status}`;
  const dayLink = dayCount > 1
    ? `?${new URLSearchParams({ view: "engine", version: build.rocm_version, engine: build.engine, channel: "nightly", platform: build.os, day: buildDate(build) })}`
    : null;
  return (
    <Tooltip
      to={dayLink ?? exactBuildHref(build)}
      label={dayLink ? `${dayCount} nightly builds on ${buildDate(build)} · ${platformLabel(build.os)} · latest ${status}` : label}
      triggerClassName={
        outcome === null ? "build-evidence-missing" : `build-mark ${outcome}`
      }
      content={
        <>
          <span className="build-tooltip-header">
            <strong className="comparison-title">
              {dayLink && `${dayCount} builds · latest: `}
              {build.tag ?? "Build"} · {platformLabel(build.os)}
            </strong>
            <span className={`build-tooltip-status ${outcome ?? "unknown"}`}>
              {status}
            </span>
          </span>
          <dl className="build-tooltip-details">
            {outcome === "fail" && (
              <>
                <dt>Failure reason</dt>
                <dd>{failureReasons.length ? [...new Set(failureReasons)].join("; ") : "Not reported"}</dd>
              </>
            )}
            <dt>Build job</dt>
            <dd>{build.build_result == null
              ? "Source feed did not report a build result"
              : build.build_result === "unknown"
                ? "Source feed could not determine the build result"
                : build.build_result}</dd>
            <dt>Publication</dt>
            <dd>{build.published == null
              ? "Source feed did not report whether this archive shipped"
              : build.published ? "Shipped in this run" : "Did not ship in this run"}</dd>
            <dt>Reported</dt>
            <dd>
              {new Intl.DateTimeFormat("en-GB", {
                day: "numeric",
                month: "short",
                year: "numeric",
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
                hourCycle: "h23",
                timeZone: "UTC",
              }).format(new Date(build.generated_at))}{" "}
              UTC
            </dd>
            <dt>Channel</dt>
            <dd>{build.channel === "stable" ? "Stable" : "Nightly"}</dd>
            {build.upstream_sha && (
              <>
                <dt>Revision</dt>
                <dd>{build.upstream_sha.slice(0, 12)}</dd>
              </>
            )}
            <dt>Build</dt>
            <dd>{build.build_id}</dd>
          </dl>
        </>
      }
    >
      {outcome === null ? <EvidenceUnavailableIcon /> : null}
    </Tooltip>
  );
}

export function EngineOverview({
  engines,
  version,
  history = null,
  now,
  nested = false,
  emptyChannel,
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
  const months: { key: string; label: string; days: number }[] = [];
  for (const day of days) {
    const key = day.slice(0, 7),
      prior = months.at(-1);
    if (prior?.key === key) prior.days++;
    else
      months.push({
        key,
        label: new Intl.DateTimeFormat("en", {
          month: "long",
          timeZone: "UTC",
        }).format(new Date(`${day}T00:00:00Z`)),
        days: 1,
      });
  }
  const monthBoundary = (index: number) =>
    index > 0 && days[index].slice(0, 7) !== days[index - 1].slice(0, 7);

  return (
    <section aria-label="Engine readiness" className="grid items-start gap-6">
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
        if (!builds.length && !emptyChannel) return null;
        const channels = [
          ...new Set(builds.map((build) => build.channel)),
        ].sort((a, b) => Number(b === "stable") - Number(a === "stable"));
        if (!channels.length && emptyChannel) channels.push(emptyChannel);
        return (
          <article
            className="card engine-card build-timeline-card"
            key={engine.id}
            aria-label={engine.label}
          >
            <EngineHeading className="build-engine-heading">
              {engine.label}
            </EngineHeading>
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
                  {channels.length > 1 && (
                    <TrackHeading>
                      {channel === "stable" ? "Stable" : "Nightly"}
                    </TrackHeading>
                  )}
                  {platforms.length > 0 && (
                    <div
                      className="build-timeline-scroll"
                      tabIndex={0}
                      role="region"
                      aria-label={`${engine.label} ${channel} build history`}
                    >
                      <table className="build-timeline">
                        <colgroup>
                          <col />
                        </colgroup>
                        {months.map((month) => (
                          <colgroup key={month.key} span={month.days} />
                        ))}
                        <thead>
                          <tr className="build-months">
                            <th scope="col" rowSpan={2} className="os-column">
                              OS
                            </th>
                            {months.map((month, index) => (
                              <th
                                key={month.key}
                                scope="colgroup"
                                colSpan={month.days}
                                className={
                                  index > 0 ? "month-boundary" : undefined
                                }
                                aria-label={`${month.label} ${month.key.slice(0, 4)}`}
                              >
                                {month.label}
                              </th>
                            ))}
                          </tr>
                          <tr>
                            {days.map((day, index) => (
                              <th
                                scope="col"
                                key={day}
                                className={
                                  monthBoundary(index)
                                    ? "month-boundary"
                                    : undefined
                                }
                                aria-label={`${day} UTC`}
                                aria-current={
                                  day === today ? "date" : undefined
                                }
                              >
                                <time dateTime={day}>
                                  {Number(day.slice(8))}
                                </time>
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
                                {days.map((day, index) => {
                                  const dayBuilds = rows.filter(
                                    (build) => buildDate(build) === day,
                                  );
                                  const visibleBuilds =
                                    channel === "nightly" ? dayBuilds.slice(-1) : dayBuilds;
                                  return (
                                    <td
                                      key={day}
                                      className={
                                        monthBoundary(index)
                                          ? "month-boundary"
                                          : undefined
                                      }
                                    >
                                      <div className="build-day">
                                        {!visibleBuilds.length && (
                                          <span className="build-no-data">
                                            No data
                                          </span>
                                        )}
                                        {visibleBuilds.map((build) => (
                                            <BuildMark
                                              key={buildIdentity(build)}
                                              build={build}
                                              dayCount={channel === "nightly" && history !== null ? dayBuilds.length : 1}
                                            />
                                          ))}
                                      </div>
                                    </td>
                                  );
                                })}
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
