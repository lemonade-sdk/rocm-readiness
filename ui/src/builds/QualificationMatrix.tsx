import { useEffect, useId, useState, type CSSProperties } from "react";
import { matchedPerformanceObservations, PerformancePreview } from "../performance/PerformancePreview";
import { PlatformIcon } from "../PlatformIcon";
import type { Build, Fetcher } from "../data";
import type { PerformanceData } from "../performance/PerformanceView";
import { BuildOutcomeIcon } from "../overview/BuildOutcomeIcon";
import { Tooltip, TooltipContent } from "../overview/Tooltip";
import { buildDate, buildIdentity } from "../overview/buildTimeline";
import { checkOrder, pinnedReport, QualificationCheckEvidence, readQualificationReport, ReportEvidence } from "./BuildBrowser";
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

function buildRepository(build: Build) {
  return build.source_url?.match(/^https:\/\/raw\.githubusercontent\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/[a-f0-9]{40}\/qualification\/index\.json$/)?.[1];
}

function PackageDetails({ heading, packages, coverageFetcher, run, performanceMeasurements, initialOpen = false, dataCommit }: {
  heading: string;
  packages: Build[];
  coverageFetcher?: Fetcher;
  run?: Build;
  initialOpen?: boolean;
  dataCommit?: string | null;
  performanceMeasurements?: Map<Build, PerformanceData["measurements"]>;
}) {
  const [inspect, setInspect] = useState(initialOpen);
  const [evidence, setEvidence] = useState<Map<Build, Report>>();
  useEffect(() => {
    if (!inspect || !coverageFetcher) return;
    const controller = new AbortController();
    void Promise.allSettled(packages.map(async (build) =>
      [build, await readQualificationReport(build, controller.signal, coverageFetcher)] as const,
    )).then((reports) => {
      if (!controller.signal.aborted) setEvidence(new Map(reports.flatMap((report) =>
        report.status === "fulfilled" ? [report.value] : [],
      )));
    });
    return () => controller.abort();
  }, [packages, inspect, coverageFetcher]);

  const observations = matchedPerformanceObservations(packages, performanceMeasurements);
  const hasPerformance = observations.length > 0;
  return <><Tooltip floating interactive contentClassName="qualification-popup" label={run ? `Run details for ${heading}` : `Package details for ${heading}`}
    initialOpen={initialOpen} onOpen={() => setInspect(true)}
    content={<TooltipContent heading={heading}>
      {run && <dl><dt>Date</dt><dd>{buildDate(run)} UTC</dd><dt>Workflow run</dt><dd>
        {run.run_id && buildRepository(run) ? <a href={`https://github.com/${buildRepository(run)}/actions/runs/${encodeURIComponent(run.run_id)}`} target="_blank" rel="noreferrer">{run.run_id} ↗</a> : run.run_id ?? "Unreported"}
      </dd></dl>}
      <ul className="qualification-popup-packages">
        {[...packages].sort((a, b) => (a.os === "windows" ? 0 : 1) - (b.os === "windows" ? 0 : 1)).map((build) => {
          const report = evidence?.get(build);
          const gfx = report?.raw.gfx;
          const present = gfx && typeof gfx === "object" && "present_in_binary" in gfx ? gfx.present_in_binary : null;
          const targets = Array.isArray(present) && present.every((target) => typeof target === "string" && /^gfx[0-9a-z]+$/i.test(target))
            ? [...new Set<string>(present)].sort(checkOrder.compare) : null;
          const reference = pinnedReport(build);
          const repository = buildRepository(build);
          return <li key={buildIdentity(build)}>
            <h4 className="qualification-platform-heading">
              <PlatformIcon platform={build.os} /> {platformName(build.os)}
            </h4>
            <dl className="qualification-package-metadata">
              <dt>Feed build ID</dt><dd>{build.build_id}</dd>
              <dt>Source</dt><dd>{build.source_id ?? "Unreported"}</dd>
              <dt>Package tag</dt><dd>{build.published === true && build.tag && repository
                ? <a href={`https://github.com/${repository}/releases/tag/${encodeURIComponent(build.tag)}`} target="_blank" rel="noreferrer">{build.tag} ↗</a>
                : build.tag ?? "Unreported"}</dd>
              <dt>Qualification</dt><dd>{build.qualified === true ? "Qualified" : build.qualified === false ? "Failed qualification" : "Unreported"}</dd>
              <dt>Produced</dt><dd>{build.generated_at}</dd>
              {dataCommit && <><dt>Dataset revision</dt><dd><code title={dataCommit}>{dataCommit.slice(0, 12)}</code></dd></>}
              <dt>ROCm SDK</dt><dd>{build.producer_rocm_version ?? build.rocm_version}</dd>
              {build.upstream_sha && <><dt>Upstream SHA</dt><dd>{build.engine === "llamacpp" ? <a href={`https://github.com/ggml-org/llama.cpp/commit/${encodeURIComponent(build.upstream_sha)}`} target="_blank" rel="noreferrer"><code title={build.upstream_sha}>{build.upstream_sha.slice(0, 12)} ↗</code></a> : <code title={build.upstream_sha}>{build.upstream_sha.slice(0, 12)}</code>}</dd></>}
              {!run && build.run_id && repository && <><dt>Workflow run</dt><dd><a href={`https://github.com/${repository}/actions/runs/${encodeURIComponent(build.run_id)}`} target="_blank" rel="noreferrer">{build.run_id} ↗</a></dd></>}
              {build.artifact && <><dt>Archive</dt><dd>{build.artifact}</dd></>}
            </dl>
            {typeof reference !== "string" && <ul className="qualification-source-links" aria-label="Pinned sources">
              <li><a href={reference.url} target="_blank" rel="noreferrer">Pinned producer report ↗</a></li>
              {build.source_url && <li><a href={build.source_url} target="_blank" rel="noreferrer">Pinned feed source ↗</a></li>}
            </ul>}
            {coverageFetcher && <div className="qualification-compiled-targets">
              <h5>Compiled GPU targets</h5>
              {targets?.length ? <ul aria-label="Compiled GPU targets">
                {targets.map((target) => <li key={target}><code>{target}</code></li>)}
              </ul> : <span className="muted">{!evidence ? "Loading…" : targets ? "None recorded" :
                build.gfx?.present != null ? `${build.gfx.present} compiled · exact list unavailable` : "Unavailable"}</span>}
            </div>}
            {coverageFetcher && build.hardware_validated && build.gfx_target &&
              <p className="qualification-runtime muted">Runtime validated on <code>{build.gfx_target}</code></p>}
            {report ? <ReportEvidence report={report} summaryOnly /> : evidence && typeof reference !== "string" &&
              <p className="muted">Pinned producer summary unavailable.</p>}
          </li>;
        })}
      </ul>
    </TooltipContent>}>
    {heading}
  </Tooltip>
  {hasPerformance && <PerformancePreview heading={heading}
    observations={observations} />}
  </>;
}

type CheckLink = { tier: string; check: string; revision: string | null };

function PackageCell({ build, selected, fetcher, checkLink }: {
  build: Build;
  selected: boolean;
  checkLink?: CheckLink;
  fetcher: Fetcher;
}) {
  const [inspect, setInspect] = useState(selected);
  const [report, setReport] = useState<Report>();
  const [reportUnavailable, setReportUnavailable] = useState(false);
  useEffect(() => {
    if (!inspect || !build.report_url) return;
    const controller = new AbortController();
    readQualificationReport(build, controller.signal, fetcher).then(
      (evidence) => { if (!controller.signal.aborted) setReport(evidence); },
      () => { if (!controller.signal.aborted) setReportUnavailable(true); },
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
            ? tier.checks
            : (byTier.get(id) ?? []).map(([id, status]) => ({ id, status, name: id, index: undefined, evidence: undefined }));
          return <li key={id}>
            <code title={tier?.name} aria-label={`${tierLabel(id)} · ${outcomes[status]}`}>{tierLabel(id)}</code>
            <div className="qualification-check-strip">
              {checks.map((check) => {
                const state = outcome(check.status);
                const checkLabel = `${check.id} · ${outcomes[state]}`;
                const duplicate = checks.filter((item) => item.id === check.id).length > 1;
                const linked = checkLink && id.toLowerCase() === checkLink.tier.toLowerCase() &&
                  (checkLink.check === `id:${check.id}` ? !duplicate : checkLink.check === String(check.index));
                return <Tooltip key={JSON.stringify([duplicate ? `${check.id}:${check.index}` : check.id, Boolean(linked)])}
                  initialOpen={Boolean(linked)} floating contentClassName="qualification-popup" onOpen={() => setInspect(true)}
                  triggerClassName="table-status" label={checkLabel} content={<TooltipContent heading={check.name === check.id ? check.id : `${check.id} · ${check.name}`} status={outcomes[state]}>
                    <dl><dt>Tier</dt><dd>{tier?.name ?? id}</dd><dt>Package</dt><dd>{label}</dd></dl>
                    {check.evidence ? <QualificationCheckEvidence evidence={check.evidence} /> :
                      build.report_url && <span>{reportUnavailable || report ? "Pinned check details unavailable" : "Loading pinned check details…"}</span>}
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

export function QualificationMatrix({ builds, fetcher, selected, performanceMeasurements, openPackage, dataCommit, checkLink }: {
  builds: Build[];
  fetcher: Fetcher;
  selected: Build | null;
  openPackage?: boolean;
  checkLink?: CheckLink;
  dataCommit?: string | null;
  performanceMeasurements?: Map<Build, PerformanceData["measurements"]>;
}) {
  const title = useId();
  const selectedId = selected ? buildIdentity(selected) : null;
  const reference = selected && checkLink?.revision ? pinnedReport(selected) : null;
  const revisionMismatch = checkLink?.revision && (typeof reference === "string" || reference?.commit !== checkLink.revision);
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

  const opens = (packages: Build[]) => Boolean(openPackage && selected && packages.includes(selected));
  const sharedStable = builds.length > 0 && builds.every((build) => build.channel === "stable" && !build.gfx_family);

  function runDetails(build: Build) {
    const release = build.tag ?? "Unreported";
    return <Tooltip floating contentClassName="qualification-popup" label={`Run details for ${release}`}
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
            key={String(opens(matches))} initialOpen={opens(matches)} dataCommit={dataCommit} coverageFetcher={fetcher} />
        </div>}
        {matches.map((item) => <div key={buildIdentity(item)} className="qualification-archive">
          <PackageCell build={item} fetcher={fetcher} selected={buildIdentity(item) === selectedId}
            checkLink={!revisionMismatch && buildIdentity(item) === selectedId ? checkLink : undefined} />

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
    {revisionMismatch && <p role="status">This check link points to a different producer report revision.</p>}
    {builds.length === 0 ? <p role="status">No retained packages match this scope.</p> :
      <div className="qualification-releases" role="region" aria-label="Qualification by release workflow run">
        {checkLegend}
        {sharedStable ? <div className="qualification-table-scroll" role="region" aria-label="Stable packages by build" tabIndex={0}>
          <table className="qualification-table qualification-stable-table" data-multiple-platforms={platforms.length > 1 || undefined}>
            <thead><tr>
              <th scope="col" className="qualification-family-column">Build</th>
              {platforms.map((os) => <th scope="col" key={os}>{platformName(os)}</th>)}
            </tr></thead>
            <tbody>{[...runs].map(([key, packages]) => <tr key={key}>
              <th scope="row">
                <PackageDetails heading={packages[0].tag ?? "Unreported"} packages={packages} key={String(opens(packages))} initialOpen={opens(packages)} dataCommit={dataCommit} coverageFetcher={fetcher} run={packages[0]} performanceMeasurements={performanceMeasurements} />
                {publishing(packages)}
              </th>
              {platformCells(packages, false)}
            </tr>)}</tbody>
          </table>
        </div> : [...runs].map(([key, packages]) => {
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
                        {!showFamilies && matches.length ? <PackageDetails heading={platform} packages={matches} key={String(opens(matches))} initialOpen={opens(matches)} dataCommit={dataCommit} coverageFetcher={fetcher} /> : platform}
                      </th>;
                    })}
                  </tr>
                </thead>
                <tbody>
                  {[...families].sort(([a], [b]) => checkOrder.compare(a, b)).map(([family, members]) =>
                    <tr key={family}>
                      {showFamilies && <th scope="row">
                        {family ? <PackageDetails heading={family} packages={members} key={String(opens(members))} initialOpen={opens(members)} dataCommit={dataCommit} coverageFetcher={fetcher} performanceMeasurements={performanceMeasurements} /> : "Shared archive"}
                      </th>}
                      {platformCells(members, showFamilies && !family)}
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>;
        })}
      </div>}

  </section>;
}
