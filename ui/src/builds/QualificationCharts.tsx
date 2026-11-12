import type { CSSProperties } from "react";
import { Tooltip, TooltipContent } from "../overview/Tooltip";
import { OutcomeLegend } from "../overview/OutcomeLegend";
import type { Build } from "../data";
import { buildDate, calendarMonthGroups, isCalendarMonthBoundary } from "../overview/buildTimeline";
import "./QualificationCharts.css";

const outcomes = [
  { id: "pass", label: "Qualified" },
  { id: "warn", label: "Qualified with warnings" },
  { id: "fail", label: "Failed qualification" },
  { id: "unknown", label: "Qualification unreported" },
] as const;

function outcome(build: Build) {
  if (build.qualified === false) return "fail";
  if (build.qualified !== true) return "unknown";
  return build.overall === "warn" ? "warn" : "pass";
}

type ChartProps = {
  builds: Build[];
  track: Build["channel"];
  days: readonly string[];
  platforms: readonly ("windows" | "linux")[];
  today?: string;
  focusedDay?: string;
  dayHref?: (day: string, channel: Build["channel"], os: "windows" | "linux") => string;
};

export function QualificationCharts({ builds, track, days, platforms, today, focusedDay, dayHref }: ChartProps) {
  const label = track === "stable" ? "Stable" : "Nightly";
  const bins = days.map((day) => ({
    day,
    groups: platforms.map((os) => ({ os, counts: { pass: 0, warn: 0, fail: 0, unknown: 0 }, total: 0 })),
  }));
  const months = calendarMonthGroups(days);
  const dates = new Map(days.map((day, index) => [day, index]));
  let scale = 1;
  for (const build of builds) {
    const index = dates.get(buildDate(build));
    if (index === undefined || build.channel !== track) continue;
    const bin = bins[index].groups.find(({ os }) => os === build.os);
    if (!bin) continue;
    bin.counts[outcome(build)]++;
    bin.total++;
    scale = Math.max(scale, bin.total);
  }

  return <section className="qualification-chart" aria-labelledby="qualification-trend">
    <h2 id="qualification-trend">Qualification trend</h2>

    <div className="qualification-trend-platform-grid" role="region" aria-label="Daily qualification charts">
      {platforms.map((os) => {
        const platform = os === "windows" ? "Windows" : "Linux";
        return <section className="qualification-platform-trend" key={os} aria-label={`${platform} qualification trend`}>
          <h3>{platform}</h3>
          <div className="qualification-trend-scroll calendar-surface" tabIndex={0} role="region" aria-label={`${platform} chart dates`}>
            <div className="qualification-trend-grid" style={{ "--qualification-days": days.length } as CSSProperties}>
              <figure className="qualification-trend">
              <div className="qualification-trend-axis" aria-hidden="true">
                <span>{scale}</span><span>0</span>
              </div>
              <ul className="qualification-trend-bars" aria-label={`${label} packages by day · ${platform}`}>
                {bins.map(({ day, groups }) => {
                  const { counts, total } = groups.find((group) => group.os === os)!;
                      const summary = `${day} UTC · ${total} packages${total ? ` · ${outcomes.map(({ id, label: name }) => `${counts[id]} ${name.toLowerCase()}`).join(" · ")}` : ""}`;
                      const to = total > 0 ? dayHref?.(day, track, os) : undefined;
                      const accessibleLabel = `${to ? `Show ${label} packages for ` : ""}${summary} · ${platform}`;
                  return (
                  <li key={day} aria-current={day === today ? "date" : undefined} data-focused={day === focusedDay || undefined}>
                    <Tooltip to={to} floating label={accessibleLabel}
                        content={<TooltipContent heading={`${platform} · ${day} UTC`} status={`${total} packages`}>
                          {total ? <dl>{outcomes.map(({ id, label }) => <div className="qualification-tooltip-count" key={id}><dt>{label}</dt><dd>{counts[id]}</dd></div>)}</dl>
                            : <span>No packages recorded</span>}
                        </TooltipContent>}>
                        <div className="qualification-trend-stack" aria-hidden="true">
                          {outcomes.map(({ id }) => counts[id] > 0 && <span key={id} className={`qualification-segment ${id}`}
                            style={{ height: `${100 * counts[id] / scale}%` }} />)}
                        </div>
                    </Tooltip>
                  </li>
                );})}
              </ul>
              <div className="qualification-trend-calendar" aria-hidden="true">
                {days.map((day, index) => <time key={day} dateTime={day} data-today={day === today || undefined}
                  className={isCalendarMonthBoundary(days, index) ? "month-boundary" : undefined}>{Number(day.slice(8))}</time>)}
                {months.map((month, index) => <span key={month.key}
                  className={index ? "qualification-month month-boundary" : "qualification-month"}
                  style={{ gridColumn: `span ${month.days}` }}>{month.label}</span>)}
              </div>
              </figure>
            </div>
          </div>
        </section>;
      })}
    </div>
    <OutcomeLegend label="Qualification outcomes" className="qualification-trend-legend"
      items={outcomes.map(({ id, label }) => ({ outcome: id === "unknown" ? "unreported" : id, label, mark: "bar" }))} />
  </section>;
}
