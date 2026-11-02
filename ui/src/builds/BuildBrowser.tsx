import { useEffect, useMemo, useRef, useState } from "react";
import type { Build, Session } from "../data";
import "./BuildBrowser.css";

type BuildBrowserProps = {
  session: Session;
  history: Build[] | null;
  platform: string;
  selectedBuildId: string | null;
  selectedSourceId?: string | null;
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

type ProducerReport = {
  raw: JsonRecord;
  build: JsonRecord;
  tiers: JsonRecord;
};

type ReportState =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "ready"; report: ProducerReport }
  | { state: "error"; message: string };

const reportUrlPattern =
  /^https:\/\/raw\.githubusercontent\.com\/lemonade-sdk\/llama\.cpp\/([a-f0-9]{40})\/qualification\/reports\/([A-Za-z0-9][A-Za-z0-9_.-]*\.json)$/;
const sourceUrlPattern =
  /^https:\/\/raw\.githubusercontent\.com\/lemonade-sdk\/llama\.cpp\/([a-f0-9]{40})\/qualification\/index\.json$/;

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

function checkCounts(build: Build) {
  if (!build.tests) return "Check counts unavailable";
  return (["passed", "failed", "warned", "skipped", "missing"] as const)
    .map((key) => `${build.tests?.[key] ?? "Unknown"} ${key}`)
    .join(" · ");
}

function compiledTargets(build: Build) {
  if (!build.gfx) return "Compiled-target evidence unavailable";
  const missing = build.gfx.missing.length
    ? `; ${build.gfx.missing.length} missing`
    : "";
  return `${build.gfx.present} of ${build.gfx.requested} requested targets compiled${missing}`;
}

function pinnedReport(build: Build): PinnedReport | string {
  if (!build.report_url)
    return "This retained build has no producer report URL.";
  const match = build.report_url.match(reportUrlPattern);
  if (!match)
    return "The producer report URL is not a pinned llama.cpp qualification report.";
  const [, commit, file] = match;
  if (file !== `${build.build_id}.json`)
    return "The pinned report filename does not match the selected feed build ID.";
  if (build.source_url) {
    const source = build.source_url.match(sourceUrlPattern);
    if (!source || source[1] !== commit)
      return "The selected feed source does not match the pinned producer report commit.";
  }
  return { url: build.report_url, commit, file };
}

function findSelectedBuild(
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

function reportMetadata(
  report: JsonRecord,
  build: Build,
  pinned: PinnedReport,
) {
  const reportBuild = report.build;
  if (!isRecord(reportBuild))
    throw new Error("Producer report is missing build metadata.");
  const reportOs = text(reportBuild.os);
  const reportVersion = text(reportBuild.rocm_version);
  const reportTag = text(reportBuild.llamacpp_tag) ?? text(reportBuild.tag);
  if (!reportOs || canonicalPlatform(reportOs) !== canonicalPlatform(build.os))
    throw new Error("Producer report OS does not match the selected feed row.");
  if (!reportVersion || reportVersion !== build.rocm_version)
    throw new Error(
      "Producer report ROCm version does not match the selected feed row.",
    );
  if (!build.tag || !reportTag || reportTag !== build.tag)
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
  if (
    build.run_attempt !== undefined &&
    build.run_attempt !== null &&
    reportAttempt !== undefined &&
    reportAttempt !== null &&
    String(reportAttempt) !== String(build.run_attempt)
  )
    throw new Error(
      "Producer report run attempt does not match the selected feed row.",
    );
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
  return { raw: report, build: reportBuild, tiers };
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

function evidence(test: JsonRecord, label: string, keys: string[]) {
  const details = isRecord(test.details) ? test.details : {};
  const value = keys
    .map((key) => test[key] ?? details[key])
    .find((candidate) => candidate !== undefined && candidate !== null);
  const rendered = summary(value);
  return rendered ? (
    <p className="build-browser-evidence">
      <strong>{label}:</strong> {rendered}
    </p>
  ) : null;
}

function TestDialog({
  test,
  id,
  reportUrl,
  onClose,
}: {
  test: JsonRecord;
  id: string;
  reportUrl: string;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    dialog.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const oldOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = oldOverflow;
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, []);
  const details = isRecord(test.details) ? test.details : null;
  return (
    <div
      className="build-test-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="build-test-title"
        className="build-test-dialog"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            onClose();
          }
          if (event.key === "Tab") {
            const controls = dialog.current?.querySelectorAll<HTMLElement>(
              "button, a[href], summary",
            );
            if (!controls?.length) return;
            const first = controls[0],
              last = controls[controls.length - 1];
            if (event.shiftKey && document.activeElement === first) {
              event.preventDefault();
              last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first.focus();
            }
          }
        }}
      >
        <div className="build-browser-tier-heading">
          <h3 id="build-test-title">
            {id} · {text(test.name) ?? "Unnamed test"}
          </h3>
          <button type="button" onClick={onClose}>
            Close test evidence
          </button>
        </div>
        <dl className="build-browser-facts">
          <div>
            <dt>Outcome</dt>
            <dd>{status(test.status)}</dd>
          </div>
          <div>
            <dt>Gate</dt>
            <dd>
              {test.gating === true
                ? "Gating"
                : test.gating === false
                  ? "Informational"
                  : "Not recorded"}
            </dd>
          </div>
          <div>
            <dt>Duration</dt>
            <dd>{duration(test)}</dd>
          </div>
          <div>
            <dt>Reason / error</dt>
            <dd>{summary(test.error ?? test.reason) ?? "Not recorded"}</dd>
          </div>
        </dl>
        {evidence(test, "Compatibility", ["compatibility"])}
        {evidence(test, "Runtime", ["runtime", "rocm_runtime_required"])}
        {evidence(test, "Minimum Linux dependencies", [
          "minimum_linux",
          "minimum_glibc",
          "minimum_glibcxx",
        ])}
        {evidence(test, "GPU offload", [
          "gpu_offload",
          "gpu_proof",
          "requested_offload_line",
        ])}
        {details && Object.keys(details).length > 0 && (
          <details>
            <summary>Audit details</summary>
            <pre>{JSON.stringify(details, null, 2)}</pre>
          </details>
        )}
        <a href={reportUrl} target="_blank" rel="noreferrer">
          Open pinned test source ↗
        </a>
      </div>
    </div>
  );
}

function ReportTests({
  tiers,
  reportUrl,
}: {
  tiers: JsonRecord;
  reportUrl: string;
}) {
  const [selected, setSelected] = useState<{
    test: JsonRecord;
    id: string;
  } | null>(null);
  const entries = Object.entries(tiers).filter(([, tier]) => isRecord(tier));
  if (!entries.length)
    return (
      <p className="build-browser-muted">
        No producer test tiers were recorded.
      </p>
    );
  return (
    <div className="build-browser-tiers">
      {entries.map(([tierId, rawTier]) => {
        const tier = rawTier as JsonRecord;
        const tests = Array.isArray(tier.tests)
          ? tier.tests.filter(isRecord)
          : [];
        return (
          <section className="build-browser-tier" key={tierId}>
            <div className="build-browser-tier-heading">
              <div>
                <span className="build-browser-kicker">
                  {tierId.replace(/^tier(\d+)$/i, "T$1")}
                </span>
                <h3>{text(tier.tier_name) ?? tierId}</h3>
              </div>
              <span
                className={`build-browser-status status-${status(tier.status)}`}
              >
                {status(tier.status)}
              </span>
            </div>
            <p className="build-browser-muted">
              {tests.length} checks in this tier
            </p>
            {tests.length ? (
              <div className="build-test-tiles">
                {tests.map((test, index) => {
                  const id =
                    text(test.id) ??
                    `${tierId} check ${index + 1} (ID not recorded)`;
                  return (
                    <button
                      key={`${id}-${index}`}
                      type="button"
                      aria-label={`${id} ${text(test.name) ?? "Unnamed test"} ${status(test.status)}`}
                      className={`build-test-tile status-${status(test.status)}`}
                      onClick={() => setSelected({ test, id })}
                    >
                      <strong>{id}</strong>
                      <span>{text(test.name) ?? "Unnamed test"}</span>
                      <span
                        className={`build-browser-status status-${status(test.status)}`}
                      >
                        {status(test.status)}
                      </span>
                    </button>
                  );
                })}
              </div>
            ) : (
              <p className="build-browser-muted">
                No individual tests were recorded.
              </p>
            )}
          </section>
        );
      })}
      {selected && (
        <TestDialog
          test={selected.test}
          id={selected.id}
          reportUrl={reportUrl}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}

function targetList(value: unknown) {
  if (
    !Array.isArray(value) ||
    !value.every((entry) => typeof entry === "string")
  )
    return "Not recorded";
  return value.length ? value.join(", ") : "None recorded";
}

function ReportCoverage({ report }: { report: ProducerReport }) {
  const gfx = isRecord(report.raw.gfx) ? report.raw.gfx : {};
  const expected = Array.isArray(gfx.requested) ? gfx.requested : null;
  const present = Array.isArray(gfx.present_in_binary)
    ? gfx.present_in_binary
    : null;
  const missing = Array.isArray(gfx.missing_from_binary)
    ? gfx.missing_from_binary
    : null;
  const inconsistent =
    expected &&
    present &&
    missing &&
    (new Set(expected).size !== expected.length ||
      new Set(present).size !== present.length ||
      new Set(missing).size !== missing.length ||
      expected.some(
        (target) => present.includes(target) === missing.includes(target),
      ) ||
      missing.some((target) => !expected.includes(target)));
  return (
    <section
      className="build-browser-coverage"
      aria-labelledby="build-gpu-coverage"
    >
      <h3 id="build-gpu-coverage">GPU coverage</h3>
      <p className="build-browser-muted">
        Compiled presence and physical hardware validation are separate producer
        evidence.
      </p>
      {inconsistent && (
        <p role="alert">
          Producer compiled-target lists are inconsistent; inspect pinned
          evidence before using this coverage.
        </p>
      )}
      <dl className="build-browser-facts">
        <div>
          <dt>Expected compiled targets</dt>
          <dd>{targetList(gfx.requested)}</dd>
        </div>
        <div>
          <dt>Present in binary</dt>
          <dd>{targetList(gfx.present_in_binary)}</dd>
        </div>
        <div>
          <dt>Missing compiled targets</dt>
          <dd>{targetList(gfx.missing_from_binary)}</dd>
        </div>
        <div>
          <dt>Physically validated targets</dt>
          <dd>{targetList(gfx.hardware_validated)}</dd>
        </div>
      </dl>
    </section>
  );
}

function ReportEvidence({
  report,
  reportUrl,
  build,
}: {
  report: ProducerReport;
  reportUrl: string;
  build: Build;
}) {
  const promotion = isRecord(report.raw.promotion)
    ? report.raw.promotion
    : null;
  const blockedBy = promotion ? summary(promotion.blocked_by) : null;
  const reportGfx = isRecord(report.raw.gfx) ? report.raw.gfx : null;
  const requested = Array.isArray(reportGfx?.requested)
    ? reportGfx.requested.length
    : null;
  const present = Array.isArray(reportGfx?.present_in_binary)
    ? reportGfx.present_in_binary.length
    : null;
  return (
    <section
      className="build-browser-report"
      aria-labelledby="producer-report-heading"
    >
      <div className="build-browser-tier-heading">
        <div>
          <span className="build-browser-kicker">PINNED PRODUCER REPORT</span>
          <h3 id="producer-report-heading">Qualification evidence</h3>
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
      <p className="build-browser-muted">
        {Object.values(report.tiers).reduce<number>(
          (count, tier) =>
            count +
            (isRecord(tier) && Array.isArray(tier.tests)
              ? tier.tests.filter(isRecord).length
              : 0),
          0,
        )}{" "}
        recorded checks
      </p>
      <ReportCoverage report={report} />
      <p className="build-browser-muted">
        Index counts and recorded report checks describe different producer
        records. Missing index checks are not assumed to have failed or to be
        mandatory.
      </p>
      {Object.entries(build.results ?? {}).some(
        ([id]) =>
          !Object.values(report.tiers).some(
            (tier) =>
              isRecord(tier) &&
              Array.isArray(tier.tests) &&
              tier.tests.some((test) => isRecord(test) && test.id === id),
          ),
      ) && (
        <details>
          <summary>Index outcomes absent from report</summary>
          <ul>
            {Object.entries(build.results ?? {})
              .filter(
                ([id]) =>
                  !Object.values(report.tiers).some(
                    (tier) =>
                      isRecord(tier) &&
                      Array.isArray(tier.tests) &&
                      tier.tests.some(
                        (test) => isRecord(test) && test.id === id,
                      ),
                  ),
              )
              .map(([id, outcome]) => (
                <li key={id}>
                  {id}: {outcome} · name and gating not recorded in full report
                </li>
              ))}
          </ul>
        </details>
      )}
      <ReportTests tiers={report.tiers} reportUrl={reportUrl} />
    </section>
  );
}

function BuildList({
  builds,
  buildHref,
}: {
  builds: Build[];
  buildHref: (build: Build) => string;
}) {
  if (!builds.length)
    return (
      <div className="build-browser-empty">
        <h2>No retained builds match this platform</h2>
        <p>Choose another platform to inspect the complete retained history.</p>
      </div>
    );
  return (
    <div
      className="build-browser-list"
      role="region"
      tabIndex={0}
      aria-label="Retained build list"
    >
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
              <h3>
                <a aria-label={buildLinkLabel(build)} href={buildHref(build)}>
                  {build.tag ?? build.build_id}
                </a>
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
              <dt>Engine / ROCm / channel</dt>
              <dd>
                {build.engine} · {build.rocm_version} · {build.channel}
              </dd>
            </div>
            <div>
              <dt>Checks</dt>
              <dd>{checkCounts(build)}</dd>
            </div>
            <div>
              <dt>Blockers</dt>
              <dd>
                {[
                  ...(build.blocked_by ?? []),
                  ...(build.blocking_tests ?? []),
                ].join(", ") || "None recorded"}
              </dd>
            </div>
            <div>
              <dt>Source</dt>
              <dd>{sourceName(build)}</dd>
            </div>
            <div>
              <dt>Qualification recorded</dt>
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

function BuildDetail({ build, session }: { build: Build; session: Session }) {
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
        const response = await fetch(reportReference.url, {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok)
          throw new Error(
            `Producer report request failed: HTTP ${response.status}.`,
          );
        const raw: unknown = await response.json();
        if (!isRecord(raw))
          throw new Error("Producer report is not valid JSON evidence.");
        const report = reportMetadata(raw, build, reportReference);
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
  const feedSource =
    typeof reportReference === "string" || !build.source_url
      ? null
      : build.source_url.match(sourceUrlPattern)?.[1] === reportReference.commit
        ? build.source_url
        : null;
  return (
    <article className="build-browser-detail">
      <div className="build-browser-detail-heading">
        <div>
          <span className="build-browser-kicker">BUILD EVIDENCE</span>
          <h2>{build.tag ?? build.build_id}</h2>
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
      <div className="build-inspection-layout">
        <div className="build-summary-cards">
          <section>
            <h3>Qualification gate</h3>
            <p>{qualification(build)}</p>
            <p className="build-browser-muted">{checkCounts(build)}</p>
            <p className="build-browser-muted">
              Qualification and promotion do not establish artifact publication.
              Publication evidence is unavailable here.
            </p>
          </section>
          <section>
            <h3>GPU inference</h3>
            <p>{hardwareValidation(build)}</p>
          </section>
          <section>
            <h3>Compiled targets</h3>
            <p>{compiledTargets(build)}</p>
            <p className="build-browser-muted">
              Compiled targets do not establish physical hardware validation.
            </p>
          </section>
          <section>
            <h3>Build reference</h3>
            <details className="build-browser-reference">
              <summary>Exact build reference</summary>
              <dl className="build-browser-facts">
                <div>
                  <dt>Artifact</dt>
                  <dd>{build.artifact ?? "Not recorded"}</dd>
                </div>
                <div>
                  <dt>Revision</dt>
                  <dd>{build.upstream_sha ?? "Not recorded"}</dd>
                </div>
                <div>
                  <dt>Run</dt>
                  <dd>{build.run_id ?? "Not recorded"}</dd>
                </div>
                <div>
                  <dt>Attempt</dt>
                  <dd>
                    {reportState.state === "ready"
                      ? (summary(reportState.report.build.run_attempt) ??
                        "Not recorded")
                      : "Report not loaded"}
                  </dd>
                </div>
              </dl>
            </details>
          </section>
        </div>
        <section>
          <h3>Selected build</h3>
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
              <dt>ROCm / engine / channel</dt>
              <dd>
                {build.rocm_version} · {build.engine} · {build.channel}
              </dd>
            </div>
            <div>
              <dt>Qualification recorded</dt>
              <dd>{date(build.generated_at)}</dd>
            </div>
            <div>
              <dt>Pinned dataset revision</dt>
              <dd>
                {session.pointer.data_commit?.slice(0, 12) ?? "Not recorded"}
              </dd>
            </div>
          </dl>
        </section>
      </div>
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
        <ReportEvidence
          report={reportState.report}
          reportUrl={url!}
          build={build}
        />
      )}
    </article>
  );
}

export function BuildBrowser({
  session,
  history,
  platform,
  selectedBuildId,
  selectedSourceId,
  buildHref,
  onPlatformChange,
  query = "",
  onQueryChange,
}: BuildBrowserProps) {
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
          <span className="build-browser-kicker">BUILD QUALIFICATION</span>
          <h2 id="retained-builds-heading">
            {selectedBuildId === null
              ? "Retained builds"
              : "Selected retained build"}
          </h2>
        </div>
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
        <BuildList builds={listedBuilds} buildHref={buildHref} />
      ) : selection?.kind === "selected" ? (
        <BuildDetail
          key={`${selection.build.source_id ?? "unknown"}-${selection.build.os}-${selection.build.build_id}-${selection.build.report_url ?? "no-report"}`}
          build={selection.build}
          session={session}
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
