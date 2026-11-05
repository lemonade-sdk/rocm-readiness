import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import type { Build, Fetcher, Session } from "../data";
import { buildDate, buildIdentity, calendarDays, calendarMonthGroups, exactBuildHref, isCalendarMonthBoundary } from "../overview/buildTimeline";
import { BuildOutcomeIcon } from "../overview/BuildOutcomeIcon";
import { Tooltip } from "../overview/Tooltip";
import {
  comparisonKey, findExactQualificationBuild, MeasurementDetail,
  metricValue, readPerformance, stableMeasurements,
} from "../performance/PerformanceView";
import type { PerformanceData } from "../performance/PerformanceView";
import { findSelectedBuild } from "./BuildBrowser";
import "./BuildViews.css";

const outcomes = {
  pass: "Qualified", warn: "Qualified with warnings", fail: "Failed", unknown: "Evidence unavailable",
};
function OutcomeMark({ status }: { status: keyof typeof outcomes }) {
  return <span className={status === "unknown" ? "build-evidence-missing" : `build-mark ${status}`}>
    <BuildOutcomeIcon outcome={status === "unknown" ? null : status} />
  </span>;
}

const platformName = (os: string) => os === "linux" ? "Linux" : os === "windows" ? "Windows" : os;
type Measurement = PerformanceData["measurements"][number];

function outcome(build: Build) {
  if (build.qualified === false) return "fail";
  if (build.qualified !== true) return "unknown";
  return build.overall === "warn" ? "warn" : "pass";
}

function useBuildMeasurements(session: Session, history: Build[], fetcher: Fetcher) {
  const [result, setResult] = useState<{ session: Session; data?: PerformanceData; error?: true }>();
  const [retry, setRetry] = useState(0);
  const available = session.overview?.performance.status === "available" && Boolean(session.overview.performance.path);
  useEffect(() => {
    if (!available) return;
    const controller = new AbortController();
    readPerformance(session, controller.signal, fetcher).then(
      (data) => { if (!controller.signal.aborted) setResult({ session, data }); },
      () => { if (!controller.signal.aborted) setResult({ session, error: true }); },
    );
    return () => controller.abort();
  }, [session, available, fetcher, retry]);

  const data = result?.session === session ? result.data : undefined;
  const matches = useMemo(() => {
    const byId = new Map<string, Build[]>();
    for (const build of history) {
      const candidates = byId.get(build.build_id) ?? [];
      candidates.push(build);
      byId.set(build.build_id, candidates);
    }
    const matched = new Map<Build, Measurement[]>();
    for (const row of data ? stableMeasurements(data) : []) {
      const build = findExactQualificationBuild(row, byId.get(row.qualification_build_id ?? "") ?? []);
      if (!build) continue;
      const rows = matched.get(build) ?? [];
      rows.push(row);
      matched.set(build, rows);
    }
    return matched;
  }, [data, history]);

  const message = !available ? "No matched benchmarks"
    : result?.session !== session ? "Loading model performance…"
    : result.error ? "Model performance unavailable" : "";
  return {
    data, matches, message, retry: result?.session === session && result.error ? () => {
      setResult(undefined);
      setRetry((value) => value + 1);
    } : undefined,
  };
}

type ViewProps = { session: Session; history: Build[]; params: URLSearchParams; fetcher: Fetcher };

function BuildFilter({ label, options, available, selected, onSelect }: {
  label: string;
  options: [[string, string], [string, string]];
  available: readonly string[];
  selected: string | null;
  onSelect: (value: string | null) => void;
}) {
  return (
    <fieldset className="build-filter-options">
      <legend>{label}</legend>
      {options.map(([value, name], index) => (
        <button
          key={value}
          type="button"
          aria-pressed={available.includes(value) && (selected === null || selected === value)}
          disabled={!available.includes(value) || selected === value || available.length === 1}
          onClick={() => onSelect(selected === null ? options[1 - index][0] : null)}
        >
          {name}
        </button>
      ))}
    </fieldset>
  );
}

export function EngineBuilds({ session, history, params, fetcher, onNavigate, versionFilter }: ViewProps & {
  versionFilter: ReactNode;
  onNavigate: (params: URLSearchParams, replace?: boolean) => void;
}) {
  const charts = useRef<HTMLElement>(null);
  const [inspected, setInspected] = useState<{ scope: string; build: Build }>();
  const scope = params.toString();
  const platformParam = params.get("platform");
  const query = params.get("build_filter") ?? "";
  const focus = params.get("day");
  const selectedBuild = params.get("build");
  const source = params.get("source");
  const engineId = params.get("engine");
  const scopedBuilds = history.filter((build) => !engineId || build.engine === engineId);
  const availablePlatforms = (["linux", "windows"] as const).filter((value) =>
    scopedBuilds.some((build) => build.os === value),
  );
  const selectedPlatform = availablePlatforms.find((value) => value === platformParam) ?? null;
  const performance = useBuildMeasurements(session, history, fetcher);
  function next(changes: Record<string, string | null>) {
    const target = new URLSearchParams(params);
    target.set("view", "engine");
    target.delete("channel");
    if (session.version) target.set("version", session.version);
    for (const [key, value] of Object.entries(changes)) {
      if (value === null) target.delete(key);
      else target.set(key, value);
    }
    return target;
  }
  function buildHref(build: Build) {
    const target = new URLSearchParams(exactBuildHref(build).slice(1));
    if (query) target.set("build_filter", query);
    return `?${target}`;
  }
  const rows = scopedBuilds.filter((build) =>
    (selectedPlatform === null || build.os === selectedPlatform) &&
    (!selectedBuild || (build.build_id === selectedBuild && (!source || source === build.source_id))) &&
    (!query || [build.build_id, build.tag, build.artifact, build.source_id].join(" ").toLowerCase().includes(query.toLowerCase()))
  );
  const dates = [...new Set(rows.map(buildDate))].sort();
  const windowEnd = params.get("through") ?? focus;
  const parsed = windowEnd && /^\d{4}-\d{2}-\d{2}$/.test(windowEnd) ? new Date(windowEnd) : null;
  const end = parsed && Number.isFinite(+parsed) && parsed.toISOString().slice(0, 10) === windowEnd
    ? parsed : dates.length ? new Date(dates[dates.length - 1]) : null;
  const days = end ? calendarDays(end) : [];
  const months = calendarMonthGroups(days);
  const older = dates.findLast((day) => day < days[0]);
  const newer = dates.find((day) => day > days[days.length - 1]);
  const newerEnd = newer ? new Date(Math.min(+new Date(dates[dates.length - 1]), +new Date(newer) + 13 * 86_400_000)).toISOString().slice(0, 10) : null;
  const byTrack = new Map<string, { engine: string; os: string; channel: Build["channel"]; days: Map<string, Build[]> }>();
  for (const build of rows) {
    const key = JSON.stringify([build.engine, build.channel, build.os]);
    const track = byTrack.get(key) ?? { engine: build.engine, os: build.os, channel: build.channel, days: new Map<string, Build[]>() };
    const date = buildDate(build);
    const builds = track.days.get(date) ?? [];
    builds.push(build);
    track.days.set(date, builds);
    byTrack.set(key, track);
  }

  useEffect(() => {
    for (const chart of charts.current?.querySelectorAll<HTMLElement>(".build-chart-scroll") ?? []) {
      chart.scrollLeft = chart.scrollWidth;
    }
  }, [session, windowEnd, platformParam, engineId, query]);

  const active = inspected?.scope === scope && rows.includes(inspected.build) ? inspected.build : null;
  return <section ref={charts} className="build-charts" aria-label="Engine build history">
    <div className="build-browser-toolbar build-filters">
      {versionFilter}
      <BuildFilter
        label="Platforms"
        options={[["linux", "Linux"], ["windows", "Windows"]]}
        available={availablePlatforms}
        selected={selectedPlatform}
        onSelect={(value) => onNavigate(next({ platform: value }))}
      />
      <label className="build-search">Find build <input type="search" value={query} placeholder="Package tag or build ID"
        onChange={(event) => onNavigate(next({ build_filter: event.target.value || null, through: null, day: null }), true)} /></label>
    </div>
    {selectedBuild && <Link to={`?${next({ build: null, source: null, platform: null, day: null, through: null })}`}>Show all engine builds</Link>}
    {performance.retry && <p className="muted">{performance.message} <button onClick={performance.retry}>Retry</button></p>}
    {(older || newerEnd) && <nav className="build-chart-paging" aria-label="Browse build dates">
      {older && <Link to={`?${next({ through: older, day: null })}`}>← Older builds</Link>}
      {newerEnd && <Link to={`?${next({ through: newerEnd, day: null })}`}>Newer builds →</Link>}
    </nav>}
    {rows.length === 0 ? <p role="status">No retained builds match these filters.</p> :
      !rows.some((build) => days.includes(buildDate(build))) && <p role="status">No retained builds in this date range.</p>}
    {active && <div className="build-chart-selection" aria-live="polite">
      <strong>{active.tag ?? active.build_id}</strong> · {outcomes[outcome(active)]} · {buildDate(active)} UTC
      <Link to={buildHref(active)}>Open build review</Link>
    </div>}
    {(["stable", "nightly"] as const).flatMap((trackChannel) => [...byTrack.values()].filter((track) => track.channel === trackChannel).map((track) => {
      const engine = session.overview?.engines.find((item) => item.id === track.engine)?.label ?? track.engine;
      return <section className="build-chart-track" key={JSON.stringify([track.engine, track.channel, track.os])}>
        <div className="data-table-heading">
          <h2 className="data-table-title">{engine}</h2>
          <span>{track.channel === "stable" ? "Stable" : "Nightly"} · {platformName(track.os)}</span>
        </div>
        <div className="calendar-surface build-chart-scroll" role="region" tabIndex={0} aria-label={`${engine} ${track.channel} ${platformName(track.os)} calendar`}>
          <div className="build-chart-days">
            {months.map((month, index) => (
              <div
                key={month.key}
                className={index ? "build-chart-month month-boundary" : "build-chart-month"}
                style={{ gridColumn: `span ${month.days}` }}
              >
                {month.label}
              </div>
            ))}
            {days.map((day, index) => <div key={day} className={isCalendarMonthBoundary(days, index) ? "build-chart-day month-boundary" : "build-chart-day"} data-focused={day === focus || undefined}
              role="group" aria-label={`${day} UTC, ${track.days.get(day)?.length ?? 0} builds`}>
              <time dateTime={day}>{Number(day.slice(8))}</time>
              <div className="build-chart-stack">
                {[...(track.days.get(day) ?? [])].sort((a, b) => Date.parse(b.generated_at) - Date.parse(a.generated_at) ||
                  buildIdentity(a).localeCompare(buildIdentity(b))).map((build) => {
                  const status = outcome(build);
                  const observations = performance.matches.get(build);
                  const count = observations?.length ?? 0;
                  const latest = observations?.reduce<Measurement | undefined>((prior, row) =>
                    !prior || Date.parse(row.measured_at) > Date.parse(prior.measured_at) ? row : prior, undefined);
                  const label = `Open build ${build.build_id} · ${build.tag ?? build.build_id} · ${outcomes[status]}`;
                  return <Tooltip key={buildIdentity(build)} to={buildHref(build)} label={label}
                    triggerClassName="build-chart-mark"
                    onLinkClick={(event) => {
                      if (event.detail > 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey &&
                        !event.altKey && window.matchMedia("(hover: none) and (pointer: coarse)").matches) {
                        event.preventDefault();
                        setInspected({ scope, build });
                      }
                    }}
                    content={<><strong>{build.tag ?? build.build_id}</strong><span>{outcomes[status]}</span>
                      {latest && <span>{latest.model} · {latest.scenario}{latest.metrics.tps_mean != null && ` · ${metricValue("tps_mean", latest.metrics.tps_mean)}`}</span>}
                      <small>{count ? `${count} matched model measurement${count === 1 ? "" : "s"}` : performance.message || "No matched benchmarks"}</small></>}>
                    <OutcomeMark status={status} />{count > 0 && <span className="build-chart-bench" aria-hidden="true">•</span>}
                  </Tooltip>;
                })}
              </div>
            </div>)}
          </div>
        </div>
        <div className="build-chart-legend calendar-legend" role="group" aria-label="Build status legend">
          {(["pass", "warn", "fail", "unknown"] as const).map((status) => <span key={status}><OutcomeMark status={status} />{outcomes[status]}</span>)}
          {days.some((day) => track.days.get(day)?.some((build) => performance.matches.has(build))) &&
            <span>• Matched model benchmark</span>}
        </div>
      </section>;
    }))}
  </section>;
}

function CheckBars({ build }: { build: Build }) {
  const counts = build.tests;
  const parts = counts ? [
    ["Passed", counts.passed ?? 0, "pass"], ["Failed", counts.failed ?? 0, "fail"],
    ["Warned", counts.warned ?? 0, "warn"], ["Skipped", counts.skipped ?? 0, "unknown"], ["Missing", counts.missing ?? 0, "unknown"],
  ] as const : [];
  return <section className="card build-review-panel">
    <h2>Qualification</h2>
    <p><i className={`build-tick ${outcome(build)}`} aria-hidden="true" /> {outcomes[outcome(build)]}</p>
    {parts.some(([, count]) => count > 0) ? <>
      <div className="build-review-bar" aria-hidden="true">{parts.filter(([, count]) => count > 0).map(([label, count, status]) =>
        <i key={label} className={`build-tick ${status}`} style={{ flexGrow: count }} />)}</div>
      <div className="build-chart-legend">{parts.filter(([, count]) => count > 0).map(([label, count]) => <span key={label}>{count} {label.toLowerCase()}</span>)}</div>
    </> : <p className="muted">Individual check counts unavailable</p>}
    <dl>
      <dt>Build job</dt><dd>{build.build_result ?? "Unavailable"}</dd>
      <dt>Publication</dt><dd>{build.published == null ? "Unavailable" : build.published ? "Shipped" : "Did not ship"}</dd>
      <dt>Hardware validation</dt><dd>{build.hardware_validated == null ? "Unavailable" : build.hardware_validated ? "Recorded" : "Not recorded"}</dd>
    </dl>
    <Link to={exactBuildHref(build, "build")}>Build evidence</Link>
  </section>;
}

function PerformanceSummary({ rows, build, performance }: {
  rows: Measurement[]; build: Build; performance: ReturnType<typeof useBuildMeasurements>;
}) {
  const systems = performance.data?.systems;
  const latest = new Map<string, Measurement>();
  const byRecency = [...rows].sort((a, b) => Date.parse(b.measured_at) - Date.parse(a.measured_at));
  for (const [index, row] of byRecency.entries()) {
    const key = (systems && comparisonKey(row, systems)) ?? `observation-${index}`;
    if (!latest.has(key)) latest.set(key, row);
  }
  return <section className="card build-review-panel">
    <h2>Model performance</h2>
    {rows.length === 0 ? <p>{performance.message || "No matched benchmarks for this build"}</p> :
      [...latest].slice(0, 5).map(([key, row]) => {
        const cohort = systems && comparisonKey(row, systems);
        let baseline: { build: Build; row: Measurement } | undefined;
        if (cohort && systems) for (const [candidate, observations] of performance.matches) {
          if (Date.parse(candidate.generated_at) >= Date.parse(build.generated_at)) continue;
          for (const other of observations) {
            if (Date.parse(other.measured_at) >= Date.parse(row.measured_at) || comparisonKey(other, systems) !== cohort) continue;
            if (!baseline || Date.parse(candidate.generated_at) > Date.parse(baseline.build.generated_at) ||
              (candidate === baseline.build && Date.parse(other.measured_at) > Date.parse(baseline.row.measured_at))) {
              baseline = { build: candidate, row: other };
            }
          }
        }
        return <div key={key} className="build-review-cohort">
          <strong>{row.model}</strong><p className="muted">{[row.scenario, row.quant, row.system_id].filter(Boolean).join(" · ")}</p>
          {(["tps_mean", "ttft_ms_mean"] as const).map((metric) => {
            const value = row.metrics[metric];
            const prior = baseline?.row.metrics[metric];
            if (value == null) return null;
            const change = prior != null && prior > 0 ? (value - prior) / prior * 100 : null;
            return <div key={metric} className="build-review-metric">
              <span>{metric === "tps_mean" ? "Throughput" : "First token"}</span><strong>{metricValue(metric, value)}</strong>
              {change !== null && <><div className="build-review-delta" aria-hidden="true"><i style={{
                width: `${Math.min(50, Math.abs(change) / 2)}%`,
                [change < 0 ? "right" : "left"]: "50%",
              }} /></div><small>{change > 0 ? "+" : ""}{change.toFixed(1)}% vs {baseline?.build.tag ?? baseline?.build.build_id}</small></>}
            </div>;
          })}
          {!baseline && <small className="muted">No earlier comparable build</small>}
        </div>;
      })}
    {latest.size > 5 && <p className="muted">Showing 5 of {latest.size} workloads</p>}
    {performance.retry && <button onClick={performance.retry}>Retry performance</button>}
    <Link to={exactBuildHref(build, "build-performance")}>Performance evidence</Link>
  </section>;
}

export function BuildReview({ session, history, params, fetcher }: ViewProps) {
  const engine = params.get("engine");
  const channel = params.get("channel");
  const candidates = history.filter((build) => (!engine || build.engine === engine) && (!channel || build.channel === channel));
  const selection = findSelectedBuild(candidates, params.get("build") ?? "", params.get("platform") ?? "all", params.get("source"));
  const performance = useBuildMeasurements(session, history, fetcher);
  if (selection?.kind !== "selected") return <p role="alert">{selection?.message ?? "Build unavailable"}</p>;
  const { build } = selection;
  const rows = performance.matches.get(build) ?? [];
  if (params.get("view") === "build-performance") return <section className="performance-view">
    <Link to={exactBuildHref(build)}>← Build review</Link>
    <h2>{build.tag ?? build.build_id}</h2>
    {rows.length === 0 && <p>{performance.message || "No matched benchmarks for this build"}</p>}
    {performance.retry && <button onClick={performance.retry}>Retry performance</button>}
    {rows.map((row, index) => <MeasurementDetail key={index} row={row} systems={performance.data!.systems}
      history={{ builds: history, error: null }} buildHref={() => exactBuildHref(build, "build")} />)}
  </section>;
  return <section className="build-charts">
    <div><h2>{build.tag ?? build.build_id}</h2><p className="muted">{platformName(build.os)} · {build.channel} · {buildDate(build)} UTC</p>
      <Link to={`?${new URLSearchParams({ view: "engine", version: build.rocm_version, engine: build.engine,
        channel: build.channel, platform: build.os, day: buildDate(build) })}`}>View this build in the calendar</Link></div>
    <div className="build-review-panels">
      <CheckBars build={build} />
      <PerformanceSummary rows={rows} build={build} performance={performance} />
    </div>
  </section>;
}
