import { useUtcToday } from "./overview/useUtcToday";
import { Tooltip, TooltipContent } from "./overview/Tooltip";
import type { Build, Overview } from "./data";
import { BuildOutcomeIcon } from "./overview/BuildOutcomeIcon";
import {
  buildDate,
  buildIdentity,
  calendarDays,
  calendarMonthGroups,
  isCalendarMonthBoundary,
  qualificationBuildHref,
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
  const mark = outcome === "pass" && build.overall === "warn" ? "warn" : outcome;
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
  return (
    <Tooltip
      to={qualificationBuildHref(build, dayCount > 1 ? "day" : "package")}
      label={`Open package qualification · ${label}${dayCount > 1 ? ` · ${dayCount} packages` : ""}`}
      triggerClassName={
        outcome === null ? "build-evidence-missing" : `build-mark ${outcome}`
      }
      content={
        <TooltipContent
          heading={<>{dayCount > 1 && `${dayCount} packages · latest: `}{build.tag ?? "Build"} · {platformLabel(build.os)}</>}
          status={<span className={`build-tooltip-status ${outcome ?? "unknown"}`}>{status}</span>}
        >
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
        </TooltipContent>
      }
    >
      <BuildOutcomeIcon outcome={mark} />
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
  const OSHeading = nested ? "h5" : "h4";
  const today = useUtcToday(now);
  const days = calendarDays(new Date(today));
  const months = calendarMonthGroups(days);

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
            className="build-timeline-card"
            key={engine.id}
            aria-label={engine.label}
          >
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
                  <div className="data-table-heading">
                    <EngineHeading className="data-table-title">
                      {engine.label}
                    </EngineHeading>
                    {channels.length > 1 && (
                      <span>{channel === "stable" ? "Stable" : "Nightly"}</span>
                    )}
                  </div>
                  {platforms.length > 0 && (
                    <div
                      className="build-timeline-scroll calendar-surface"
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
                          <tr className="calendar-months">
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
                                  isCalendarMonthBoundary(days, index)
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
                                  const latestBuild = dayBuilds.at(-1);
                                  const verdict = latestBuild ? qualificationOutcome(latestBuild) : null;
                                  const cellStatus = verdict === "pass" && latestBuild?.overall === "warn" ? "warn" : verdict;
                                  return (
                                    <td
                                      data-outcome={latestBuild ? cellStatus ?? "unreported" : undefined}
                                      key={day}
                                      className={
                                        isCalendarMonthBoundary(days, index)
                                          ? "table-status month-boundary"
                                          : "table-status"
                                      }
                                    >
                                      <div className="build-day">
                                        {latestBuild ? (
                                          <BuildMark
                                            build={latestBuild}
                                            dayCount={dayBuilds.length}
                                          />
                                        ) : (
                                          <span className="build-no-data">No data</span>
                                        )}
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
