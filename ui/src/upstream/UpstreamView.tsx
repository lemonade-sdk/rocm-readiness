import { useEffect, useMemo, useState } from "react";
import type { Fetcher, Session } from "../data";
import {
  CATEGORIES,
  cellState,
  keepJob,
  loadRuns,
  loadUpstream,
  mergedRed,
  notRunning,
  rate,
  sumCells,
  windowDays,
} from "./data";
import type { Cell, Job, Project, Run, UpstreamOverview } from "./data";
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
  const selected = data.projects.find((p) => p.id === params.get("project"));
  if (params.get("project") && !selected)
    return (
      <div className="notice" role="alert">
        <h1>Unknown project</h1>
        <a href={`?${query(params, { project: null, lens: null })}`}>
          Back to all projects
        </a>
      </div>
    );
  return selected ? (
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

function Forks({ project }: { project: Project }) {
  if (!project.forks.length) return null;
  return (
    <details className="up-forks" onClick={(event) => event.stopPropagation()}>
      <summary>
        {project.forks.length} {project.forks.length > 1 ? "forks" : "fork"}
      </summary>
      <ul>
        {project.forks.map((fork) => (
          <li key={fork.repository}>
            <a href={GH + fork.repository} target="_blank" rel="noreferrer">
              {fork.repository}
            </a>
            <span className="muted">
              {fork.role}
              {fork.channel ? ` · ${fork.channel}` : ""}
            </span>
          </li>
        ))}
      </ul>
    </details>
  );
}

/** One thin tick per day, coloured by that day's pass rate. */
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
            className={`up-tick up-${state}`}
            title={text}
            aria-label={text}
            onClick={() => onPick(day)}
          />
        ) : (
          <span
            key={day}
            role="img"
            className={`up-tick up-${state}`}
            title={text}
            aria-label={text}
          />
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

/** Passes grow up from the line; failures hang below it on their own scale. */
function DayBars({
  days,
  cellOf,
  selected,
  onPick,
  label,
}: {
  days: string[];
  cellOf: (day: string) => Cell;
  selected: string | null;
  onPick: (day: string) => void;
  label: string;
}) {
  const up = 30;
  const down = 14;
  const peak = Math.max(
    1,
    ...days.map((d) => cellOf(d).passed),
  );
  const failPeak = Math.max(1, ...days.map((d) => cellOf(d).failed));
  return (
    <div className="up-bars" role="group" aria-label={label}>
      {days.map((day) => {
        const cell = cellOf(day);
        const ok = cell.passed;
        const ran = ok + cell.failed + cell.other + cell.running;
        return (
          <button
            key={day}
            type="button"
            className={`up-bar${selected === day ? " selected" : ""}`}
            title={describe(day, cell)}
            aria-label={describe(day, cell)}
            aria-pressed={selected === day}
            onClick={() => onPick(day)}
          >
            <span className="up-bar-up" style={{ height: up }}>
              {ok > 0 ? (
                <i
                  className="up-pass"
                  style={{ height: Math.max(2, Math.round((up * ok) / peak)) }}
                />
              ) : !ran && cell.stalled ? (
                <i className="up-stall" />
              ) : !ran && cell.skipped ? (
                <i className="up-skip" />
              ) : null}
            </span>
            <span className="up-bar-base" />
            <span className="up-bar-down" style={{ height: down }}>
              {cell.failed > 0 && (
                <i
                  className="up-fail"
                  style={{
                    height: Math.max(
                      3,
                      Math.round((down * cell.failed) / failPeak),
                    ),
                  }}
                />
              )}
            </span>
            <span className="up-bar-day">{day.slice(8)}</span>
          </button>
        );
      })}
    </div>
  );
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
  const last14 = windowDays(overview, 14);
  const all = overview.projects.flatMap((p) => p.jobs);
  const totals = rate(all);
  const red = overview.projects.reduce((n, p) => n + p.kpis.merged_red, 0);
  const quiet = overview.projects.reduce((n, p) => n + p.kpis.not_running, 0);
  const complete = overview.projects.every((p) => p.coverage.complete);
  return (
    <section aria-label="Upstream projects" className="up-home">
      <div className="up-totals">
        <Stat value={overview.projects.length} label="projects" />
        <Stat value={all.length} label="configured client jobs" />
        <Stat
          value={totals.pct === null ? "–" : `${totals.pct}%`}
          label={complete ? "passed on main" : "of collected results passed on main"}
        />
        <Stat value={red} label={complete ? "PRs merged red" : "observed PRs merged red"} bad={red > 0} />
        <Stat value={complete ? quiet : "Unknown"} label="tests not running" bad={complete && quiet > 0} />
      </div>
      <p className="up-rule muted">
        Upstream means a test on the default branch ran on{" "}
        configured targets {overview.client_rule.targets.join(" or ")}; partial means other client
        targets only. Badges reflect configured jobs with observed runs, not verified hardware, complete support, or published artifacts. No jobs or incomplete collection cannot establish absence of support. Window {overview.window.start} to {overview.window.end}.
      </p>
      <div className="up-cards">
        {overview.projects.map((project) => {
          const r = rate(project.jobs);
          return (
            <article
              key={project.id}
              className="card up-card"
              onClick={() =>
                onNavigate(query(params, { project: project.id, lens: null }))
              }
            >
              <div className="up-card-head">
                <h2>
                  <a
                    href={`?${query(params, { project: project.id, lens: null })}`}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      onNavigate(
                        query(params, { project: project.id, lens: null }),
                      );
                    }}
                  >
                    {project.label}
                  </a>
                </h2>
                <Badge project={project} />
                <Forks project={project} />
                <span className="muted up-repo">{project.repository}</span>
              </div>
              {project.coverage.error && <CollectionFailure error={project.coverage.error} />}
              {!project.coverage.complete && !project.coverage.error && <p className="muted">Collection incomplete</p>}
              {project.jobs.length ? (
                <>
                  <div className="up-kpis">
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
                  {CATEGORIES.map((category) => {
                    const jobs = project.jobs.filter(
                      (j) => j.category === category,
                    );
                    if (!jobs.length) return null;
                    return (
                      <div className="up-strip" key={category}>
                        <span className="up-strip-label">{category}</span>
                        <Ticks
                          days={last14}
                          cellOf={(d) => sumCells(jobs, d)}
                          label={`${project.label} ${category}, last 14 days`}
                        />
                      </div>
                    );
                  })}
                </>
              ) : (
                <p className="muted">
                  No conclusion about upstream support can be drawn from the configured coverage.
                </p>
              )}
            </article>
          );
        })}
      </div>
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
  const lens = params.get("lens") ?? "all";
  const jobs = project.jobs.filter(keepJob(lens));
  const stacks = [...new Set(project.jobs.map((j) => j.stack))].sort();
  const targets = [
    ...new Set(
      project.jobs.map((j) => j.target).filter((t) => t.startsWith("gfx")),
    ),
  ].sort();
  const days14 = windowDays(overview, 14);
  const allDays = windowDays(overview);
  const [runs, setRuns] = useState<{
    rows: Run[] | null;
    error: string | null;
  }>({ rows: null, error: null });
  const [open, setOpen] = useState<{
    key: string;
    day: string;
    jobs: string[];
  } | null>(null);
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
    const totals: Record<string, { n: number; jobs: Set<string> }> = {};
    for (const job of jobs)
      for (const [step, n] of Object.entries(job.failed_steps)) {
        totals[step] ??= { n: 0, jobs: new Set() };
        totals[step].n += n;
        totals[step].jobs.add(job.label);
      }
    return Object.entries(totals)
      .sort((a, b) => b[1].n - a[1].n)
      .slice(0, 6);
  }, [jobs]);

  const setLens = (value: string) =>
    onNavigate(query(params, { lens: value === "all" ? null : value }));
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
      <div className="up-page-head">
        <a
          href={`?${query(params, { project: null, lens: null })}`}
          onClick={(e) => {
            e.preventDefault();
            onNavigate(query(params, { project: null, lens: null }));
          }}
        >
          ‹ All projects
        </a>
        <h1>{project.label}</h1>
        <Badge project={project} />
        <p className="muted">Badge describes configured jobs with observed runs; it does not verify physical hardware, complete support, or published artifacts.</p>
        <Forks project={project} />
        <a
          className="muted up-repo"
          href={GH + project.repository}
          target="_blank"
          rel="noreferrer"
        >
          {project.repository}
        </a>
      </div>
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
      {(stacks.length > 1 || targets.length > 1) && (
        <div className="up-filter" role="group" aria-label="Filter">
          <span className="muted">Filter</span>
          {["all", ...stacks, ...targets].map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={lens === value}
              onClick={() => setLens(value)}
            >
              {value === "all" ? "Everything AMD" : value}
            </button>
          ))}
          <span className="muted up-filter-sum">
            {jobs.length} {jobs.length === 1 ? "job" : "jobs"}
            {r.pct !== null ? ` · ${r.pct}% of ${r.decided} passed` : ""}
          </span>
        </div>
      )}
      {findings.length > 0 && (
        <details className="up-findings">
          <summary>
            Project-wide: {findings.length}{" "}
            {findings.length > 1 ? "findings" : "finding"}
          </summary>
          {findings.map((f) => (
            <p key={f.head}>
              <strong>{f.head}</strong> {f.body}
            </p>
          ))}
        </details>
      )}
      {project.coverage.error && <CollectionFailure error={project.coverage.error} />}
      {!project.coverage.complete && !project.coverage.error && (
        <p className="notice">
          Collection for this project is still filling its window; the oldest
          days may be incomplete.
        </p>
      )}
      <div className="up-cols">
        <div>
          <section className="card up-panel" aria-label="Per day">
            <h2>
              Per day{" "}
              <span className="muted">
                main only, last 14 days · passed up, failed down
              </span>
            </h2>
            {CATEGORIES.map((category) => {
              const group = jobs.filter((j) => j.category === category);
              if (!group.length) return null;
              const key = `cat:${category}`;
              return (
                <div key={category} className="up-daychart">
                  <h3 title={group.map((j) => j.label).join(", ")}>
                    {category}
                  </h3>
                  {days14.every((d) => !group.some((j) => j.daily[d])) && (
                    <p className="muted up-empty-chart">
                      No collected runs on the default branch in the last 14 days.
                    </p>
                  )}
                  <DayBars
                    days={days14}
                    cellOf={(d) => sumCells(group, d)}
                    selected={open?.key === key ? open.day : null}
                    onPick={(day) =>
                      pick(
                        key,
                        day,
                        group.map((j) => j.id),
                      )
                    }
                    label={`${category} per day`}
                  />
                  {open?.key === key && (
                    <DayPanel
                      project={project}
                      jobs={group}
                      day={open.day}
                      days={days14}
                      runs={runs}
                      onDay={(day) => setOpen({ ...open, day })}
                      onClose={() => setOpen(null)}
                    />
                  )}
                </div>
              );
            })}
          </section>
        </div>
        <div>
          <Platforms project={project} />
          <MergeGate jobs={jobs} complete={project.coverage.complete} />
          <section
            className="card up-panel"
            aria-label="What is failing on main"
          >
            <h2>What is failing on main</h2>
            {steps.length ? (
              <ol className="up-steps">
                {steps.map(([step, info]) => (
                  <li key={step} title={[...info.jobs].join(", ")}>
                    <span>{step}</span>
                    <i
                      style={{
                        width: `${Math.round((100 * info.n) / steps[0][1].n)}%`,
                      }}
                    />
                    <span className="muted">{info.n}</span>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="muted">No collected failures on main.</p>
            )}
          </section>
        </div>
      </div>
      <details className="card up-panel up-jobs">
        <summary>
          <h2>
            By job{" "}
            <span className="muted">
              {jobs.length} jobs, {overview.window.days} days, click a day for
              its runs
            </span>
          </h2>
        </summary>
        {jobs.map((job) => {
          const key = `job:${job.id}`;
          return (
            <div key={job.id} className="up-job">
              <div className="up-job-head">
                <strong>{job.label}</strong>
                <Ticks
                  days={allDays}
                  cellOf={(d) => job.daily[d]}
                  onPick={(day) => pick(key, day, [job.id])}
                  label={`${job.label}, ${overview.window.days} days`}
                />
                <span
                  className="muted"
                  title={`${job.workflow} · ${job.cadence} · ${job.stack}`}
                >
                  {job.target} · {job.where}
                  {project.coverage.complete && notRunning(job) && (
                    <span className="bad">
                      {" "}
                      ·{" "}
                      {job.last_ran
                        ? `quiet since ${job.last_ran}`
                        : "never ran"}
                    </span>
                  )}
                </span>
                <span className="up-job-rate">
                  {job.decided
                    ? `${Math.round((100 * job.passed) / job.decided)}%`
                    : "–"}
                </span>
              </div>
              {open?.key === key && (
                <DayPanel
                  project={project}
                  jobs={[job]}
                  day={open.day}
                  days={allDays}
                  runs={runs}
                  onDay={(day) => setOpen({ ...open, day })}
                  onClose={() => setOpen(null)}
                />
              )}
            </div>
          );
        })}
      </details>
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
          {cell.passed} passed, {cell.failed} failed
          {cell.stalled ? `, ${cell.stalled} never ran` : ""}
          {cell.skipped ? `, ${cell.skipped} skipped` : ""}
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
              >
                {run.created_at.slice(11, 16)}
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
                >
                  {run.sha.slice(0, 8)}
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
                  {run.failed_step ?? run.state}
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
    <section className="card up-panel" aria-label="Platforms">
      <h2>
        Platforms <span className="muted">project-wide configured targets</span>
      </h2>
      <p className="muted">Configured targets and distribution do not verify physical hardware or published artifacts.</p>
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
    <section className="card up-panel" aria-label="Merge gate">
      <h2>
        Merge gate{" "}
        <span className="muted">{complete ? "the job on the commit that merged" : "collected evidence on the commit that merged; incomplete"}</span>
      </h2>
      <table className="up-table">
        <thead>
          <tr>
            <th>Job</th>
            <th title="pull requests merged">Merged</th>
            <th title="green on the merged commit">Passed</th>
            <th title="red on the merged commit, merged anyway">Red</th>
            <th title="never ran on the pull request">No run</th>
            <th title="never ran on the pull request, then failed on main">
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
                <td>{g.not_triggered + g.no_result}</td>
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
                : "never ran on the PR, then failed on main"}
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
