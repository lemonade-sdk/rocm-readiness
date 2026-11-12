import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useBuildMeasurements } from "./useBuildMeasurements";
import { matchedPerformanceObservations, PerformancePreview } from "../performance/PerformancePreview";
import type { PerformanceData } from "../performance/PerformanceView";
import type { Build, Fetcher, Session } from "../data";
import { buildIdentity, exactBuildHref } from "../overview/buildTimeline";
import "./BuildBrowser.css";

type BuildBrowserProps = {
  fetcher?: Fetcher;
  session: Session;
  history: Build[] | null;
  platform: string;
  selectedBuildId: string | null;
  selectedSourceId?: string | null;
  selectedTierId?: string | null;
  selectedCheckIndex?: string | null;
  selectedReportCommit?: string | null;
  buildHref: (build: Build) => string;
  onPlatformChange: (platform: string) => void;
  query?: string;
  onQueryChange?: (query: string) => void;
};

type JsonRecord = Record<string, unknown>;

type PinnedReport = {
  url: string;
  commit: string;
  file: string;
};

type QualificationCheck = {
  index: number;
  id: string;
  name: string;
  status: string;
  evidence: JsonRecord;
};

type QualificationTier = {
  id: string;
  name: string;
  verdict: string;
  counts: Record<string, number>;
  checks: QualificationCheck[];
};

export type QualificationReport = {
  raw: JsonRecord;
  build: JsonRecord;
  tiers: QualificationTier[];
};

type CheckSelection = { tier: string; index: string; commit: string | null };

type ReportState =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "ready"; report: QualificationReport }
  | { state: "error"; message: string };

const reportUrlPattern =
  /^https:\/\/raw\.githubusercontent\.com\/([A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_][A-Za-z0-9_.-]*)\/([a-f0-9]{40})\/qualification\/reports\/([A-Za-z0-9][A-Za-z0-9_.-]*\.json)$/;
const sourceUrlPattern =
  /^https:\/\/raw\.githubusercontent\.com\/([A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_][A-Za-z0-9_.-]*)\/([a-f0-9]{40})\/qualification\/index\.json$/;
const checkIdPattern = /^T\d+(?:\.\d+)*$/;
export const checkOrder = new Intl.Collator("en", { numeric: true });

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function status(value: unknown) {
  return text(value) ?? "unavailable";
}

function sourceName(build: Build) {
  return build.source_id ?? "Source identifier unavailable";
}

function buildLinkLabel(build: Build) {
  return `Open build ${build.build_id} from ${sourceName(build)} on ${displayPlatform(build.os)}`;
}

function displayPlatform(value: string) {
  if (value === "linux") return "Linux";
  if (value === "windows") return "Windows";
  return value;
}

function canonicalPlatform(value: string) {
  const normalized = value.toLowerCase();
  if (normalized === "linux" || normalized === "ubuntu") return "linux";
  if (normalized === "windows" || normalized === "win") return "windows";
  return normalized;
}

function date(value: string) {
  return (
    new Intl.DateTimeFormat("en", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "UTC",
    }).format(new Date(value)) + " UTC"
  );
}

function qualification(build: Build) {
  if (build.qualified === true) return "Producer qualified";
  if (build.qualified === false) return "Producer did not qualify";
  return "Producer qualification unknown";
}

function hardwareValidation(build: Build) {
  if (build.hardware_validated === true)
    return `Hardware validation recorded${build.gfx_target ? ` on ${build.gfx_target}` : ""}`;
  if (build.hardware_validated === false)
    return "No hardware validation recorded";
  return "Hardware validation unknown";
}

function compiledTargets(build: Build) {
  if (!build.gfx) return "Compiled-target evidence unavailable";
  const missing = build.gfx.missing.length
    ? `; missing ${build.gfx.missing.join(", ")}`
    : "";
  return `${build.gfx.present} of ${build.gfx.requested} requested targets compiled${missing}`;
}

export function pinnedReport(build: Build): PinnedReport | string {
  if (!build.report_url)
    return "This retained build has no producer report URL.";
  const match = build.report_url.match(reportUrlPattern);
  if (!match)
    return "The producer report URL is not a pinned qualification report.";
  const [, repository, commit, file] = match;
  const producerId = build.channel === "nightly" ? build.build_id.replace(/@\d+$/, "") : build.build_id;
  if (file !== `${build.build_id}.json` && file !== `${producerId}.json`)
    return "The pinned report filename does not match the selected feed build ID.";
  const source = build.source_url?.match(sourceUrlPattern);
  const legacyRepository = repository === "lemonade-sdk/llama.cpp" ||
    (build.channel === "nightly" && repository === "lemonade-sdk/llamacpp-rocm");
  if (build.source_url ? source?.[1] !== repository || source[2] !== commit : !legacyRepository)
    return "The selected feed source does not match the pinned producer report commit.";
  return { url: build.report_url, commit, file };
}

export function findSelectedBuild(
  history: Build[] | null,
  buildId: string | null,
  platform: string,
  selectedSourceId: string | null | undefined,
):
  | { kind: "selected"; build: Build }
  | { kind: "missing"; message: string }
  | { kind: "ambiguous"; message: string }
  | null {
  if (buildId === null || history === null) return null;
  let matches = history.filter((build) => build.build_id === buildId);
  if (platform !== "all")
    matches = matches.filter((build) => build.os === platform);
  if (selectedSourceId !== undefined && selectedSourceId !== null)
    matches = matches.filter((build) => build.source_id === selectedSourceId);
  if (!matches.length)
    return {
      kind: "missing",
      message:
        "The requested build identity is not present for this platform and source.",
    };
  if (matches.length > 1)
    return {
      kind: "ambiguous",
      message:
        "The requested build identity is ambiguous. Choose a specific platform and source before opening report evidence.",
    };
  return { kind: "selected", build: matches[0] };
}

export function qualificationCheckHref(build: Build, tierId: string, checkIndex?: number | string): string {
  const params = new URLSearchParams(exactBuildHref(build, "build").slice(1));
  params.set("package_identity", buildIdentity(build));
  params.set("tier", tierId);
  if (checkIndex != null) params.set("check", typeof checkIndex === "number" ? String(checkIndex) : `id:${checkIndex}`);
  const reference = pinnedReport(build);
  if (typeof reference !== "string") params.set("report_commit", reference.commit);
  return `?${params}`;
}

function qualificationTiers(tiers: JsonRecord, prepared = false): QualificationTier[] {
  return Object.entries(tiers).flatMap(([id, tier]) => {
    if (!isRecord(tier)) return [];
    const counts: Record<string, number> = {};
    if (isRecord(tier.counts)) {
      for (const [key, value] of Object.entries(tier.counts)) {
        if (typeof value === "number" && Number.isInteger(value) && value >= 0) counts[key] = value;
      }
    }
    const tests: unknown[] = Array.isArray(tier.tests) ? tier.tests : [];
    const checks = tests.flatMap((test, index) => {
      if (!isRecord(test)) return [];
      const sourceIndex = prepared && typeof test.source_index === "number" &&
        Number.isInteger(test.source_index) && test.source_index >= 0 ? test.source_index : index;
      return [{
        index: sourceIndex,
        id: text(test.id) ?? `${id}.${sourceIndex + 1}`,
        name: text(test.name) ?? "Unnamed test",
        status: status(test.status),
        evidence: test,
      }];
    });
    const known = (check: QualificationCheck) => checkIdPattern.test(text(check.evidence.id) ?? "");
    if (!prepared) checks.sort((a, b) => known(a) && known(b) ? checkOrder.compare(a.id, b.id) : Number(known(b)) - Number(known(a)));
    return [{ id, name: text(tier.tier_name) ?? id, verdict: status(tier.status), counts, checks }];
  });
}

function reportMetadata(
  report: JsonRecord,
  build: Build,
  pinned: PinnedReport,
  prepared = false,
) {
  const reportBuild = report.build;
  if (!isRecord(reportBuild))
    throw new Error("Producer report is missing build metadata.");
  const reportOs = text(reportBuild.os);
  const reportVersion = text(reportBuild.rocm_version);
  const reportTag = text(reportBuild.llamacpp_tag) ?? text(reportBuild.release_tag) ?? text(reportBuild.tag);
  if (!reportOs || canonicalPlatform(reportOs) !== canonicalPlatform(build.os))
    throw new Error("Producer report OS does not match the selected feed row.");
  if (!reportVersion || reportVersion !== (build.producer_rocm_version ?? build.rocm_version))
    throw new Error(
      "Producer report ROCm version does not match the selected feed row.",
    );
  if ((reportTag ?? null) !== (build.tag ?? null) || (!build.tag && build.channel !== "nightly"))
    throw new Error(
      "Producer report package tag does not match the selected feed row.",
    );
  const reportArtifact = text(reportBuild.artifact);
  if (build.artifact && reportArtifact && reportArtifact !== build.artifact)
    throw new Error(
      "Producer report artifact does not match the selected feed row.",
    );
  const reportRunId = text(reportBuild.run_id);
  if (build.run_id && reportRunId && reportRunId !== build.run_id)
    throw new Error(
      "Producer report run ID does not match the selected feed row.",
    );
  const reportAttempt = reportBuild.run_attempt;
  if (build.run_attempt != null && reportAttempt != null && String(reportAttempt) !== String(build.run_attempt))
    throw new Error("Producer report attempt does not match the selected feed row.");
  const reportUpstreamSha = text(reportBuild.upstream_sha);
  if (
    build.upstream_sha &&
    reportUpstreamSha &&
    reportUpstreamSha !== build.upstream_sha
  )
    throw new Error(
      "Producer report upstream SHA does not match the selected feed row.",
    );
  const tiers = report.tiers;
  if (!isRecord(tiers))
    throw new Error("Producer report is missing tier evidence.");
  if (!pinned.commit || !pinned.file)
    throw new Error("Pinned producer report metadata is incomplete.");
  return { raw: report, build: reportBuild, tiers: qualificationTiers(tiers, prepared) };
}

export async function readQualificationReport(
  build: Build,
  signal: AbortSignal,
  fetcher: Fetcher = fetch,
): Promise<QualificationReport> {
  const reference = pinnedReport(build);
  if (typeof reference === "string") throw new Error(reference);
  if (build.report_snapshot) {
    const referenceSnapshot = build.report_snapshot;
    if (referenceSnapshot.source_url !== reference.url) throw new Error("Collected report does not match the pinned producer report.");
    if (!referenceSnapshot.url) throw new Error("Collected report dataset URL is unavailable.");
    const response = await fetcher(referenceSnapshot.url, { cache: "no-store", signal });
    if (!response.ok) throw new Error(`Collected report request failed: HTTP ${response.status}.`);
    const snapshot: unknown = await response.json();
    if (!isRecord(snapshot) || snapshot.source_url !== reference.url) throw new Error("Collected report source does not match the pinned producer report.");
    if (typeof snapshot.error === "string") throw new Error(`Report collection failed: ${snapshot.error}`);
    if (!isRecord(snapshot.report)) throw new Error("Collected report is missing evidence.");
    return reportMetadata(snapshot.report, build, reference, true);
  }
  const response = await fetcher(reference.url, { cache: "no-store", signal });
  if (!response.ok) throw new Error(`Producer report request failed: HTTP ${response.status}.`);
  const raw: unknown = await response.json();
  if (!isRecord(raw)) throw new Error("Producer report is not valid JSON evidence.");
  return reportMetadata(raw, build, reference);
}

function summary(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  )
    return String(value);
  if (Array.isArray(value))
    return value.map((entry) => summary(entry)).join(", ");
  try {
    return JSON.stringify(value);
  } catch {
    return "Unserializable evidence";
  }
}

function duration(test: JsonRecord) {
  const milliseconds = test.duration_ms;
  if (typeof milliseconds === "number") return `${milliseconds} ms`;
  const seconds = test.duration_seconds;
  if (typeof seconds === "number") return `${seconds} s`;
  return "Not recorded";
}

// Labels and evidence selection belong to downstream collection CI. Legacy
// reports retain their raw audit details without a synthesized summary.
function displayEvidence(test: JsonRecord) {
  if (!Array.isArray(test.display_evidence)) return [];
  return test.display_evidence.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const label = text(entry.label);
    const value = summary(entry.value);
    return label && value ? [{ label, value }] : [];
  });
}

export function QualificationCheckEvidence({ evidence: test }: { evidence: JsonRecord }) {
  const reason = summary(test.error ?? test.reason);
  const details = isRecord(test.details) ? test.details : {};
  return <dl>
    {displayEvidence(test).map(({ label, value }, index) => <div key={index} className="qualification-tooltip-count">
      <dt>{label}</dt><dd>{value}</dd>
    </div>)}
    {typeof test.gating === "boolean" && <><dt>Scope</dt><dd>{test.gating ? "Gating" : "Informational"}</dd></>}
    {(typeof test.duration_ms === "number" || typeof test.duration_seconds === "number") &&
      <><dt>Duration</dt><dd>{duration(test)}</dd></>}
    {reason && <><dt>Reason / error</dt><dd>{reason}</dd></>}
    {Object.entries({
      compatibility: test.compatibility,
      runtime: test.runtime,
      gpu_offload: test.gpu_offload,
      gpu_proof: test.gpu_proof,
      requested_offload_line: test.requested_offload_line,
      ...details,
    }).map(([key, value]) => {
      const rendered = summary(value);
      return rendered && <div key={key} className="qualification-tooltip-count">
        <dt>{key.replaceAll("_", " ")}</dt><dd>{rendered}</dd>
      </div>;
    })}
  </dl>;
}

function ReportTests({ tiers, selection }: { tiers: QualificationTier[]; selection?: CheckSelection }) {
  const focusedRow = useRef<HTMLTableRowElement>(null);
  const checkId = selection?.index.startsWith("id:") ? selection.index.slice(3) : null;
  const matches = checkId == null ? [] : tiers.flatMap((tier) =>
    tier.id.toLowerCase() === selection?.tier.toLowerCase() || selection?.tier === "Other checks"
      ? tier.checks.filter((check) => check.id === checkId).map((check) => ({ tier: tier.id, index: String(check.index) }))
      : [],
  );
  const selectedTier = checkId == null ? selection?.tier : matches.length === 1 ? matches[0].tier : undefined;
  const selectedIndex = checkId == null ? selection?.index : matches.length === 1 ? matches[0].index : undefined;
  const hasSelectedCheck = tiers.some((tier) => tier.id === selectedTier &&
    tier.checks.some((check) => String(check.index) === selectedIndex));

  useEffect(() => {
    focusedRow.current?.focus();
  }, [selectedTier, selectedIndex, tiers]);

  if (!tiers.length && !selection)
    return (
      <p className="build-browser-muted">
        No producer test tiers were recorded.
      </p>
    );
  return (
    <div className="build-browser-tiers">
      {selection && !hasSelectedCheck && <p role="status">This check is unavailable in the pinned report.</p>}
      {tiers.map((tier) => {
        return (
          <section className="build-browser-tier" key={tier.id}>
            <div className="build-browser-tier-heading">
              <div>
                <span className="build-browser-kicker">{tier.id}</span>
                <h3>{tier.name}</h3>
              </div>
              <span
                className={`build-browser-status status-${tier.verdict}`}
              >
                {tier.verdict}
              </span>
            </div>
            {Object.keys(tier.counts).length > 0 && (
              <p className="build-browser-muted">
                {Object.entries(tier.counts)
                  .map(([name, count]) => `${name}: ${summary(count)}`)
                  .join(" · ")}
              </p>
            )}
            {tier.checks.length ? (
              <div className="build-browser-table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th scope="col">Test</th>
                      <th scope="col">Status</th>
                      <th scope="col">Gating</th>
                      <th scope="col">Duration</th>
                      <th scope="col">Reason / error</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tier.checks.map((check) => {
                      const test = check.evidence;
                      const focused = tier.id === selectedTier && String(check.index) === selectedIndex;
                      const details = isRecord(test.details) ? test.details : null;
                      const error = summary(test.error ?? test.reason);
                      return (
                        <tr key={check.index} ref={focused ? focusedRow : undefined}
                          tabIndex={focused ? -1 : undefined} aria-current={focused ? "true" : undefined}>
                          <th scope="row">
                            <strong>{check.id}</strong>{" "}
                            {check.name}
                            {displayEvidence(test).map(({ label, value }, index) => (
                              <p key={index} className="build-browser-evidence"><strong>{label}:</strong> {value}</p>
                            ))}
                            {details && Object.keys(details).length > 0 && (
                              <details>
                                <summary>Audit details</summary>
                                <pre>{JSON.stringify(details, null, 2)}</pre>
                              </details>
                            )}
                          </th>
                          <td>
                            <span
                              className={`build-browser-status status-${check.status}`}
                            >
                              {check.status}
                            </span>
                          </td>
                          <td>
                            {test.gating === true ? "Gating" : "Informational"}
                          </td>
                          <td>{duration(test)}</td>
                          <td>{error ?? "—"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="build-browser-muted">
                No individual tests were recorded.
              </p>
            )}
          </section>
        );
      })}
    </div>
  );
}

export function ReportEvidence({ report, selection, summaryOnly = false }: { report: QualificationReport; selection?: CheckSelection; summaryOnly?: boolean }) {
  const promotion = isRecord(report.raw.promotion)
    ? report.raw.promotion
    : null;
  const blockedBy = summary(promotion?.blocked_by ?? report.raw.blocked_by);
  const reportGfx = isRecord(report.raw.gfx) ? report.raw.gfx : null;
  const requested = Array.isArray(reportGfx?.requested)
    ? reportGfx.requested.length
    : null;
  const present = Array.isArray(reportGfx?.present_in_binary)
    ? reportGfx.present_in_binary.length
    : null;
  const heading = useId();
  return (
    <section
      className="build-browser-report"
      aria-labelledby={heading}
    >
      <div className="build-browser-tier-heading">
        <div>
          <span className="build-browser-kicker">PINNED PRODUCER REPORT</span>
          <h3 id={heading}>Qualification evidence</h3>
        </div>
        <span
          className={`build-browser-status status-${status(report.raw.overall)}`}
        >
          {status(report.raw.overall)}
        </span>
      </div>
      <dl className="build-browser-report-summary">
        <div>
          <dt>Producer internal record ID</dt>
          <dd>{text(report.build.build_id) ?? "Not recorded"}</dd>
        </div>
        <div>
          <dt>Promotion</dt>
          <dd>
            {report.raw.promoted === true
              ? "Promoted"
              : report.raw.promoted === false
                ? "Not promoted"
                : "Not recorded"}
          </dd>
        </div>
        <div>
          <dt>Blocked by</dt>
          <dd>{blockedBy || "No blocking tiers recorded"}</dd>
        </div>
        <div>
          <dt>Compiled targets in report</dt>
          <dd>
            {requested !== null && present !== null
              ? `${present} of ${requested} recorded present`
              : "Not recorded"}
          </dd>
        </div>
      </dl>
      {!summaryOnly && <ReportTests tiers={report.tiers} selection={selection} />}
    </section>
  );
}

export function BuildPerformancePreview({ build, measurements }: {
  build: Build;
  measurements: ReadonlyMap<Build, PerformanceData["measurements"]>;
}) {
  return <PerformancePreview heading={build.gfx_family ? `${build.tag ?? build.build_id} · ${build.gfx_family}` : build.tag ?? build.build_id}
    observations={matchedPerformanceObservations([build], measurements)} />;
}

function BuildList({
  builds,
  buildHref,
  measuredBuilds,
}: {
  builds: Build[];
  buildHref: (build: Build) => string;
  measuredBuilds: ReadonlyMap<Build, PerformanceData["measurements"]>;
}) {
  if (!builds.length)
    return (
      <div className="build-browser-empty">
        <h2>No retained builds match this platform</h2>
        <p>Choose another platform to inspect the complete retained history.</p>
      </div>
    );
  return (
    <div className="build-browser-list" aria-label="Retained build list">
      {builds.map((build, index) => (
        <article
          className="build-browser-row"
          key={`${build.source_id ?? "unknown"}-${build.os}-${build.build_id}-${index}`}
        >
          <div className="build-browser-row-heading">
            <div>
              <span className="build-browser-kicker">
                {displayPlatform(build.os)}
              </span>
              <h3 aria-label={build.tag ?? build.build_id}>
                <a aria-label={buildLinkLabel(build)} href={buildHref(build)}>
                  {build.tag ?? build.build_id}
                </a>
                {measuredBuilds.has(build) && <BuildPerformancePreview build={build} measurements={measuredBuilds} />}
              </h3>
            </div>
            <span
              className={`build-browser-status ${build.qualified === true ? "status-pass" : build.qualified === false ? "status-fail" : "status-unavailable"}`}
            >
              {qualification(build)}
            </span>
          </div>
          <dl className="build-browser-facts">
            <div>
              <dt>Feed build ID</dt>
              <dd>{build.build_id}</dd>
            </div>
            <div>
              <dt>Package tag</dt>
              <dd>{build.tag ?? "Not recorded"}</dd>
            </div>
            <div>
              <dt>Source</dt>
              <dd>{sourceName(build)}</dd>
            </div>
            <div>
              <dt>Produced</dt>
              <dd>{date(build.generated_at)}</dd>
            </div>
            <div>
              <dt>Compiled targets</dt>
              <dd>{compiledTargets(build)}</dd>
            </div>
            <div>
              <dt>Hardware validation</dt>
              <dd>{hardwareValidation(build)}</dd>
            </div>
          </dl>
          <a
            aria-label={buildLinkLabel(build)}
            className="build-browser-open"
            href={buildHref(build)}
          >
            Open build evidence <span aria-hidden="true">→</span>
          </a>
        </article>
      ))}
    </div>
  );
}

function BuildDetail({ build, session, selection, hasPerformance, performanceMeasurements }: {
  build: Build;
  session: Session;
  hasPerformance: boolean;
  performanceMeasurements: ReadonlyMap<Build, PerformanceData["measurements"]>;
  selection?: CheckSelection;
}) {
  const [retry, setRetry] = useState(0);
  const reportReference = useMemo(() => pinnedReport(build), [build]);
  const [reportState, setReportState] = useState<ReportState>({
    state: "idle",
  });

  useEffect(() => {
    if (typeof reportReference === "string") {
      setReportState({ state: "error", message: reportReference });
      return;
    }
    const controller = new AbortController();
    setReportState({ state: "loading" });
    void (async () => {
      try {
        const report = await readQualificationReport(build, controller.signal);
        if (!controller.signal.aborted)
          setReportState({ state: "ready", report });
      } catch (reason) {
        if (controller.signal.aborted) return;
        setReportState({
          state: "error",
          message:
            reason instanceof Error
              ? reason.message
              : "Producer report could not be loaded.",
        });
      }
    })();
    return () => controller.abort();
  }, [build, reportReference, retry]);

  const url = typeof reportReference === "string" ? null : reportReference.url;
  const checkRevisionMismatch = selection?.commit != null &&
    (typeof reportReference === "string" || selection.commit !== reportReference.commit);
  const feedSource =
    typeof reportReference === "string" || !build.source_url
      ? null
      : build.source_url.match(sourceUrlPattern)?.[2] === reportReference.commit
        ? build.source_url
        : null;
  return (
    <article className="build-browser-detail">
      <a href={exactBuildHref(build)}>← Build review</a>
      <div className="build-browser-detail-heading">
        <div>
          <span className="build-browser-kicker">BUILD EVIDENCE</span>
          <h2 aria-label={build.tag ?? build.build_id}>{build.tag ?? build.build_id}{hasPerformance && <BuildPerformancePreview build={build} measurements={performanceMeasurements} />}</h2>
          <p>
            {displayPlatform(build.os)} · {date(build.generated_at)}
          </p>
        </div>
        <span
          className={`build-browser-status ${build.qualified === true ? "status-pass" : build.qualified === false ? "status-fail" : "status-unavailable"}`}
        >
          {qualification(build)}
        </span>
      </div>
      <dl className="build-browser-facts build-browser-detail-facts">
        <div>
          <dt>Feed build ID</dt>
          <dd>{build.build_id}</dd>
        </div>
        <div>
          <dt>Source</dt>
          <dd>{sourceName(build)}</dd>
        </div>
        <div>
          <dt>Package tag</dt>
          <dd>{build.tag ?? "Not recorded"}</dd>
        </div>
        <div>
          <dt>Platform</dt>
          <dd>{displayPlatform(build.os)}</dd>
        </div>
        <div>
          <dt>Package archive</dt>
          <dd>{build.artifact ?? "Not recorded"}</dd>
        </div>
        <div>
          <dt>ROCm SDK</dt>
          <dd>{build.producer_rocm_version ?? build.rocm_version}</dd>
        </div>
        <div>
          <dt>Compiled targets</dt>
          <dd>{compiledTargets(build)}</dd>
        </div>
        <div>
          <dt>Hardware validation</dt>
          <dd>{hardwareValidation(build)}</dd>
        </div>
        <div>
          <dt>Pinned dataset revision</dt>
          <dd>{session.pointer.data_commit?.slice(0, 12) ?? "Not recorded"}</dd>
        </div>
      </dl>
      {url && (
        <a href={url} target="_blank" rel="noreferrer">
          Open pinned producer report <span aria-hidden="true">↗</span>
        </a>
      )}
      {feedSource && (
        <a href={feedSource} target="_blank" rel="noreferrer">
          Open pinned feed source <span aria-hidden="true">↗</span>
        </a>
      )}
      {reportState.state === "loading" && (
        <p className="build-browser-loading" role="status">
          Loading pinned producer report…
        </p>
      )}
      {reportState.state === "error" && (
        <div className="build-browser-report-error" role="alert">
          <strong>Producer report unavailable</strong>
          <p>{reportState.message}</p>
          <button onClick={() => setRetry((value) => value + 1)}>
            Retry report
          </button>
        </div>
      )}
      {reportState.state === "ready" && (
        <>
          {checkRevisionMismatch && (
            <p role="status">This check link points to a different producer report revision.</p>
          )}
          <ReportEvidence report={reportState.report} selection={checkRevisionMismatch ? undefined : selection} />
        </>
      )}
    </article>
  );
}

export function BuildBrowser({
  session,
  fetcher = fetch,
  history,
  platform,
  selectedBuildId,
  selectedSourceId,
  selectedTierId,
  selectedCheckIndex,
  selectedReportCommit = null,
  buildHref,
  onPlatformChange,
  query = "",
  onQueryChange,
}: BuildBrowserProps) {
  const performance = useBuildMeasurements(session, history, fetcher);
  const platforms = useMemo(
    () => [...new Set(history?.map((build) => build.os) ?? [])].sort(),
    [history],
  );
  const listedBuilds = useMemo(
    () =>
      history?.filter(
        (build) =>
          (platform === "all" || build.os === platform) &&
          (!query ||
            [build.build_id, build.tag, build.artifact, build.source_id]
              .join(" ")
              .toLowerCase()
              .includes(query.toLowerCase())),
      ) ?? [],
    [history, platform, query],
  );
  const selection = useMemo(
    () =>
      findSelectedBuild(history, selectedBuildId, platform, selectedSourceId),
    [history, selectedBuildId, platform, selectedSourceId],
  );

  return (
    <section
      className="build-browser"
      aria-labelledby="retained-builds-heading"
    >
      <div className="build-browser-toolbar">
        <div>
          {selection?.kind === "selected" && (
            <span className="build-browser-kicker">{selection.build.channel} · {session.overview?.engines.find((engine) => engine.id === selection.build.engine)?.label ?? selection.build.engine}</span>
          )}
          <h2 id="retained-builds-heading">
            {selectedBuildId === null
              ? "Build details"
              : "Selected build details"}
          </h2>
        </div>
        {selectedBuildId !== null && <a href={`?version=${encodeURIComponent(session.version ?? "")}&view=build`}>All build details</a>}
        {selectedBuildId === null && (
          <label>
            Find build
            <input
              type="search"
              value={query}
              onChange={(event) => onQueryChange?.(event.target.value)}
              placeholder="Package tag or build ID"
            />
          </label>
        )}
        <label>
          Platform
          <select
            aria-label="Platform"
            value={platform}
            onChange={(event) => onPlatformChange(event.target.value)}
          >
            <option value="all">All platforms</option>
            {platform !== "all" && !platforms.includes(platform) && (
              <option value={platform}>
                {displayPlatform(platform)} · unavailable
              </option>
            )}
            {platforms.map((value) => (
              <option key={value} value={value}>
                {displayPlatform(value)}
              </option>
            ))}
          </select>
        </label>
      </div>
      {history === null ? (
        <div className="build-browser-empty" role="status">
          <h2>Retained build history is unavailable</h2>
          <p>Retry the published-data load to inspect retained builds.</p>
        </div>
      ) : selectedBuildId === null ? (
        <BuildList builds={listedBuilds} buildHref={buildHref} measuredBuilds={performance.matches} />
      ) : selection?.kind === "selected" ? (
        <BuildDetail
          key={`${selection.build.source_id ?? "unknown"}-${selection.build.os}-${selection.build.build_id}-${selection.build.report_url ?? "no-report"}`}
          build={selection.build}
          hasPerformance={performance.matches.has(selection.build)}
          performanceMeasurements={performance.matches}
          session={session}
          selection={selectedTierId != null && selectedCheckIndex != null
            ? { tier: selectedTierId, index: selectedCheckIndex, commit: selectedReportCommit }
            : undefined}
        />
      ) : (
        <div className="build-browser-empty" role="alert">
          <h2>Build evidence unavailable</h2>
          <p>{selection?.message ?? "The requested build is unavailable."}</p>
        </div>
      )}
    </section>
  );
}
