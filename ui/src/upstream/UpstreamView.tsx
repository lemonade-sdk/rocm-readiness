import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { PlatformIcon } from "../PlatformIcon";
import type { Fetcher, Session } from "../data";
import { Tooltip, TooltipContent } from "../overview/Tooltip";
import { BuildOutcomeIcon } from "../overview/BuildOutcomeIcon";
import { calendarMonthGroups, isCalendarMonthBoundary } from "../overview/buildTimeline";
import {
  CATEGORIES,
  cellState,
  loadRuns,
  loadUpstream,
  mergedRed,
  notRunning,
  rate,
  sumCells,
  windowDays,
} from "./data";
import type { Cell, Job, Project, Run, UpstreamOverview } from "./data";
import "../builds/BuildViews.css";
import "../builds/QualificationCharts.css";
import "./upstream.css";

const GH = "https://github.com/";
const BADGE_LABEL = {
  up: "upstream",
  partial: "partially upstream",
  down: "no configured test observed",
};
const VERDICT_LABEL = {
  passed: "ok",
  failed: "red",
  not_triggered: "no run",
  no_result: "no result",
};
const VERDICT_TEXT = {
  passed: "passed on the merged commit",
  failed: "was red on the merged commit",
  not_triggered: "never ran on the pull request",
  no_result: "had no result on the pull request",
};

type Props = {
  session: Session;
  fetcher: Fetcher;
  params: URLSearchParams;
  onNavigate: (next: URLSearchParams) => void;
};

function query(
  params: URLSearchParams,
  changes: Record<string, string | null>,
) {
  const next = new URLSearchParams(params);
  for (const [key, value] of Object.entries(changes)) {
    if (value === null) next.delete(key);
    else next.set(key, value);
  }
  return next;
}

export function UpstreamView({ session, fetcher, params, onNavigate }: Props) {
  const [state, setState] = useState<{
    session: Session;
    data: UpstreamOverview | null;
    error: string | null;
  } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setState(null);
    loadUpstream(session, fetcher, controller.signal)
      .then((data) => {
        if (!controller.signal.aborted)
          setState({ session, data, error: null });
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted)
          setState({
            session,
            data: null,
            error:
              reason instanceof Error
                ? reason.message
                : "Unable to load upstream health",
          });
      });
    return () => controller.abort();
  }, [session, fetcher]);

  if (!state || state.session !== session)
    return (
      <div className="empty" role="status">
        <h1>Loading upstream health…</h1>
      </div>
    );
  if (state.error)
    return (
      <div className="notice error" role="alert">
        <strong>Couldn’t load upstream health</strong>
        <p>{state.error}</p>
      </div>
    );
  if (!state.data)
    return (
      <div className="empty">
        <h1>No upstream health in this dataset</h1>
        <p>This dataset was published before the upstream view existed.</p>
      </div>
    );
  const data = state.data;
  const activity = params.get("view") === "ci" || (!params.has("view") && params.has("project"));
  const selected = data.projects.find((p) => p.id === params.get("project")) ??
    (!params.has("project") ? data.projects[0] : undefined);
  if (activity && params.get("project") && !selected)
    return (
      <div className="notice" role="alert">
        <h1>Unknown project</h1>
        <a href={`?${query(params, { view: "overview", project: null, lens: null })}`}>
          Back to all projects
        </a>
      </div>
    );
  return activity && selected ? (
      <ProjectPage
        key={selected.id}
        overview={data}
        project={selected}
        session={session}
        fetcher={fetcher}
        params={params}
        onNavigate={onNavigate}
      />
  ) : (
    <ProjectGrid overview={data} params={params} onNavigate={onNavigate} />
  );
}

/* ---- shared pieces ------------------------------------------------------------ */

function Badge({ project }: { project: Project }) {
  if (!project.jobs.length || !project.coverage.complete)
    return <span className="up-badge">Configured coverage unknown</span>;
  return (
    <span
      className={`up-badge up-badge-${project.badge.state}`}
      title={`Configured jobs: ${project.badge.reason}`}
    >
      {BADGE_LABEL[project.badge.state]}
    </span>
  );
}

function ProjectSources({ project }: { project: Project }) {
  return (
    <div className="up-sources" role="group" aria-label={`${project.label} source repositories`}>
      <ul className="up-source-list">
        <li><a aria-label={`Repository: ${project.repository}`} href={GH + project.repository} target="_blank" rel="noreferrer">{project.repository}</a><span className="muted">upstream</span></li>
        {project.forks.map((fork) => (
          <li key={fork.repository}>
            <a href={GH + fork.repository} target="_blank" rel="noreferrer">{fork.repository}</a>
            <span className="muted">{fork.role}{fork.channel ? ` · ${fork.channel}` : ""}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

const activityStates = {
  good: { glyph: "✓", label: "95–100% passed" },
  warn: { glyph: "△", label: "80–<95% passed" },
  bad: { glyph: "×", label: "Below 80% passed" },
  stall: { glyph: "□", label: "Requested, no runs" },
  skip: { glyph: "↷", label: "Skipped" },
  idle: { glyph: "–", label: "No collected evidence" },
  none: { glyph: "○", label: "No pass or fail result" },
} as const;

const activityOutcomes = { good: "pass", warn: "warn", bad: "fail", stall: "fail", skip: "skip", idle: "unreported", none: "not_applicable" } as const;

function ActivityMark({ state }: { state: keyof typeof activityStates }) {
  if (state === "good" || state === "warn" || state === "bad") {
    return <BuildOutcomeIcon outcome={state === "good" ? "pass" : state === "bad" ? "fail" : "warn"} />;
  }
  return <span className={`up-activity-symbol up-activity-${state}`} aria-hidden="true">{activityStates[state].glyph}</span>;
}

/** One outcome mark per day, with its counts available in the label. */
export function Ticks({
  days,
  cellOf,
  onPick,
  label,
}: {
  days: string[];
  cellOf: (day: string) => Cell | undefined;
  onPick?: (day: string) => void;
  label: string;
}) {
  return (
    <div className="up-ticks" role="group" aria-label={label}>
      {days.map((day) => {
        const cell = cellOf(day);
        const state = cellState(cell);
        const text = describe(day, cell);
        return onPick ? (
          <button
            key={day}
            type="button"
            className="up-tick table-status"
            data-outcome={activityOutcomes[state]}
            title={text}
            aria-label={text}
            onClick={() => onPick(day)}
          >
            <ActivityMark state={state} />
          </button>
        ) : (
          <span
            key={day}
            role="img"
            className="up-tick table-status"
            data-outcome={activityOutcomes[state]}
            title={text}
            aria-label={text}
          >
            <ActivityMark state={state} />
          </span>
        );
      })}
    </div>
  );
}

function describe(day: string, cell: Cell | undefined) {
  if (!cell) return `${day}: no collected evidence`;
  const ran = cell.passed + cell.failed + cell.other + cell.running;
  if (!ran)
    return cell.stalled
      ? `${day}: ${cell.stalled} requested, none ran`
      : cell.skipped
        ? `${day}: ${cell.skipped} skipped`
        : `${day}: no collected evidence`;
  return `${day}: ${cell.passed} passed, ${cell.failed} failed of ${ran} runs`;
}

/* ---- home: one card per project ------------------------------------------------ */

function ProjectGrid({
  overview,
  params,
  onNavigate,
}: {
  overview: UpstreamOverview;
  params: URLSearchParams;
  onNavigate: (next: URLSearchParams) => void;
}) {
  return (
    <section aria-label="Upstream projects" className="up-home">
      <div className="up-cards">
        {overview.projects.map((project) => {
          const r = rate(project.jobs);
          return (
            <article
              key={project.id}
              className="up-card"
            >
              <div className="up-card-head">
                <h2>
                <a
                  className="up-project-link"
                  href={`?${query(params, { view: "ci", project: project.id, lens: null, stack: null, target: null, platform: null, day: null, activity: null })}`}
                  onClick={(event) => {
                    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                    event.preventDefault();
                    onNavigate(query(params, { view: "ci", project: project.id, lens: null, stack: null, target: null, platform: null, day: null, activity: null }));
                  }}
                >
                  {project.label}
                </a>
                </h2>
                <Badge project={project} />
              </div>
              {project.jobs.length ? (
                <div className="up-kpis" role="group" aria-label="CI metrics">
                  <Stat
                    value={r.pct === null ? "–" : `${r.pct}%`}
                    label={`of ${r.decided} ${project.coverage.complete ? "results" : "collected results"} on main passed`}
                  />
                  <Stat
                    value={project.coverage.complete ? project.kpis.not_running : "Unknown"}
                    label="tests not running"
                    bad={project.coverage.complete && project.kpis.not_running > 0}
                  />
                  {project.jobs.some((j) => j.gate) && (
                    <Stat
                      value={project.kpis.merged_red}
                      label={project.coverage.complete ? "PRs merged red" : "observed PRs merged red"}
                      bad={project.kpis.merged_red > 0}
                    />
                  )}
                </div>
              ) : (
                <p className="muted">
                  No conclusion about upstream support can be drawn from the configured coverage.
                </p>
              )}
              {project.jobs.length > 0 && <ProjectActivity project={project} jobs={project.jobs} days={windowDays(overview, 14)} params={params} />}

            </article>
          );
        })}
      </div>
    </section>
  );
}

function ProjectActivity({ project, jobs, days, params, onPick, selected, renderDay }: {
  project: Project; jobs: Job[]; days: string[]; params: URLSearchParams;
  onPick?: (category: string, day: string) => void;
  selected?: { key: string; day: string } | null;
  renderDay?: (category: string, day: string) => ReactNode;
}) {
  const last14 = days;
  const months = calendarMonthGroups(last14);
  const totalRuns = (cell: Cell) => cell.passed + cell.failed + cell.running + cell.other;
  const scale = Math.max(1, ...CATEGORIES.flatMap((category) => {
    const group = jobs.filter((job) => job.category === category);
    return days.map((day) => totalRuns(sumCells(group, day)));
  }));
  return (
    <section className="up-detail-activity" aria-label="Daily CI activity">
    <div
      className="up-project-activity calendar-surface"
      role="region"
      aria-label={`${project.label} activity calendar`}
      tabIndex={0}
    >
      <table className={`up-activity-table${onPick ? " up-daily-detail" : ""}`} aria-label="Daily CI activity">
        <colgroup><col /></colgroup>
        {months.map((month) => <colgroup key={month.key} span={month.days} />)}
        <thead>
          <tr className="calendar-months">
            <th scope="col" rowSpan={2}>Category</th>
            {months.map((month, index) => (
              <th key={month.key} scope="colgroup" colSpan={month.days}
                className={index ? "month-boundary" : undefined}
                aria-label={`${month.label} ${month.key.slice(0, 4)}`}>
                {month.label}
              </th>
            ))}
          </tr>
          <tr>
            {last14.map((day, index) => (
              <th key={day} scope="col" aria-label={`${day} UTC`}
                className={isCalendarMonthBoundary(last14, index) ? "month-boundary" : undefined}>
                <time dateTime={day}>{Number(day.slice(8))}</time>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {CATEGORIES.map((category) => {
            const group = jobs.filter((job) => job.category === category);
            if (!group.length) return null;
            return (
              <tr key={category}>
                <th scope="row">{category}{onPick && <span className="up-daily-axis" aria-hidden="true"><span>{scale}</span><span>0</span></span>}</th>
                {last14.map((day, index) => {
                  const cell = sumCells(group, day);
                  const state = cellState(cell);
                  const text = describe(day, cell);
                  return (
                    <td key={day} data-outcome={activityOutcomes[state]} className={`${onPick ? "up-daily-cell" : "table-status"}${isCalendarMonthBoundary(last14, index) ? " month-boundary" : ""}`}>
                      {onPick ? (
                        <Tooltip interactive label={text} triggerClassName="up-daily-trigger"
                          contentClassName="up-run-tooltip"
                          isOpen={selected?.key === `cat:${category}` && selected.day === day}
                          onOpenChange={(next) => {
                            const active = selected?.key === `cat:${category}` && selected.day === day;
                            if (next !== active) onPick(category, day);
                          }}
                          content={renderDay?.(category, day)}>
                          <span className="qualification-trend-stack up-daily-chart" aria-hidden="true">
                            {cell.passed > 0 && <span className="qualification-segment pass up-pass" style={{ height: `${100 * cell.passed / scale}%` }} />}
                            {cell.failed > 0 && <span className="qualification-segment fail up-fail" style={{ height: `${100 * cell.failed / scale}%` }} />}
                            {cell.other + cell.running > 0 && <span className="qualification-segment unknown" style={{ height: `${100 * (cell.other + cell.running) / scale}%` }} />}
                            {!totalRuns(cell) && <span className="up-daily-special"><ActivityMark state={state} /></span>}
                          </span>
                        </Tooltip>
                      ) : (
                        <Tooltip floating label={text} triggerClassName="up-tick"
                          to={`?${query(params, { view: "ci", project: project.id, lens: null, stack: null, target: null, platform: null, day, activity: `cat:${category}` })}`}
                          content={<TooltipContent heading={day} status={activityStates[state].label}><span>{text}</span></TooltipContent>}>
                          <ActivityMark state={state} />
                        </Tooltip>
                      )}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
    {onPick ? <ul className="up-activity-key calendar-legend" aria-label="Daily CI activity legend">
      <li><span className="qualification-segment pass" />Passed</li>
      <li><span className="qualification-segment fail" />Failed</li>
      <li><span className="qualification-segment unknown" />Running / other</li>
      <li>□ Requested, no runs</li><li>↷ Skipped</li><li>– No collected evidence</li><li>○ No pass or fail result</li>
    </ul> : (
    <ul className="up-activity-key calendar-legend" aria-label="Daily CI activity legend">
      {(Object.keys(activityStates) as (keyof typeof activityStates)[]).map((state) => (
        <li key={state}>
          <span className="up-tick table-status" data-outcome={activityOutcomes[state]} aria-hidden="true"><ActivityMark state={state} /></span>
          {activityStates[state].label}
        </li>
      ))}
    </ul>
    )}
    </section>
  );
}

function CollectionFailure({ error }: { error: string }) {
  return (
    <div className="notice error" role="alert" onClick={(event) => event.stopPropagation()}>
      <p>Collection failed. The displayed results may be incomplete.</p>
      <details>
        <summary>Technical details</summary>
        <p>{error}</p>
      </details>
    </div>
  );
}

function Stat({
  value,
  label,
  bad = false,
}: {
  value: number | string;
  label: string;
  bad?: boolean;
}) {
  return (
    <div className={`up-stat${bad ? " bad" : ""}`}>
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

/* ---- project page ---------------------------------------------------------------- */

function ProjectPage({
  overview,
  project,
  session,
  fetcher,
  params,
  onNavigate,
}: {
  overview: UpstreamOverview;
  project: Project;
  session: Session;
  fetcher: Fetcher;
  params: URLSearchParams;
  onNavigate: (next: URLSearchParams) => void;
}) {
  const stacks = [...new Set(project.jobs.map((job) => job.stack))].sort();
  const targets = [...new Set(project.jobs.map((job) => job.target))].sort();
  // Legacy lens links still select their original stack or target.
  const lens = params.get("lens");
  const selection = (key: string, options: string[]) => {
    const requested = params.get(key)?.split(",") ?? (lens && options.includes(lens) ? [lens] : options);
    const valid = options.filter((value) => requested.includes(value));
    return valid.length ? valid : options;
  };
  const selectedStacks = selection("stack", stacks);
  const selectedTargets = selection("target", targets);
  const scopedJobs = project.jobs.filter((job) => selectedStacks.includes(job.stack) && selectedTargets.includes(job.target));
  const platforms = [...new Set(project.jobs.map((job) => job.os))];
  const requestedPlatform = params.get("platform");
  const platform = requestedPlatform && platforms.includes(requestedPlatform as "linux" | "windows") ? requestedPlatform : null;
  const jobs = scopedJobs.filter((job) => platform === null || job.os === platform);
  const days14 = windowDays(overview, 14);
  const allDays = windowDays(overview);
  const [runs, setRuns] = useState<{
    rows: Run[] | null;
    error: string | null;
  }>({ rows: null, error: null });
  const selectedDay = params.get("day");
  const open = selectedDay && allDays.includes(selectedDay)
    ? { key: params.get("activity") ?? "all", day: selectedDay, jobs: [] as string[] }
    : null;
  const setOpen = (next: { key: string; day: string; jobs: string[] } | null) =>
    onNavigate(query(params, { day: next?.day ?? null, activity: next?.key ?? null }));
  const r = rate(jobs);
  const red = mergedRed(jobs);
  const quiet = jobs.filter(notRunning).length;
  const findings = project.coverage.complete ? project.findings : project.findings.filter((f) => !["not_running", "never_ran"].includes(f.kind));

  useEffect(() => {
    const controller = new AbortController();
    setRuns({ rows: null, error: null });
    loadRuns(session, project, fetcher, controller.signal)
      .then(
        (rows) => !controller.signal.aborted && setRuns({ rows, error: null }),
      )
      .catch((reason: unknown) => {
        if (!controller.signal.aborted)
          setRuns({
            rows: null,
            error:
              reason instanceof Error ? reason.message : "Unable to load runs",
          });
      });
    return () => controller.abort();
  }, [session, project, fetcher]);

  const steps = useMemo(() => {
    const totals: Record<string, { n: number; jobs: Map<string, string> }> = {};
    for (const job of jobs)
      for (const [step, n] of Object.entries(job.failed_steps)) {
        totals[step] ??= { n: 0, jobs: new Map() };
        totals[step].n += n;
        totals[step].jobs.set(job.id, job.label);
      }
    return Object.entries(totals)
      .sort((a, b) => b[1].n - a[1].n)
      .slice(0, 6);
  }, [jobs]);

  const toggle = (key: "stack" | "target", value: string) => {
    const current = key === "stack" ? selectedStacks : selectedTargets;
    const options = key === "stack" ? stacks : targets;
    const next = current.includes(value) ? current.filter((item) => item !== value) : [...current, value];
    if (!next.length) return;
    onNavigate(query(params, {
      lens: null,
      stack: selectedStacks.length === stacks.length ? null : selectedStacks.join(","),
      target: selectedTargets.length === targets.length ? null : selectedTargets.join(","),
      [key]: next.length === options.length ? null : next.join(","),
    }));
  };
  const pick = (key: string, day: string, ids: string[]) =>
    setOpen(
      open && open.key === key && open.day === day
        ? null
        : { key, day, jobs: ids },
    );

  return (
    <section
      aria-label={`${project.label} upstream health`}
      className="up-page"
    >
      <div className="up-project-summary">
      <header className="up-project-header">
        <div className="up-page-head">
          <h2>{project.label}</h2>
          <Badge project={project} />
        </div>
        {!project.coverage.complete && !project.coverage.error && (
          <p className="up-collection-status" role="status"><span aria-hidden="true">△</span> Collection incomplete <span className="muted">· oldest days may be missing</span></p>
        )}
      </header>
      <div className="up-kpis up-kpis-page">
        <Stat
          value={r.pct === null ? "–" : `${r.pct}%`}
          label={`of ${r.decided} ${project.coverage.complete ? "results" : "collected results"} on main passed`}
        />
        <Stat value={project.coverage.complete ? quiet : "Unknown"} label="tests not running" bad={project.coverage.complete && quiet > 0} />
        {project.jobs.some((j) => j.gate) && (
          <Stat value={red} label={project.coverage.complete ? "PRs merged red" : "observed PRs merged red"} bad={red > 0} />
        )}
      </div>
      </div>
      <div className="build-browser-toolbar build-filters" role="group" aria-label="Filter">
        <fieldset className="build-filter-options">
          <legend>Project</legend>
          {overview.projects.map((item) => (
            <button key={item.id} type="button" aria-pressed={project.id === item.id}
              onClick={() => onNavigate(query(params, { view: "ci", project: item.id, lens: null, stack: null, target: null, platform: null, day: null, activity: null }))}>
              {item.label}
            </button>
          ))}
        </fieldset>
        <fieldset className="build-filter-options">
          <legend>Platform</legend>
          {(["linux", "windows"] as const).map((os) => {
            const available = platforms.includes(os);
            return <button key={os} type="button" aria-pressed={available && (platform === null || platform === os)}
              disabled={!available || platform === os || platforms.length === 1}
              onClick={() => onNavigate(query(params, { platform: platform === null ? (os === "linux" ? "windows" : "linux") : null }))}>
              {os === "linux" ? "Linux" : "Windows"}
            </button>;
          })}
        </fieldset>
        {([{ key: "stack", label: "Stack", options: stacks, selected: selectedStacks },
          { key: "target", label: "Target", options: targets, selected: selectedTargets }] as const).map((group) => (
          <fieldset key={group.key} className="build-filter-options">
            <legend>{group.label}</legend>
            {group.options.map((value) => <button key={value} type="button"
              aria-pressed={group.selected.includes(value)}
              disabled={group.selected.length === 1 && group.selected.includes(value)}
              onClick={() => toggle(group.key, value)}>{value}</button>)}
          </fieldset>
        ))}
        <span className="muted up-filter-sum">{jobs.length} {jobs.length === 1 ? "job" : "jobs"}{r.pct !== null ? ` · ${r.pct}% of ${r.decided} passed` : ""}</span>
      </div>
      {open?.key === "all" && <div className="up-selected-day">Selected day: <strong><time dateTime={open.day}>{open.day}</time> UTC</strong></div>}
      {open?.key === "all" && <DayPanel project={project} jobs={jobs} day={open.day} days={allDays} runs={runs}
        onDay={(day) => setOpen({ ...open, day })} onClose={() => setOpen(null)} />}
      {project.coverage.error && <CollectionFailure error={project.coverage.error} />}
      <div className="up-cols">
        <div className="up-activity-analysis">
          <section className="up-panel" aria-label="Daily activity">
            <h2>Daily activity <span className="muted">main only · last 14 days · UTC</span></h2>
            {jobs.length === 0 ? <p className="muted">No configured jobs match these filters.</p> : !jobs.some((job) => days14.some((day) => job.daily[day])) && <p className="muted">No collected runs on the default branch in the last 14 days.</p>}
            <ProjectActivity project={project} jobs={jobs} days={days14} params={params}
              selected={open} onPick={(category, day) => pick(`cat:${category}`, day, [])}
              renderDay={(category, day) => <DayPanel project={project}
                jobs={jobs.filter((job) => job.category === category)} day={day}
                days={days14} runs={runs} onDay={(next) => setOpen({ key: `cat:${category}`, day: next, jobs: [] })}
                onClose={() => setOpen(null)} />} />
            {open?.key.startsWith("cat:") &&
              (!days14.includes(open.day) || !jobs.some((job) => `cat:${job.category}` === open.key)) && (
              <DayPanel project={project} jobs={jobs.filter((job) => `cat:${job.category}` === open.key)}
                day={open.day} days={allDays} runs={runs}
                onDay={(day) => setOpen({ ...open, day })} onClose={() => setOpen(null)} />
            )}
          </section>
          <section
            className="up-panel up-failures"
            aria-label="What is failing on main"
          >
            <h2>What is failing on main</h2>
            <div className="up-failures-surface calendar-surface">
            <p className="muted up-failures-caption">Most frequent failed steps · {overview.window.days} days · main</p>
            {steps.length ? (
              <table className="up-failures-table" aria-label="Failing steps on main">
                <thead><tr><th scope="col">Failed step</th><th scope="col">Failures</th><th scope="col" title="Number of affected CI jobs">Jobs</th></tr></thead>
                <tbody>{steps.map(([step, info]) => (
                  <tr key={step}>
                    <th scope="row">
                      <Tooltip label={step} triggerClassName="up-step-label"
                        content={<TooltipContent heading={step}><span>{[...info.jobs.values()].join(", ")}</span><span>{info.n} observed failures · {info.jobs.size} affected {info.jobs.size === 1 ? "job" : "jobs"}</span></TooltipContent>}>
                        <span>{step}</span>
                      </Tooltip>
                    </th>
                    <td className="up-failure-count">{info.n}</td>
                    <td>{info.jobs.size}</td>
                  </tr>
                ))}</tbody>
              </table>
            ) : <p className="muted">No collected failing-step details.</p>}
            </div>
          </section>
        </div>
        <div className="up-project-coverage">
          <Platforms project={project} />
          <MergeGate jobs={jobs} complete={project.coverage.complete} />

        </div>
      </div>
      <section className="up-panel up-jobs" aria-label="CI jobs">
        <h2>CI jobs <span className="muted">{jobs.length} jobs · {days14.length} days · UTC</span></h2>
        <div className="up-table-scroll calendar-surface" role="region" aria-label="CI jobs table" tabIndex={0}>
          <table className="up-activity-table up-jobs-table" aria-label="CI jobs">
            <thead>
              <tr className="calendar-months">
                {["Job", "Platform"].map((label) => <th key={label} scope="col" rowSpan={2} aria-label={label}>{label === "Platform" ? "OS" : label}</th>)}
                {calendarMonthGroups(days14).map((month, index) => <th key={month.key} scope="colgroup" colSpan={month.days}
                  className={index ? "month-boundary" : undefined} aria-label={`${month.label} ${month.key.slice(0, 4)}`}>{month.label}</th>)}
              </tr>
              <tr>{days14.map((day, index) => <th key={day} scope="col" aria-label={`${day} UTC`}
                className={isCalendarMonthBoundary(days14, index) ? "month-boundary" : undefined}><time dateTime={day}>{Number(day.slice(8))}</time></th>)}</tr>
            </thead>
            <tbody>{jobs.map((job) => {
              const key = `job:${job.id}`;
              const passed = days14.reduce((total, day) => total + (job.daily[day]?.passed ?? 0), 0);
              const failed = days14.reduce((total, day) => total + (job.daily[day]?.failed ?? 0), 0);
              const decided = passed + failed;
              return <tr key={job.id}>
                <th scope="row">
                  <Tooltip label={job.label} triggerClassName="up-job-label"
                    content={<TooltipContent heading={job.label}>
                      <span>{job.category} · {job.workflow} · {job.cadence}</span>
                      <span>Stack: {job.stack} · Target: {job.target}</span>
                      <span>{job.where}</span>
                      <span>Pass rate ({days14.length} days): {decided ? `${Math.round(100 * passed / decided)}%` : "Unavailable"} · {passed} passed of {decided} decided results</span>
                      {project.coverage.complete && notRunning(job) && <span>{job.last_ran ? `Quiet since ${job.last_ran}` : "Never ran"}</span>}
                    </TooltipContent>}><span>{job.label}</span></Tooltip>
                </th>
                <td className="up-job-platform" aria-label={job.os === "windows" ? "Windows" : "Linux"} title={job.os === "windows" ? "Windows" : "Linux"}><PlatformIcon platform={job.os} /></td>
                {days14.map((day, index) => {
                  const cell = job.daily[day];
                  const state = cellState(cell);
                  const label = `${job.label} · ${describe(day, cell)}`;
                  const active = open?.key === key && open.day === day;
                  return <td key={day} className={`table-status${isCalendarMonthBoundary(days14, index) ? " month-boundary" : ""}`} data-outcome={activityOutcomes[state]}>
                    <Tooltip interactive label={label} triggerClassName="up-tick" contentClassName="up-run-tooltip"
                      isOpen={active} onOpenChange={(next) => { if (next !== active) pick(key, day, [job.id]); }}
                      content={<DayPanel project={project} jobs={[job]} day={day} days={days14} runs={runs}
                        onDay={(next) => setOpen({ key, day: next, jobs: [job.id] })} onClose={() => setOpen(null)} />}>
                      <ActivityMark state={state} />
                    </Tooltip>
                  </td>;
                })}
              </tr>;
            })}</tbody>
          </table>
        </div>
        {open?.key.startsWith("job:") && !days14.includes(open.day) && jobs.some((job) => `job:${job.id}` === open.key) &&
          <DayPanel project={project} jobs={jobs.filter((job) => `job:${job.id}` === open.key)} day={open.day}
            days={allDays} runs={runs} onDay={(day) => setOpen({ ...open, day })} onClose={() => setOpen(null)} />}
      </section>
      <div className="up-project-context">
        <section className="up-panel" aria-label="Repositories">
          <h2>Repositories</h2>
          <ProjectSources project={project} />
        </section>
        <section className="up-panel up-findings" aria-label="Project findings">
          <h2>Project findings</h2>
          {findings.length ? findings.map((finding) => (
            <p key={finding.head}><strong>{finding.head}</strong> {finding.body}</p>
          )) : <p className="muted">No project-wide findings recorded.</p>}
        </section>
      </div>
    </section>
  );
}

function DayPanel({
  project,
  jobs,
  day,
  days,
  runs,
  onDay,
  onClose,
}: {
  project: Project;
  jobs: Job[];
  day: string;
  days: string[];
  runs: { rows: Run[] | null; error: string | null };
  onDay: (day: string) => void;
  onClose: () => void;
}) {
  const i = days.indexOf(day);
  const ids = new Set(jobs.map((j) => j.id));
  const label = Object.fromEntries(jobs.map((j) => [j.id, j.label]));
  const cell = sumCells(jobs, day);
  const rows = (runs.rows ?? [])
    .filter((r) => r.day === day && ids.has(r.job))
    .sort(
      (a, b) =>
        Number(b.state === "failed") - Number(a.state === "failed") ||
        a.created_at.localeCompare(b.created_at),
    );
  return (
    <div className="up-daypanel" role="region" aria-label={`Runs on ${day}`}>
      <div className="up-daypanel-head">
        <button
          type="button"
          disabled={i <= 0}
          onClick={() => onDay(days[i - 1])}
          aria-label="Previous day"
        >
          ‹
        </button>
        <button
          type="button"
          disabled={i >= days.length - 1}
          onClick={() => onDay(days[i + 1])}
          aria-label="Next day"
        >
          ›
        </button>
        <strong>{day}</strong>
        <span className="muted">
          {cell.passed + cell.failed + cell.running + cell.other} runs · {cell.passed} passed, {cell.failed} failed
          {cell.stalled ? `, ${cell.stalled} never ran` : ""}
          {cell.skipped ? `, ${cell.skipped} skipped` : ""}
          {cell.running ? `, ${cell.running} running` : ""}
          {cell.other ? `, ${cell.other} other results` : ""}
        </span>
        <button type="button" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>
      {runs.error ? (
        <p className="bad">{runs.error}</p>
      ) : !runs.rows ? (
        <p className="muted">Loading runs…</p>
      ) : rows.length ? (
        <ul className="up-runs">
          {rows.map((run) => (
            <li
              key={`${run.job}:${run.job_id}`}
              className={`up-run up-run-${run.state}`}
            >
              <span className="up-dot" aria-hidden="true" />
              <a
                href={run.url}
                target="_blank"
                rel="noreferrer"
                title="Open the job log"
                aria-label={`Job log at ${run.created_at.slice(11, 16)} UTC · ${run.state}`}
              >
                Job log · <time dateTime={run.created_at}>{run.created_at.slice(11, 16)}</time> UTC
              </a>
              {jobs.length > 1 && (
                <span className="up-run-job">{label[run.job]}</span>
              )}
              {run.sha && (
                <a
                  className="up-sha"
                  href={`${GH}${project.repository}/commit/${run.sha}`}
                  target="_blank"
                  rel="noreferrer"
                  title="Open the commit"
                  aria-label={`Commit ${run.sha.slice(0, 8)}`}
                >
                  Commit {run.sha.slice(0, 8)}
                </a>
              )}
              {run.ref && run.ref !== project.default_branch && (
                <span className="muted">{run.ref}</span>
              )}
              {run.pr && (
                <a
                  className={`up-chip up-chip-${run.pr.verdict}`}
                  href={run.pr.url}
                  target="_blank"
                  rel="noreferrer"
                  title={`#${run.pr.number} ${VERDICT_TEXT[run.pr.verdict]}`}
                >
                  #{run.pr.number} {VERDICT_LABEL[run.pr.verdict]}
                </a>
              )}
              {run.state !== "passed" && (
                <a
                  href={run.url}
                  target="_blank"
                  rel="noreferrer"
                  className="up-run-step"
                >
                  {run.failed_step ? `Failed step: ${run.failed_step}` : run.state}
                </a>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">
          {cell.skipped && !cell.stalled
            ? "Skipped by the job's own condition."
            : cell.stalled
              ? "Requested, and no machine took it."
              : "No collected evidence for this day."}
        </p>
      )}
    </div>
  );
}

function Platforms({ project }: { project: Project }) {
  const cell = (ok: boolean, text: string | null, gap = false) => (
    <td className={ok ? "good" : gap ? "bad" : "muted"}>
      {ok ? "✓" : gap ? "✗" : "–"} {text ?? ""}
    </td>
  );
  return (
    <section className="up-panel" aria-label="Platforms">
      <h2>
        Platforms <span className="muted">project-wide configured targets</span>
      </h2>
      <p className="muted">Configured targets and distribution do not verify physical hardware or published artifacts.</p>
      <div className="up-table-scroll" role="region" aria-label="Platform coverage table" tabIndex={0}>
        <table className="up-table">
          <thead>
            <tr>
              <th />
              <th>Built in CI</th>
              <th>Configured test target observed</th>
              <th>Configured distribution</th>
            </tr>
          </thead>
          <tbody>
            {(["linux", "windows"] as const).map((os) => {
              const p = project.platforms[os];
              return (
                <tr key={os}>
                  <th scope="row">{os === "linux" ? "Linux" : "Windows"}</th>
                  {cell(
                    p.built,
                    p.built_rate !== null ? `${p.built_rate}%` : null,
                  )}
                  {cell(
                    p.tested,
                    p.tested_rate !== null ? `${p.tested_rate}%` : null,
                    !p.tested && !!p.shipped && project.coverage.complete && project.jobs.length > 0,
                  )}
                  <td
                    className="muted"
                    title={p.shipped ?? undefined}
                  >
                    {p.shipped ?? "–"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function MergeGate({ jobs, complete }: { jobs: Job[]; complete: boolean }) {
  const gated = jobs.filter((j) => j.gate);
  const [list, setList] = useState<{
    job: string;
    kind: "red" | "escaped";
  } | null>(null);
  if (!gated.length) return null;
  const shown = list && gated.find((j) => j.id === list.job);
  return (
    <section className="up-panel" aria-label="Merge gate">
      <h2>
        Merge gate{" "}
        <span className="muted">{complete ? "the job on the commit that merged" : "collected evidence on the commit that merged; incomplete"}</span>
      </h2>
      <div className="up-table-scroll" role="region" aria-label="Merge gate results table" tabIndex={0}>
        <table className="up-table">
          <thead>
            <tr>
              <th>Job</th>
              <th title="pull requests merged">Merged</th>
              <th title="green on the merged commit">Passed</th>
              <th title="red on the merged commit, merged anyway">Red</th>
              <th title="never ran on the pull request">No run</th>
              <th title="historical pull request result is unknown">Unknown</th>
              <th title="no run or unknown result on the pull request, then failed on main">
                Broke main
              </th>
            </tr>
          </thead>
          <tbody>
            {gated.map((job) => {
              const g = job.gate!;
              return (
                <tr key={job.id}>
                  <th scope="row">{job.label}</th>
                  <td>{g.merged}</td>
                  <td>{g.passed}</td>
                  <td>
                    {g.failed ? (
                      <button
                        type="button"
                        className="up-link bad"
                        onClick={() => setList({ job: job.id, kind: "red" })}
                      >
                        {g.failed}
                      </button>
                    ) : (
                      0
                    )}
                  </td>
                  <td>{g.not_triggered}</td>
                  <td>{g.no_result}</td>
                  <td>
                    {g.escaped.length ? (
                      <button
                        type="button"
                        className="up-link"
                        onClick={() => setList({ job: job.id, kind: "escaped" })}
                      >
                        {g.escaped.length}
                      </button>
                    ) : (
                      0
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {shown && list && (
        <div
          className="up-daypanel"
          role="region"
          aria-label={`${shown.label} pull requests`}
        >
          <div className="up-daypanel-head">
            <strong>{shown.label}</strong>
            <span className="muted">
              {list.kind === "red"
                ? "merged while failing"
                : "no run or unknown result on the PR, then failed on main"}
            </span>
            <button
              type="button"
              onClick={() => setList(null)}
              aria-label="Close"
            >
              ×
            </button>
          </div>
          <ul className="up-runs">
            {shown.gate![list.kind].map((g) => (
              <li key={g.number} className="up-run up-run-failed">
                <span className="up-dot" aria-hidden="true" />
                <a href={g.url} target="_blank" rel="noreferrer">
                  #{g.number}
                </a>
                <span className="muted">{g.author}</span>
                {list.kind === "escaped" && (
                  <span className="muted">{g.verdict === "not_triggered" ? "never ran on the pull request" : "historical result unknown"}</span>
                )}
                {list.kind === "red" && g.check_url && (
                  <a
                    className="up-chip up-chip-failed"
                    href={g.check_url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    failing check
                  </a>
                )}
                {g.main_url && (
                  <a
                    className={`up-chip${g.main === "failed" ? " up-chip-failed" : ""}`}
                    href={g.main_url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    main {g.main}
                  </a>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
