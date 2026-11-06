import { useEffect, useId, useState, type CSSProperties } from "react";
import { Link } from "react-router";
import type { Build, Fetcher } from "../data";
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

function PackageDetails({ heading, packages, coverageFetcher, run }: {
  heading: string;
  packages: Build[];
  coverageFetcher?: Fetcher;
  run?: Build;
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

  const evidence = coverage?.packages === packages ? coverage.targets : undefined;
  return <Tooltip floating interactive label={run ? `Run details for ${heading}` : `Package details for ${heading}`}
    onOpen={() => setInspect(true)}
    content={<TooltipContent heading={heading}>
      {run && <dl><dt>Date</dt><dd>{buildDate(run)} UTC</dd><dt>Workflow run</dt><dd>{run.run_id ?? "Unreported"}</dd></dl>}
      <ul className="qualification-popup-packages">
        {packages.map((build) => {
          const targets = evidence?.get(build);
          return <li key={buildIdentity(build)}>
            <Link to={exactBuildHref(build, "build")} aria-label={`Package report for ${build.build_id}`}>
              {platformName(build.os)} report →
            </Link>
            <dl><dt>Build ID</dt><dd>{build.build_id}</dd>{build.artifact && <><dt>Archive</dt><dd>{build.artifact}</dd></>}</dl>
            {coverageFetcher && <div className="qualification-compiled-targets">
              <strong>Compiled GPU targets</strong>
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
  </Tooltip>;
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

export function QualificationMatrix({ builds, fetcher, selected }: {
  builds: Build[];
  fetcher: Fetcher;
  selected: Build | null;
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

  return <section aria-labelledby={title} className="qualification-matrix">
    <h2 id={title}>Package qualification</h2>
    {builds.length === 0 ? <p role="status">No retained packages match this scope.</p> :
      <div className="qualification-releases" role="region" aria-label="Qualification by release workflow run">
        {sharedStable ? <div className="qualification-table-scroll" role="region" aria-label="Stable packages by build" tabIndex={0}>
          <table className="qualification-table qualification-stable-table" data-multiple-platforms={platforms.length > 1 || undefined}>
            <thead><tr>
              <th scope="col" className="qualification-family-column">Build</th>
              {platforms.map((os) => <th scope="col" key={os}>{platformName(os)}</th>)}
            </tr></thead>
            <tbody>{[...runs].map(([key, packages]) => <tr key={key}>
              <th scope="row">
                <PackageDetails heading={packages[0].tag ?? "Unreported"} packages={packages} coverageFetcher={fetcher} run={packages[0]} />
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
                        {family ? <PackageDetails heading={family} packages={members} /> : "Shared archive"}
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
    {builds.length > 0 && <ul className="qualification-check-legend" aria-label="Check outcomes">
      {(Object.keys(outcomes) as Outcome[]).map((state) => <li key={state}>
        <span className="table-status qualification-check-block" data-outcome={state} aria-hidden="true"><BuildOutcomeIcon outcome={state} /></span>{outcomes[state]}
      </li>)}
    </ul>}
  </section>;
}
