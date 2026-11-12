import type { ReactNode } from "react";
import { Link } from "react-router";
import { FilterReset, FilterScope } from "../FilterReset";
import { Tooltip, TooltipContent } from "../overview/Tooltip";
import { PlatformIcon } from "../PlatformIcon";
import type { Build, Fetcher, Session } from "../data";
import { buildDate, buildIdentity, calendarDays, exactBuildHref, qualificationBuildHref, READINESS_WINDOW_DAYS } from "../overview/buildTimeline";
import { useUtcToday } from "../overview/useUtcToday";
import {
  comparisonKey, metricValue, systemSummary,
} from "../performance/PerformanceView";
import type { PerformanceData } from "../performance/PerformanceView";
import { BuildPerformancePreview, findSelectedBuild } from "./BuildBrowser";
import { QualificationCharts } from "./QualificationCharts";
import { useBuildMeasurements } from "./useBuildMeasurements";
import { matchedPerformanceObservations } from "../performance/PerformancePreview";
import { QualificationMatrix } from "./QualificationMatrix";
import "./BuildViews.css";

const outcomes = {
  pass: "Qualified", warn: "Qualified with warnings", fail: "Failed", unknown: "Evidence unavailable",
};
const platformName = (os: string) => os === "linux" ? "Linux" : os === "windows" ? "Windows" : os;
type Measurement = PerformanceData["measurements"][number];

function outcome(build: Build) {
  if (build.qualified === false) return "fail";
  if (build.qualified !== true) return "unknown";
  return build.overall === "warn" ? "warn" : "pass";
}

type ViewProps = { session: Session; history: Build[]; params: URLSearchParams; fetcher: Fetcher };

function packageLabel(build: Build) {
  return build.gfx_family ?? build.artifact ?? build.gfx_target ?? build.build_id;
}

function DayPerformance({ builds, performance }: {
  builds: Build[];
  performance: ReturnType<typeof useBuildMeasurements>;
}) {
  const systems = performance.data?.systems;
  const candidates = builds.flatMap((build) => (performance.matches.get(build) ?? []).flatMap((row) => {
    const key = systems && comparisonKey(row, systems);
    return key && row.metrics.tps_mean > 0 ? [{ build, row, key }] : [];
  })).sort((a, b) => Date.parse(b.row.measured_at) - Date.parse(a.row.measured_at));
  const reference = candidates[0];
  const matched = new Map<Build, Measurement>();
  for (const { build, row, key } of candidates) {
    if (key === reference?.key && !matched.has(build)) matched.set(build, row);
  }
  const max = Math.max(0, ...[...matched.values()].map((row) => row.metrics.tps_mean));
  return <section className="build-day-performance" aria-labelledby="day-performance">
    <h2 id="day-performance">Reference-model performance</h2>
    {reference && systems ? <>
      <p className="muted">{[reference.row.model, reference.row.scenario, reference.row.quant,
        `${reference.row.context_size} context tokens`, `${reference.row.input_tokens} input tokens`,
        systemSummary(reference.row, systems)].join(" · ")}</p>
      <ul>{[...matched].map(([build, row]) => <li key={buildIdentity(build)}>
        <Link to={exactBuildHref(build, "build-performance")}>{build.tag ?? build.build_id} · {packageLabel(build)}</Link>
        <span>Throughput {metricValue("tps_mean", row.metrics.tps_mean)}</span>
        <meter min={0} max={max} value={row.metrics.tps_mean} aria-label="Throughput relative to the fastest package in this comparison" />
        <span>First token {row.metrics.ttft_ms_mean == null ? "Unavailable" : metricValue("ttft_ms_mean", row.metrics.ttft_ms_mean)}</span>
        <span>Peak VRAM {row.metrics.vram_peak_gb == null ? "Unavailable" : metricValue("vram_peak_gb", row.metrics.vram_peak_gb)}</span>
        <time dateTime={row.measured_at}>{row.measured_at.slice(0, 10)} UTC</time>
      </li>)}</ul>
      {matched.size < builds.length && <p className="muted">{builds.length - matched.size} packages have no verified measurement for this comparison.</p>}
    </> : <p className="muted">{performance.message.startsWith("Loading") || performance.retry
      ? performance.message
      : builds.some((build) => build.channel === "nightly")
        ? "Nightly benchmark coverage is unavailable."
        : "No verified package matches for a comparable benchmark in this release scope."}</p>}
    {performance.retry && <button onClick={performance.retry}>Retry performance</button>}
  </section>;
}

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
          disabled={!available.includes(value) || selected === value || (selected === null && available.length === 1)}
          onClick={() => onSelect(selected === null ? options[1 - index][0] : null)}
        >
          <PlatformIcon platform={value} />{name}
        </button>
      ))}
    </fieldset>
  );
}

export function EngineBuilds({ session, history, params, fetcher, onNavigate, versionFilter }: ViewProps & {
  versionFilter: ReactNode;
  onNavigate: (params: URLSearchParams, replace?: boolean) => void;
}) {
  const today = useUtcToday();
  const performance = useBuildMeasurements(session, history, fetcher);
  const platformParam = params.get("platform");
  const query = params.get("build_filter") ?? "";
  const measuredOnly = params.get("performance") === "measured";
  const focus = params.get("day");
  const channel = params.get("channel");
  const selectedBuild = params.get("build");
  const tier = params.get("tier");
  const check = params.get("check");
  const source = params.get("source");
  const packageIdentity = params.get("package_identity");
  const engineId = params.get("engine");
  const scopedBuilds = history.filter((build) => !engineId || build.engine === engineId);
  const availablePlatforms = (["linux", "windows"] as const).filter((value) =>
    scopedBuilds.some((build) => build.os === value),
  );
  const selectedPlatform = platformParam === "linux" || platformParam === "windows" ? platformParam : null;
  const visiblePlatforms = (["windows", "linux"] as const).filter((os) =>
    availablePlatforms.includes(os) && (selectedPlatform === null || os === selectedPlatform),
  );
  const filtered = scopedBuilds.filter((build) =>
    (!measuredOnly || matchedPerformanceObservations([build], performance.matches).length > 0) &&
    (selectedPlatform === null || build.os === selectedPlatform) &&
    (!query || [build.build_id, build.tag, build.artifact, build.gfx_family, build.source_id].join(" ").toLowerCase().includes(query.toLowerCase())),
  );
  const selectedCandidates = selectedBuild ? scopedBuilds.filter((build) =>
    build.build_id === selectedBuild && (!source || build.source_id === source) &&
    (!packageIdentity || buildIdentity(build) === packageIdentity) &&
    (!channel || build.channel === channel) && (!platformParam || platformParam === "all" || build.os === platformParam) &&
    (!focus || buildDate(build) === focus),
  ) : [];
  const selected = selectedCandidates.length === 1 ? selectedCandidates[0] : null;
  const focusedDay = focus ?? (selected && params.get("focus") !== "package" ? buildDate(selected) : null);
  const latestDays = calendarDays(new Date(today));
  const windowEnd = params.get("through") ?? (focusedDay && focusedDay < latestDays[0] ? focusedDay : null);
  const parsed = windowEnd && /^\d{4}-\d{2}-\d{2}$/.test(windowEnd) ? new Date(windowEnd) : null;
  const end = parsed && Number.isFinite(+parsed) && parsed.toISOString().slice(0, 10) === windowEnd
    && windowEnd < today ? windowEnd : today;
  const days = end === today ? latestDays : calendarDays(new Date(end));
  const dates = [...new Set(filtered.map(buildDate))].sort();
  const older = dates.findLast((day) => day < days[0]);
  const newer = dates.find((day) => day > end && day <= today);
  const newerEnd = newer ? new Date(+new Date(newer) + (READINESS_WINDOW_DAYS - 1) * 86_400_000).toISOString().slice(0, 10) : null;
  const nextWindow = newerEnd && newerEnd < today ? newerEnd : null;
  const stable = session.index.readiness?.stable_anchor;
  const trendTrack = stable && session.version
    ? session.version.localeCompare(stable, "en", { numeric: true }) > 0 ? "nightly" : "stable"
    : history[0]?.channel ?? "stable";
  const trendBuilds = filtered.filter((build) => days.includes(buildDate(build)));
  const rows = focusedDay ? filtered.filter((build) =>
    buildDate(build) === focusedDay && (!channel || build.channel === channel),
  ) : trendBuilds;

  function next(changes: Record<string, string | null>) {
    const target = new URLSearchParams(params);
    target.set("view", "engine");
    for (const [key, value] of Object.entries(changes)) {
      if (value === null) target.delete(key);
      else target.set(key, value);
    }
    return target;
  }

  function windowLink(through: string | null) {
    return `?${next({ through, focus: null, day: null, channel: null, build: null, source: null, package_identity: null })}`;
  }

  return <section className="build-charts" aria-label="Build qualification history">
    <div className="build-browser-toolbar build-filters">
      {versionFilter}
      <BuildFilter
        label="Platforms"
        options={[["linux", "Linux"], ["windows", "Windows"]]}
        available={availablePlatforms}
        selected={selectedPlatform}
        onSelect={(value) => onNavigate(next({ platform: value, build: null, source: null, package_identity: null }))}
      />
      <fieldset className="build-filter-options">
        <legend>Performance</legend>
        <Tooltip label="Measured" triggerClassName="filter-tooltip-trigger"
          buttonProps={{ "aria-pressed": measuredOnly,
            onClick: () => onNavigate(next({ performance: measuredOnly ? null : "measured", build: null, source: null, package_identity: null })) }}
          content={<TooltipContent heading="Measured builds"><span>Show only builds with matching recorded performance measurements. This filters measurement availability, not qualification results or performance quality.</span></TooltipContent>}>
          Measured
        </Tooltip>
      </fieldset>
      <label className="build-search">Find build <input type="search" value={query} placeholder="Package tag or build ID"
        onChange={(event) => onNavigate(next({ build_filter: event.target.value || null, build: null, source: null, package_identity: null }), true)} /></label>
      {selectedBuild && <FilterScope label={`Build: ${selected?.tag ?? selectedBuild}`} onClear={() => onNavigate(next({ through: end === today ? null : end, build: null, source: null, package_identity: null, tier: null, check: null, focus: null }))} />}
      {focusedDay && <FilterScope label={`Date: ${focusedDay}`} onClear={() => onNavigate(next({ through: end === today ? null : end, day: null, focus: null, build: null, source: null, package_identity: null }))} />}
      <FilterReset onReset={() => {
        const target = next({ through: end === today ? null : end });
        for (const key of ["platform", "engine", "channel", "performance", "build_filter", "day", "focus", "build", "source", "package_identity", "tier", "check", "report_commit"])
          target.delete(key);
        onNavigate(target);
      }} />
    </div>
    <QualificationCharts platforms={visiblePlatforms} builds={trendBuilds} track={trendTrack} days={days} today={today} focusedDay={focusedDay ?? undefined}
      dayHref={(day, track, os) => `?${next({ day, channel: track, platform: os, focus: "day", build: null, source: null, package_identity: null })}`} />
    {(older || end < today) && <nav className="build-chart-paging" aria-label="Browse qualification dates">
      {older && <Link to={windowLink(older)}>← Older builds</Link>}
      {end < today && <Link to={windowLink(nextWindow)}>{nextWindow ? "Newer builds →" : "Back to latest dates →"}</Link>}
    </nav>}
    {selectedBuild && !selected && <p role="status">The selected package is unavailable or its identity is ambiguous.</p>}
    {rows.length === 0 ? <div>
      <p role="status">{measuredOnly && performance.message ? performance.message : "No retained packages match this scope."}</p>
      {measuredOnly && performance.retry && <button type="button" onClick={performance.retry}>Retry performance</button>}
    </div> : <QualificationMatrix
      builds={rows}
      fetcher={fetcher}
      selected={selected && rows.includes(selected) ? selected : null}
      openPackage={params.get("view") === "build" && !check}
      checkLink={tier && check ? { tier, check, revision: params.get("report_commit") } : undefined}
      dataCommit={session.pointer.data_commit}
      performanceMeasurements={performance.matches}
    />}
    {focusedDay && rows.length > 0 &&
      <DayPerformance builds={rows} performance={performance} />}
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
  return <section className="build-charts">
    <div><h2 aria-label={build.tag ?? build.build_id}>{build.tag ?? build.build_id}{rows.length > 0 && <BuildPerformancePreview build={build} measurements={performance.matches} />}</h2><p className="muted">{platformName(build.os)} · {build.channel} · {buildDate(build)} UTC</p>
      <Link to={qualificationBuildHref(build)}>View package qualification</Link></div>
    <div className="build-review-panels">
      <CheckBars build={build} />
      <PerformanceSummary rows={rows} build={build} performance={performance} />
    </div>
  </section>;
}
