import { useEffect, useId, useState, type CSSProperties } from "react";
import { Link } from "react-router";
import { PlatformIcon } from "../PlatformIcon";
import type { Build, Fetcher } from "../data";
import { measurementIdentity, metricValue, type PerformanceData } from "../performance/PerformanceView";
import { BuildOutcomeIcon } from "../overview/BuildOutcomeIcon";
import { Tooltip, TooltipContent } from "../overview/Tooltip";
import { buildDate, buildIdentity, exactBuildHref } from "../overview/buildTimeline";
import { qualificationCheckHref, readQualificationReport } from "./BuildBrowser";
import "./QualificationMatrix.css";

type Report = Awaited<ReturnType<typeof readQualificationReport>>;
type Outcome = "pass" | "fail" | "warn" | "skip" | "not_applicable" | "unreported";

const outcomes: Record<Outcome, string> = {
  pass: "Pass",
  fail: "Fail",
  warn: "Warn",
  skip: "Skipped",
  not_applicable: "Not applicable",
  unreported: "Unreported",
};

function outcome(status?: string): Outcome {
  switch (status?.toLowerCase().replace(/[ -]/g, "_")) {
    case "pass":
    case "passed":
      return "pass";
    case "fail":
    case "failed":
    case "error":
      return "fail";
    case "warn":
    case "warned":
    case "warning":
      return "warn";
    case "skip":
    case "skipped":
      return "skip";
    case "n/a":
    case "not_applicable":
      return "not_applicable";
    default:
      return "unreported";
  }
}

function platformName(os: string) {
  return os === "linux" ? "Linux" : os === "windows" ? "Windows" : os;
}

function tierLabel(id: string) {
  return id.replace(/^tier(\d+)$/i, "T$1");
}

const checkOrder = new Intl.Collator("en", { numeric: true });

function buildRepository(build: Build) {
  return build.source_url?.match(/^https:\/\/raw\.githubusercontent\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/[a-f0-9]{40}\/qualification\/index\.json$/)?.[1];
}

function PackageDetails({ heading, packages, coverageFetcher, run, performanceMeasurements }: {
  heading: string;
  packages: Build[];
  coverageFetcher?: Fetcher;
  run?: Build;
  performanceMeasurements?: Map<Build, PerformanceData["measurements"]>;
}) {
  const [inspect, setInspect] = useState(false);
  const [coverage, setCoverage] = useState<{ packages: Build[]; targets: Map<Build, string[]> }>();
  useEffect(() => {
    if (!inspect || !coverageFetcher) return;
    const controller = new AbortController();
    void Promise.allSettled(packages.map(async (build) => {
      const report = await readQualificationReport(build, controller.signal, coverageFetcher);
      const gfx = report.raw.gfx;
      const present = gfx && typeof gfx === "object" && "present_in_binary" in gfx ? gfx.present_in_binary : null;
      if (!Array.isArray(present) || !present.every((target) => typeof target === "string" && /^gfx[0-9a-z]+$/i.test(target)))
        return null;
      return [build, [...new Set(present)].sort(checkOrder.compare)] as const;
    })).then((reports) => {
      if (controller.signal.aborted) return;
      setCoverage({ packages, targets: new Map(reports.flatMap((report) =>
        report.status === "fulfilled" && report.value ? [report.value] : [],
      )) });
    });
    return () => controller.abort();
  }, [packages, inspect, coverageFetcher]);

  const hasPerformance = packages.some((build) => performanceMeasurements?.get(build)?.length);
  const evidence = coverage?.packages === packages ? coverage.targets : undefined;
  return <Tooltip floating interactive contentClassName="qualification-popup" label={`${run ? `Run details for ${heading}` : `Package details for ${heading}`}${hasPerformance ? " · Performance data available" : ""}`}
    onOpen={() => setInspect(true)}
    content={<TooltipContent heading={heading}>
      {run && <dl><dt>Date</dt><dd>{buildDate(run)} UTC</dd><dt>Workflow run</dt><dd>
        {run.run_id && buildRepository(run) ? <a href={`https://github.com/${buildRepository(run)}/actions/runs/${encodeURIComponent(run.run_id)}`} target="_blank" rel="noreferrer">{run.run_id} ↗</a> : run.run_id ?? "Unreported"}
      </dd></dl>}
      <ul className="qualification-popup-packages">
        {[...packages].sort((a, b) => (a.os === "windows" ? 0 : 1) - (b.os === "windows" ? 0 : 1)).map((build) => {
          const targets = evidence?.get(build);
          const repository = buildRepository(build);
          const measurements = performanceMeasurements?.get(build) ?? [];
          return <li key={buildIdentity(build)}>
            <h4 className="qualification-platform-heading">
              <PlatformIcon platform={build.os} /> {platformName(build.os)} <small>(<Link to={exactBuildHref(build, "build")} aria-label={`Build details for ${platformName(build.os)} package ${build.build_id}`}>Build details</Link>)</small>
            </h4>
            <dl className="qualification-package-metadata">
              <dt>Build ID</dt><dd>{build.build_id}</dd>
              <dt>ROCm SDK</dt><dd>{build.producer_rocm_version ?? build.rocm_version}</dd>
              {build.published === true && build.tag && repository && <><dt>Release</dt><dd><a href={`https://github.com/${repository}/releases/tag/${encodeURIComponent(build.tag)}`} target="_blank" rel="noreferrer">{build.tag} ↗</a></dd></>}
              {build.upstream_sha && <><dt>Upstream SHA</dt><dd>{build.engine === "llamacpp" ? <a href={`https://github.com/ggml-org/llama.cpp/commit/${encodeURIComponent(build.upstream_sha)}`} target="_blank" rel="noreferrer"><code title={build.upstream_sha}>{build.upstream_sha.slice(0, 12)} ↗</code></a> : <code title={build.upstream_sha}>{build.upstream_sha.slice(0, 12)}</code>}</dd></>}
              {!run && build.run_id && repository && <><dt>Workflow run</dt><dd><a href={`https://github.com/${repository}/actions/runs/${encodeURIComponent(build.run_id)}`} target="_blank" rel="noreferrer">{build.run_id} ↗</a></dd></>}
              {build.artifact && <><dt>Archive</dt><dd>{build.artifact}</dd></>}
            </dl>
            {measurements.length > 0 && <PackagePerformance build={build} measurements={measurements} />}
            {coverageFetcher && <div className="qualification-compiled-targets">
              <h5>Compiled GPU targets</h5>
              {targets?.length ? <ul aria-label="Compiled GPU targets">
                {targets.map((target) => <li key={target}><code>{target}</code></li>)}
              </ul> : <span className="muted">{!evidence ? "Loading…" : targets ? "None recorded" :
                build.gfx?.present != null ? `${build.gfx.present} compiled · exact list unavailable` : "Unavailable"}</span>}
            </div>}
            {coverageFetcher && build.hardware_validated && build.gfx_target &&
              <p className="qualification-runtime muted">Runtime validated on <code>{build.gfx_target}</code></p>}
          </li>;
        })}
      </ul>
    </TooltipContent>}>
    {heading}
    {hasPerformance && <svg className="qualification-performance-indicator" aria-hidden="true" viewBox="0 0 16 16">
      <path d="M2 13V8m6 5V3m6 10V6" />
    </svg>}
  </Tooltip>;
}

type PerformanceColumn = "model" | "ttft_ms_mean" | "tps_mean" | "vram_peak_gb";
const performanceColumns: [PerformanceColumn, string][] = [
  ["model", "Model"], ["ttft_ms_mean", "TTFT"], ["tps_mean", "TPS"], ["vram_peak_gb", "VRAM"],
];

function PackagePerformance({ build, measurements }: {
  build: Build;
  measurements: PerformanceData["measurements"];
}) {
  const [sort, setSort] = useState<{ column: PerformanceColumn; descending: boolean }>({ column: "model", descending: false });
  const models = new Map<string, PerformanceData["measurements"][number]>();
  for (const row of [...measurements].sort((a, b) => Date.parse(b.measured_at) - Date.parse(a.measured_at))) {
    if (!models.has(row.model)) models.set(row.model, row);
  }
  const rows = [...models.values()].sort((a, b) => {
    if (sort.column === "model") return (sort.descending ? -1 : 1) * a.model.localeCompare(b.model);
    const left = a.metrics[sort.column];
    const right = b.metrics[sort.column];
    if (left == null) return right == null ? a.model.localeCompare(b.model) : 1;
    if (right == null) return -1;
    return (sort.descending ? right - left : left - right) || a.model.localeCompare(b.model);
  });
  function changeSort(column: PerformanceColumn) {
    setSort({ column, descending: sort.column === column ? !sort.descending : column === "tps_mean" });
  }
  function observationHref(row: PerformanceData["measurements"][number]) {
    const query = new URLSearchParams(exactBuildHref(build, "model").slice(1));
    query.set("model", row.model);
    query.set("observation", measurementIdentity(row));
    return `?${query}`;
  }
  return <div className="qualification-performance-details">
    <h5>Model performance <small>(<Link to={exactBuildHref(build, "build-performance")}
      aria-label={`Performance details for ${platformName(build.os)} package ${build.build_id}`}>Performance details</Link>)</small></h5>
    <span className="muted">Latest observation per model</span>
    <div className="qualification-performance-scroll">
      <table className="qualification-performance-table">
        <thead><tr>{performanceColumns.map(([column, label]) =>
          <th key={column} scope="col" aria-sort={sort.column === column ? sort.descending ? "descending" : "ascending" : undefined}
            title={column === "vram_peak_gb" ? "Maximum reported GPU memory in use across benchmark runs" : undefined}>
            <button type="button" onClick={() => changeSort(column)} aria-label={`Sort by ${label}`}>
              {label}{sort.column === column && <span className="performance-sort-arrow" aria-hidden="true">{sort.descending ? " ↓" : " ↑"}</span>}
            </button>
          </th>)}</tr></thead>
        <tbody>{rows.map((row) => <tr key={row.model}>
          <th scope="row" title={`${row.model} · ${row.scenario} · ${row.quant ?? "Quantization unreported"} · ${row.system_id ?? "Hardware unreported"} · ${row.measured_at}`}><Link to={observationHref(row)}>{row.model}</Link></th>
          {(["ttft_ms_mean", "tps_mean", "vram_peak_gb"] as const).map((metric) =>
            <td key={metric}>{row.metrics[metric] == null ? "—" : metricValue(metric, row.metrics[metric])}</td>)}
        </tr>)}</tbody>
      </table>
    </div>
  </div>;
}

function PackageCell({ build, selected, fetcher }: {
  build: Build;
  selected: boolean;
  fetcher: Fetcher;
}) {
  const [inspect, setInspect] = useState(selected);
  const [report, setReport] = useState<Report>();
  useEffect(() => {
    if (!inspect || !build.report_url) return;
    const controller = new AbortController();
    readQualificationReport(build, controller.signal, fetcher).then(
      (evidence) => { if (!controller.signal.aborted) setReport(evidence); },
      () => { /* Retained check outcomes remain available when a report cannot load. */ },
    );
    return () => controller.abort();
  }, [build, fetcher, inspect]);
  const tiers = Object.entries(build.tier_verdicts ?? {});
  const platform = platformName(build.os);
  const label = build.gfx_family ? `${platform} · ${build.gfx_family}` : `${platform} Build`;
  const byTier = new Map<string, [string, string][]>();
  for (const [id, verdict] of Object.entries(build.results ?? {}).sort(([a], [b]) => checkOrder.compare(a, b))) {
    const number = /^T(\d+)\./i.exec(id)?.[1];
    const numbered = `tier${number}`;
    const key = number ? tiers.find(([tier]) => tier.toLowerCase() === numbered)?.[0] ?? numbered : "Other checks";
    const checks = byTier.get(key) ?? [];
    checks.push([id, verdict]);
    byTier.set(key, checks);
  }
  const tierIds = [...new Set([...tiers.map(([id]) => id), ...byTier.keys(),
    ...(report?.tiers.map((tier) => tier.id) ?? [])])];
  const widestTier = Math.max(1, ...tierIds.map((id) =>
    report?.tiers.find((tier) => tier.id === id)?.checks.length || byTier.get(id)?.length || 0,
  ));
  return <div className="qualification-package"
    style={{ "--qualification-check-width": `${100 / widestTier}%` } as CSSProperties}>
      {tierIds.length > 0 ? <ul className="qualification-tier-summaries" aria-label="Reported tier outcomes">
        {tierIds.map((id) => {
          const tier = report?.tiers.find((item) => item.id === id);
          const status = outcome(tier?.verdict ?? build.tier_verdicts?.[id]);
          const checks = tier?.checks.length
            ? [...tier.checks].sort((a, b) => checkOrder.compare(a.id, b.id))
            : (byTier.get(id) ?? []).map(([id, status]) => ({ id, status, name: id, index: undefined }));
          return <li key={id}>
            <Tooltip floating onOpen={() => setInspect(true)} label={`${id} · ${outcomes[status]}`}
              content={<TooltipContent heading={tier?.name ?? id} status={outcomes[status]}>
                <span>{id} · {checks.length} reported checks</span>
                {tier && Object.entries(tier.counts).some(([, count]) => count > 0) && <dl>
                  {Object.entries(tier.counts).filter(([, count]) => count > 0).map(([key, count]) =>
                    <div className="qualification-tooltip-count" key={key}><dt>{outcomes[outcome(key)]}</dt><dd>{count}</dd></div>)}
                </dl>}
              </TooltipContent>}><code>{tierLabel(id)}</code></Tooltip>
            <div className="qualification-check-strip">
              {checks.map((check) => {
                const state = outcome(check.status);
                const checkLabel = `${check.id} · ${outcomes[state]}`;
                return <Tooltip key={checks.filter((item) => item.id === check.id).length > 1 ? `${check.id}:${check.index}` : check.id} floating onOpen={() => setInspect(true)}
                  to={build.report_url ? qualificationCheckHref(build, id, check.index ?? check.id) : undefined}
                  triggerClassName="table-status" label={checkLabel} content={<TooltipContent heading={check.name === check.id ? check.id : `${check.id} · ${check.name}`} status={outcomes[state]}>
                    <dl><dt>Tier</dt><dd>{tier?.name ?? id}</dd><dt>Package</dt><dd>{label}</dd></dl>
                    {build.blocking_tests?.includes(check.id) && <span>Reported qualification blocker</span>}
                  </TooltipContent>}>
                  <span className="table-status qualification-check-block" data-outcome={state} aria-hidden="true"><BuildOutcomeIcon outcome={state} /></span>
                </Tooltip>;
              })}
              {!checks.length && <span className="qualification-check-fallback"><span className="table-status qualification-check-block" data-outcome={status} aria-hidden="true"><BuildOutcomeIcon outcome={status} /></span>{outcomes[status]}</span>}
            </div>
          </li>;
        })}
      </ul> : <span className="muted">Tier verdicts unreported</span>}
  </div>;
}

export function QualificationMatrix({ builds, fetcher, selected, performanceMeasurements }: {
  builds: Build[];
  fetcher: Fetcher;
  selected: Build | null;
  performanceMeasurements?: Map<Build, PerformanceData["measurements"]>;
}) {
  const title = useId();
  const selectedId = selected ? buildIdentity(selected) : null;
  const runs = new Map<string, Build[]>();
  for (const build of [...builds].sort((a, b) => Date.parse(b.generated_at) - Date.parse(a.generated_at))) {
    const key = build.run_id ? JSON.stringify([build.source_id, build.run_id, build.run_attempt]) : buildIdentity(build);
    const packages = runs.get(key) ?? [];
    packages.push(build);
    runs.set(key, packages);
  }

  const platforms = [...new Set(builds.map((build) => build.os))].sort((a, b) => {
    const order = (os: string) => os === "windows" ? 0 : os === "linux" ? 1 : 2;
    return order(a) - order(b) || a.localeCompare(b);
  });

  const sharedStable = builds.length > 0 && builds.every((build) => build.channel === "stable" && !build.gfx_family);

  function runDetails(build: Build) {
    const release = build.tag ?? "Unreported";
    return <Tooltip floating label={`Run details for ${release}`}
      content={<TooltipContent heading={release}>
        <dl><dt>Date</dt><dd>{buildDate(build)} UTC</dd><dt>Workflow run</dt><dd>{build.run_id ?? "Unreported"}</dd></dl>
      </TooltipContent>}>
      {release}
    </Tooltip>;
  }

  function publishing(packages: Build[]) {
    return <ul className="qualification-publishing" aria-label="Package publishing by platform">
      {platforms.map((os) => {
        const matches = packages.filter((build) => build.os === os);
        if (!matches.length) return null;
        const known = matches.filter((build) => build.published != null);
        const published = known.filter((build) => build.published).length;
        return <li key={os}>{platformName(os)} · {known.length ? `${published}/${known.length} published` : "Publishing unreported"}
          {known.length > 0 && known.length < matches.length && ` · ${matches.length - known.length} unreported`}
        </li>;
      })}
    </ul>;
  }

  function platformCells(members: Build[], details: boolean) {
    return platforms.map((os) => {
      const matches = members.filter((item) => item.os === os);
      return <td key={os} data-selected={matches.some((item) => buildIdentity(item) === selectedId) || undefined}>
        {!matches.length && <span className="muted" aria-label="No retained package">—</span>}
        {details && matches.length > 0 && <div className="qualification-shared-details">
          <PackageDetails heading={platformName(os)} packages={matches}
            coverageFetcher={matches.some((item) => item.channel === "stable" && !item.gfx_family) ? fetcher : undefined} />
        </div>}
        {matches.map((item) => <div key={buildIdentity(item)} className="qualification-archive">
          <PackageCell build={item} fetcher={fetcher} selected={buildIdentity(item) === selectedId} />

        </div>)}
      </td>;
    });
  }

  const checkLegend = <ul className="qualification-check-legend" aria-label="Check outcomes">
      {(Object.keys(outcomes) as Outcome[]).map((state) => <li key={state}>
        <span className="table-status qualification-check-block" data-outcome={state} aria-hidden="true"><BuildOutcomeIcon outcome={state} /></span>{outcomes[state]}
      </li>)}
    </ul>;

  return <section aria-labelledby={title} className="qualification-matrix">
    <h2 id={title}>Package qualification</h2>
    {builds.length === 0 ? <p role="status">No retained packages match this scope.</p> :
      <div className="qualification-releases" role="region" aria-label="Qualification by release workflow run">
        {sharedStable ? <><div className="qualification-table-scroll" role="region" aria-label="Stable packages by build" tabIndex={0}>
          <table className="qualification-table qualification-stable-table" data-multiple-platforms={platforms.length > 1 || undefined}>
            <thead><tr>
              <th scope="col" className="qualification-family-column">Build</th>
              {platforms.map((os) => <th scope="col" key={os}>{platformName(os)}</th>)}
            </tr></thead>
            <tbody>{[...runs].map(([key, packages]) => <tr key={key}>
              <th scope="row">
                <PackageDetails heading={packages[0].tag ?? "Unreported"} packages={packages} coverageFetcher={fetcher} run={packages[0]} performanceMeasurements={performanceMeasurements} />
                {publishing(packages)}
              </th>
              {platformCells(packages, false)}
            </tr>)}</tbody>
          </table>
        </div>
        {checkLegend}</> : [...runs].map(([key, packages]) => {
          const [build] = packages;
          const release = build.tag ?? "Unreported";
          const families = new Map<string, Build[]>();
          for (const item of packages) {
            const family = item.gfx_family ?? "";
            const members = families.get(family) ?? [];
            members.push(item);
            families.set(family, members);
          }
          const showFamilies = [...families.keys()].some(Boolean);
          const showSharedCoverage = packages.some((item) => item.channel === "stable" && !item.gfx_family);
          return <section className="qualification-release" key={key}>
            <header className="qualification-release-heading">
              <span className="qualification-heading-label">Build</span>
              <h3>{runDetails(build)}</h3>
              {publishing(packages)}
            </header>
            <div className="qualification-table-scroll" role="region" aria-label={`Packages for ${release}`} tabIndex={0}>
              <table className="qualification-table" data-multiple-platforms={platforms.length > 1 || undefined}>
                <thead>
                  <tr>
                    {showFamilies && <th scope="col" className="qualification-family-column">GPU family</th>}
                    {platforms.map((os) => {
                      const platform = platformName(os);
                      const matches = packages.filter((item) => item.os === os);
                      return <th scope="col" key={os}>
                        {!showFamilies && matches.length ? <PackageDetails heading={platform} packages={matches} coverageFetcher={showSharedCoverage ? fetcher : undefined} /> : platform}
                      </th>;
                    })}
                  </tr>
                </thead>
                <tbody>
                  {[...families].sort(([a], [b]) => checkOrder.compare(a, b)).map(([family, members]) =>
                    <tr key={family}>
                      {showFamilies && <th scope="row">
                        {family ? <PackageDetails heading={family} packages={members} performanceMeasurements={performanceMeasurements} /> : "Shared archive"}
                      </th>}
                      {platformCells(members, showFamilies && !family)}
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            {checkLegend}
          </section>;
        })}
      </div>}

  </section>;
}
