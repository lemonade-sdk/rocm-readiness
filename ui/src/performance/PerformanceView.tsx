import { useEffect, useMemo, useState } from "react";
import { z } from "zod";
import { loadHistory, loadVersion, resolveDatasetPath } from "../data";
import type { Build, Session } from "../data";
import "./PerformanceView.css";

const timestamp = z
  .string()
  .refine((value) => Number.isFinite(Date.parse(value)), "Expected an ISO timestamp");
const text = z.string().min(1);
const nullableText = text.nullable().optional();
const nullableCount = z.number().finite().int().nonnegative().nullable().optional();

const measurementSchema = z.object({
  source_id: text,
  engine: text,
  channel: text,
  backend: text,
  fork_id: nullableText,
  engine_repository: nullableText,
  engine_version: nullableText,
  model: text,
  scenario: text,
  quant: nullableText,
  system_id: nullableText,
  context_size: nullableCount,
  input_tokens: nullableCount,
  measured_at: timestamp,
  rocm_version: nullableText,
  package_os: nullableText,
  package_url: z.string().url().nullable().optional(),
  qualification_build_id: nullableText,
  metrics: z.record(z.string(), z.number().finite()).optional().default({}),
});

const systemSchema = z
  .object({
    id: text,
    source_id: text,
    cpu: nullableText,
    gpu: nullableText,
    gpu_full: z.array(z.unknown()).nullable().optional(),
    os: nullableText,
    memory: nullableText,
    ram_gb: z.number().finite().nullable().optional(),
    vram_gb: z.number().finite().nullable().optional(),
    gfx_target: nullableText,
  })
  .passthrough();

const performanceSchema = z.object({
  schema_version: z.literal(2),
  measurements: z.array(measurementSchema),
  systems: z.array(systemSchema),
});

type Measurement = z.infer<typeof measurementSchema>;
type SystemRecord = z.infer<typeof systemSchema>;
type PerformanceData = {
  measurements: Measurement[];
  systems: Map<string, SystemRecord>;
};
type HistoryState = { builds: Build[] | null; error: string | null };
type ComparisonState =
  | { kind: "none" }
  | { kind: "ready"; version: string; data: PerformanceData; history: HistoryState }
  | { kind: "unmeasured"; version: string }
  | { kind: "error"; version: string; error: string };
type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; data: PerformanceData; history: HistoryState; comparison: ComparisonState }
  | { kind: "error"; error: string };

const metricInfo: Record<string, { label: string; unit: string }> = {
  tps_mean: { label: "Mean throughput", unit: "tok/s" },
  tps_p95: { label: "P95 throughput", unit: "tok/s" },
  tg_tps: { label: "Token generation throughput", unit: "tok/s" },
  pp_tps: { label: "Prompt processing throughput", unit: "tok/s" },
  ttft_ms_mean: { label: "Mean time to first token", unit: "ms" },
  ttft_ms_best: { label: "Best time to first token", unit: "ms" },
  vram_peak_gb: { label: "Peak VRAM", unit: "GB" },
};
const missingSystemFilter = "__missing_hardware__";

function sourceSystemKey(sourceId: string, systemId: string) {
  return JSON.stringify([sourceId, systemId]);
}

function errorMessage(reason: unknown, fallback: string) {
  return reason instanceof Error ? reason.message : fallback;
}

function isAbort(reason: unknown) {
  return reason instanceof DOMException && reason.name === "AbortError";
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(new Date(value)) + " UTC";
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("en", { maximumFractionDigits: 2 }).format(value);
}

function metricName(name: string) {
  return metricInfo[name]?.label ?? name.replaceAll("_", " ");
}

function metricValue(name: string, value: number) {
  const unit = metricInfo[name]?.unit;
  return unit ? `${formatNumber(value)} ${unit}` : `${formatNumber(value)} (unit unavailable)`;
}

function packageLabel(row: Measurement) {
  return row.engine_version ?? "Engine tag unavailable";
}

function stableMeasurements(data: PerformanceData) {
  return data.measurements.filter(
    (row) =>
      row.engine === "llamacpp" &&
      row.channel === "stable" &&
      row.backend === "rocm",
  );
}

function isQualificationCandidate(row: Measurement) {
  return Boolean(row.qualification_build_id);
}

async function readPerformance(session: Session, signal: AbortSignal): Promise<PerformanceData> {
  const performance = session.overview?.performance;
  if (!performance || performance.status !== "available" || !performance.path) {
    throw new Error("This ROCm version has no published performance file.");
  }
  const url = resolveDatasetPath(session.indexUrl, performance.path);
  const response = await fetch(url, {
    cache: "no-store",
    signal,
    redirect: "error",
  });
  if (!response.ok) {
    throw new Error(`${url}: HTTP ${response.status}. Retry or check the published data.`);
  }
  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    throw new Error(`${url}: invalid JSON. Retry or check the published file.`);
  }
  const parsed = performanceSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(
      `${url}: invalid ${issue.path.join(".") || "document"} — ${issue.message}`,
    );
  }
  if (parsed.data.measurements.some((row) => row.rocm_version !== session.version)) {
    throw new Error(`${url}: measurement ROCm version does not match the selected version.`);
  }
  const systems = new Map<string, SystemRecord>();
  for (const record of parsed.data.systems) {
    const key = sourceSystemKey(record.source_id, record.id);
    if (systems.has(key)) throw new Error(`${url}: duplicate source-scoped system identity.`);
    systems.set(key, record);
  }
  return { measurements: parsed.data.measurements, systems };
}

async function loadHistoryIfNeeded(
  session: Session,
  rows: Measurement[],
  signal: AbortSignal,
): Promise<HistoryState> {
  if (!rows.some(isQualificationCandidate)) return { builds: null, error: null };
  try {
    return { builds: await loadHistory(session, fetch, signal), error: null };
  } catch (reason) {
    if (signal.aborted || isAbort(reason)) throw reason;
    return { builds: null, error: errorMessage(reason, "Unable to load qualification history.") };
  }
}

async function loadViewData(
  session: Session,
  compareVersion: string | null,
  signal: AbortSignal,
): Promise<{ data: PerformanceData; history: HistoryState; comparison: ComparisonState }> {
  const data = await readPerformance(session, signal);
  const history = await loadHistoryIfNeeded(session, stableMeasurements(data), signal);
  if (!compareVersion) return { data, history, comparison: { kind: "none" } };
  if (compareVersion === session.version) {
    return {
      data,
      history,
      comparison: {
        kind: "error",
        version: compareVersion,
        error: "Choose a different ROCm version to compare.",
      },
    };
  }
  try {
    const other = await loadVersion(session, compareVersion, fetch, signal);
    if (other.overview?.performance.status !== "available") {
      return { data, history, comparison: { kind: "unmeasured", version: compareVersion } };
    }
    const otherData = await readPerformance(other, signal);
    const otherHistory = await loadHistoryIfNeeded(other, stableMeasurements(otherData), signal);
    return {
      data,
      history,
      comparison: {
        kind: "ready",
        version: compareVersion,
        data: otherData,
        history: otherHistory,
      },
    };
  } catch (reason) {
    if (signal.aborted || isAbort(reason)) throw reason;
    return {
      data,
      history,
      comparison: {
        kind: "error",
        version: compareVersion,
        error: errorMessage(reason, "Unable to load comparison data."),
      },
    };
  }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonical(item)]),
    );
  }
  return value;
}

function hardwareFingerprint(record: SystemRecord) {
  return JSON.stringify(
    canonical({
      source_id: record.source_id,
      id: record.id,
      cpu: record.cpu ?? null,
      gpu: record.gpu ?? null,
      gpu_full: record.gpu_full ?? null,
      os: record.os ?? null,
      memory: record.memory ?? null,
      ram_gb: record.ram_gb ?? null,
      vram_gb: record.vram_gb ?? null,
      gfx_target: record.gfx_target ?? null,
    }),
  );
}

function hasCompleteHardwareIdentity(record: SystemRecord) {
  return (
    Boolean(record.cpu && record.gpu && record.os) &&
    Array.isArray(record.gpu_full) &&
    record.gpu_full.length > 0 &&
    typeof record.ram_gb === "number" &&
    typeof record.vram_gb === "number"
  );
}

function recordFor(row: Measurement, systems: Map<string, SystemRecord>) {
  return row.system_id
    ? systems.get(sourceSystemKey(row.source_id, row.system_id))
    : undefined;
}

function comparisonKey(row: Measurement, systems: Map<string, SystemRecord>) {
  const system = recordFor(row, systems);
  if (
    !system ||
    !hasCompleteHardwareIdentity(system) ||
    !row.quant ||
    !row.scenario ||
    row.context_size == null ||
    row.input_tokens == null ||
    !row.package_os ||
    !row.fork_id ||
    !row.engine_repository
  ) {
    return null;
  }
  return JSON.stringify([
    row.source_id,
    hardwareFingerprint(system),
    row.engine,
    row.channel,
    row.backend,
    row.fork_id,
    row.engine_repository,
    row.model,
    row.quant,
    row.scenario,
    row.context_size,
    row.input_tokens,
    row.package_os,
  ]);
}

function measurementTieBreaker(row: Measurement) {
  return JSON.stringify([
    row.measured_at,
    row.source_id,
    row.engine_version ?? "",
    row.package_url ?? "",
    row.qualification_build_id ?? "",
    canonical(row.metrics),
  ]);
}

function latestByComparisonKey(
  rows: Measurement[],
  systems: Map<string, SystemRecord>,
) {
  const latest = new Map<string, Measurement>();
  for (const row of rows) {
    const key = comparisonKey(row, systems);
    if (!key) continue;
    const prior = latest.get(key);
    if (
      !prior ||
      Date.parse(row.measured_at) > Date.parse(prior.measured_at) ||
      (Date.parse(row.measured_at) === Date.parse(prior.measured_at) &&
        measurementTieBreaker(row) > measurementTieBreaker(prior))
    ) {
      latest.set(key, row);
    }
  }
  return latest;
}

function packageFileName(url: string | null | undefined) {
  if (!url) return null;
  try {
    return decodeURIComponent(new URL(url).pathname.split("/").at(-1) ?? "") || null;
  } catch {
    return null;
  }
}

function sourceRepository(url: string | null | undefined) {
  if (!url) return null;
  try {
    const parts = new URL(url).pathname.split("/").filter(Boolean);
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : null;
  } catch {
    return null;
  }
}

export function findExactQualificationBuild(
  row: Measurement,
  history: Build[] | null,
) {
  if (!history || !row.qualification_build_id) return undefined;
  const matches = history.filter((build) => {
    if (
      build.build_id !== row.qualification_build_id ||
      build.engine !== row.engine ||
      build.channel !== "stable" ||
      build.rocm_version !== row.rocm_version ||
      build.os !== row.package_os ||
      build.tag !== row.engine_version
    ) {
      return false;
    }
    const packageName = packageFileName(row.package_url);
    if (build.artifact && packageName !== build.artifact) return false;
    const repository = sourceRepository(build.source_url);
    return !repository || !row.engine_repository || repository === row.engine_repository;
  });
  return matches.length === 1 ? matches[0] : undefined;
}

function systemSummary(row: Measurement, systems: Map<string, SystemRecord>) {
  if (!row.system_id) return "Hardware metadata unavailable";
  const system = recordFor(row, systems);
  if (!system) return `Hardware record unavailable (${row.system_id})`;
  if (!hasCompleteHardwareIdentity(system))
    return `Hardware record incomplete (${row.system_id})`;
  const parts = [system.cpu, system.gpu, system.os].filter(
    (value): value is string => Boolean(value),
  );
  return parts.length ? parts.join(" · ") : `Recorded system ${system.id}`;
}

function filterRows(
  rows: Measurement[],
  model: string | null,
  system: string | null,
  workload: string | null,
  platform: string,
) {
  return rows.filter((row) => {
    if (model && row.model !== model) return false;
    if (system && system !== "all") {
      if (system === missingSystemFilter ? row.system_id !== null : row.system_id !== system)
        return false;
    }
    if (workload && workload !== "all" && row.scenario !== workload) return false;
    return platform === "all" || row.package_os === platform;
  });
}

function plural(count: number, singular: string) {
  return `${count} ${count === 1 ? singular : `${singular}s`}`;
}

function measurementMetadata(row: Measurement, systems: Map<string, SystemRecord>) {
  return (
    <dl className="performance-metadata">
      <div>
        <dt>Quantization</dt>
        <dd>{row.quant ?? "Not recorded"}</dd>
      </div>
      <div>
        <dt>Workload</dt>
        <dd>{row.scenario}</dd>
      </div>
      <div>
        <dt>Context / input</dt>
        <dd>
          {row.context_size == null ? "Context not recorded" : `${formatNumber(row.context_size)} tokens`}
          {" · "}
          {row.input_tokens == null ? "Input not recorded" : `${formatNumber(row.input_tokens)} input tokens`}
        </dd>
      </div>
      <div>
        <dt>Hardware</dt>
        <dd>{systemSummary(row, systems)}</dd>
      </div>
      <div>
        <dt>Measurement platform</dt>
        <dd>{row.package_os ?? "Not recorded"}</dd>
      </div>
      <div>
        <dt>Engine package</dt>
        <dd>
          {row.package_url ? (
            <a href={row.package_url} target="_blank" rel="noreferrer">
              {packageLabel(row)} ↗
            </a>
          ) : (
            packageLabel(row)
          )}
        </dd>
      </div>
      <div>
        <dt>Measured</dt>
        <dd>{formatDate(row.measured_at)}</dd>
      </div>
    </dl>
  );
}

function Metrics({ row }: { row: Measurement }) {
  const metrics = Object.entries(row.metrics).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  if (!metrics.length) return <p className="performance-empty-metrics">No reported metrics</p>;
  return (
    <dl className="performance-metrics">
      {metrics.map(([name, value]) => (
        <div key={name}>
          <dt>{metricName(name)}</dt>
          <dd>{metricValue(name, value)}</dd>
        </div>
      ))}
    </dl>
  );
}

function Qualification({
  row,
  history,
  buildHref,
}: {
  row: Measurement;
  history: HistoryState;
  buildHref: (buildId: string, platform: string) => string;
}) {
  if (!row.qualification_build_id) {
    return <p className="performance-provenance">No qualification build is identified for this package.</p>;
  }
  if (history.error) {
    return (
      <p className="performance-provenance warning-text">
        Qualification history unavailable; no package qualification is shown.
      </p>
    );
  }
  const build = findExactQualificationBuild(row, history.builds);
  if (!build) {
    return <p className="performance-provenance">No matching stable qualification history record</p>;
  }
  const outcome =
    build.qualified === true
      ? "Qualified"
      : build.qualified === false
        ? "Not qualified"
        : "Qualification outcome unavailable";
  return (
    <p className="performance-provenance">
      <strong>Package qualification:</strong> {outcome}.{" "}
      <a href={buildHref(build.build_id, build.os)}>Open matching package record</a>
    </p>
  );
}

function MeasurementDetail({
  row,
  systems,
  history,
  buildHref,
}: {
  row: Measurement;
  systems: Map<string, SystemRecord>;
  history: HistoryState;
  buildHref: (buildId: string, platform: string) => string;
}) {
  return (
    <article className="performance-observation">
      <div className="performance-observation-heading">
        <div>
          <span className="eyebrow">STABLE LLAMA.CPP OBSERVATION</span>
          <h3>{row.model}</h3>
        </div>
        <time dateTime={row.measured_at}>{formatDate(row.measured_at)}</time>
      </div>
      {measurementMetadata(row, systems)}
      <Metrics row={row} />
      <Qualification row={row} history={history} buildHref={buildHref} />
    </article>
  );
}

function Comparison({
  current,
  comparison,
  filters,
}: {
  current: PerformanceData;
  comparison: ComparisonState;
  filters: {
    model: string | null;
    system: string | null;
    workload: string | null;
    platform: string;
  };
}) {
  if (comparison.kind === "none") return null;
  if (comparison.kind === "unmeasured") {
    return (
      <section className="performance-comparison" aria-live="polite">
        <h2>ROCm {comparison.version} comparison</h2>
        <p>ROCm {comparison.version} has no recorded stable llama.cpp measurements.</p>
      </section>
    );
  }
  if (comparison.kind === "error") {
    return (
      <section className="performance-comparison" aria-live="polite">
        <h2>ROCm {comparison.version} comparison</h2>
        <p className="warning-text">{comparison.error}</p>
      </section>
    );
  }

  const selectedRows = filterRows(
    stableMeasurements(current),
    filters.model,
    filters.system,
    filters.workload,
    filters.platform,
  );
  const otherRows = filterRows(
    stableMeasurements(comparison.data),
    filters.model,
    filters.system,
    filters.workload,
    filters.platform,
  );
  const selected = latestByComparisonKey(selectedRows, current.systems);
  const other = latestByComparisonKey(otherRows, comparison.data.systems);
  const keys = [...selected.keys()].filter((key) => other.has(key)).sort();
  const missingSelected = selectedRows.filter(
    (row) => !comparisonKey(row, current.systems),
  ).length;
  const missingOther = otherRows.filter(
    (row) => !comparisonKey(row, comparison.data.systems),
  ).length;
  const unmatchedSelected = selected.size - keys.length;
  const unmatchedOther = other.size - keys.length;

  return (
    <section className="performance-comparison" aria-live="polite">
      <h2>ROCm {comparison.version} comparison</h2>
      <p>
        Comparison uses only the latest observation with an exact source-scoped hardware record,
        model, quantization, workload, context, input, package OS, backend, and fork.
      </p>
      {!keys.length ? (
        <p className="performance-empty-comparison">No compatible comparison</p>
      ) : (
        <div className="performance-comparison-list">
          {keys.map((key) => {
            const left = selected.get(key)!;
            const right = other.get(key)!;
            const names = [...new Set([...Object.keys(left.metrics), ...Object.keys(right.metrics)])].sort();
            return (
              <article className="performance-comparison-row" key={key}>
                <h3>
                  {left.model} · {left.quant} · {left.scenario}
                </h3>
                <p>
                  Current: {packageLabel(left)} · {formatDate(left.measured_at)}
                  <br />
                  ROCm {comparison.version}: {packageLabel(right)} · {formatDate(right.measured_at)}
                </p>
                {!names.length ? (
                  <p>No reported metrics on either compatible observation.</p>
                ) : (
                  <dl className="performance-deltas">
                    {names.map((name) => {
                      const leftValue = left.metrics[name];
                      const rightValue = right.metrics[name];
                      const unit = metricInfo[name]?.unit;
                      const canCompare =
                        unit !== undefined &&
                        typeof leftValue === "number" &&
                        typeof rightValue === "number";
                      return (
                        <div key={name}>
                          <dt>{metricName(name)}</dt>
                          <dd>
                            {typeof leftValue === "number" ? metricValue(name, leftValue) : "Not reported"}
                            {" vs "}
                            {typeof rightValue === "number" ? metricValue(name, rightValue) : "Not reported"}
                            {canCompare
                              ? ` · Δ ${(leftValue - rightValue) >= 0 ? "+" : ""}${metricValue(
                                  name,
                                  leftValue - rightValue,
                                )}`
                              : " · No unit-compatible delta"}
                          </dd>
                        </div>
                      );
                    })}
                  </dl>
                )}
              </article>
            );
          })}
        </div>
      )}
      <ul className="performance-unmatched">
        <li>{plural(unmatchedSelected, "selected observation")} unmatched.</li>
        <li>
          {plural(unmatchedOther, `ROCm ${comparison.version} observation`)} unmatched.
        </li>
        {missingSelected + missingOther > 0 && (
          <li>
            Missing hardware or workload metadata excluded {plural(missingSelected + missingOther, "observation")}.
          </li>
        )}
      </ul>
    </section>
  );
}

export function PerformanceView({
  session,
  params,
  onNavigate,
  buildHref,
}: {
  session: Session;
  params: URLSearchParams;
  onNavigate: (params: URLSearchParams) => void;
  buildHref: (buildId: string, platform: string) => string;
}) {
  const overview = session.overview;
  const compareVersion = params.get("compare");
  const [retry, setRetry] = useState(0);
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const performancePath =
    overview?.performance.status === "available" ? overview.performance.path : undefined;

  useEffect(() => {
    if (!overview || overview.performance.status !== "available" || !performancePath) return;
    const controller = new AbortController();
    setState({ kind: "loading" });
    loadViewData(session, compareVersion, controller.signal)
      .then((loaded) => {
        if (!controller.signal.aborted) setState({ kind: "ready", ...loaded });
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted && !isAbort(reason)) {
          setState({ kind: "error", error: errorMessage(reason, "Unable to load performance data.") });
        }
      });
    return () => controller.abort();
  }, [session, overview, performancePath, compareVersion, retry]);

  const isModelView = params.get("view") === "model";
  const model = params.get("model");
  const system = params.get("system");
  const workload = params.get("workload");
  const platform = params.get("platform") ?? "all";
  const filters = { model, system, workload, platform };
  const allRows = useMemo(
    () => (state.kind === "ready" ? stableMeasurements(state.data) : []),
    [state],
  );
  const rows = useMemo(
    () => filterRows(allRows, model, system, workload, platform),
    [allRows, model, system, workload, platform],
  );
  const models = useMemo(
    () => [...new Set(allRows.map((row) => row.model))].sort((left, right) => left.localeCompare(right)),
    [allRows],
  );
  const systems = useMemo(
    () => [...new Set(allRows.map((row) => row.system_id).filter((id): id is string => Boolean(id)))].sort(),
    [allRows],
  );
  const workloads = useMemo(
    () => [...new Set(allRows.map((row) => row.scenario))].sort((left, right) => left.localeCompare(right)),
    [allRows],
  );

  const nextParams = (changes: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(changes)) {
      if (value === null || value === "") next.delete(key);
      else next.set(key, value);
    }
    return next;
  };
  const navigate = (changes: Record<string, string | null>) => onNavigate(nextParams(changes));
  const modelHref = (modelId: string) => `?${nextParams({ view: "model", model: modelId }).toString()}`;

  if (!overview || session.version === null) {
    return (
      <section className="performance-view">
        <h2>Model performance</h2>
        <p>No ROCm version is selected.</p>
      </section>
    );
  }
  if (overview.performance.status === "not_measured") {
    return (
      <section className="performance-view">
        <h2>Model performance</h2>
        <p>No recorded model measurements for ROCm {overview.rocm_version}</p>
        <p>Performance remains unmeasured; no package or qualification conclusion is implied.</p>
      </section>
    );
  }

  return (
    <section className="performance-view" aria-labelledby="performance-heading">
      <div className="performance-heading">
        <div>
          <span className="eyebrow">STABLE LLAMA.CPP · HISTORICAL MEASUREMENTS</span>
          <h2 id="performance-heading">
            {isModelView && model ? model : "Model performance"}
          </h2>
        </div>
        {isModelView && (
          <a
            href={`?${nextParams({ view: "performance", model: null }).toString()}`}
            onClick={(event) => {
              event.preventDefault();
              navigate({ view: "performance", model: null });
            }}
          >
            ← Back to models
          </a>
        )}
      </div>
      <p className="performance-intro">
        Each row is a recorded historical measurement. Its package tag and date belong to that
        observation and do not establish the performance of the current build.
      </p>
      <p className="performance-platform-note">
        Platform filters measurements by their recorded package OS, not by a current qualification
        list.
      </p>

      {state.kind === "ready" && (
        <div className="performance-filters" aria-label="Performance filters">
          <label>
            Model
            <select
              value={model ?? ""}
              onChange={(event) =>
                navigate({
                  model: event.target.value || null,
                  view: event.target.value ? "model" : "performance",
                })
              }
            >
              <option value="">All models</option>
              {models.map((entry) => (
                <option value={entry} key={entry}>
                  {entry}
                </option>
              ))}
            </select>
          </label>
          <label>
            Hardware system
            <select value={system ?? ""} onChange={(event) => navigate({ system: event.target.value || null })}>
              <option value="">All systems</option>
              {systems.map((entry) => (
                <option value={entry} key={entry}>
                  {entry}
                </option>
              ))}
              {allRows.some((row) => row.system_id === null) && (
                <option value={missingSystemFilter}>Hardware metadata unavailable</option>
              )}
            </select>
          </label>
          <label>
            Workload
            <select value={workload ?? ""} onChange={(event) => navigate({ workload: event.target.value || null })}>
              <option value="">All workloads</option>
              {workloads.map((entry) => (
                <option value={entry} key={entry}>
                  {entry}
                </option>
              ))}
            </select>
          </label>
          <label>
            Measurement platform
            <select value={platform} onChange={(event) => navigate({ platform: event.target.value })}>
              <option value="all">All platforms</option>
              <option value="linux">Linux</option>
              <option value="windows">Windows</option>
            </select>
          </label>
          <label>
            Compare ROCm version
            <select value={compareVersion ?? ""} onChange={(event) => navigate({ compare: event.target.value || null })}>
              <option value="">No comparison</option>
              {session.index.versions
                .filter((entry) => entry.rocm_version !== session.version)
                .map((entry) => (
                  <option value={entry.rocm_version} key={entry.rocm_version}>
                    ROCm {entry.rocm_version}
                  </option>
                ))}
            </select>
          </label>
        </div>
      )}

      {state.kind === "loading" && <p role="status">Loading historical measurements…</p>}
      {state.kind === "error" && (
        <div className="notice error" role="alert">
          <strong>Couldn’t load model measurements</strong>
          <p>{state.error}</p>
          <button onClick={() => setRetry((value) => value + 1)}>Retry</button>
        </div>
      )}
      {state.kind === "ready" && (
        <>
          {isModelView ? (
            model ? (
              <div className="performance-observations">
                {rows.map((row) => (
                  <MeasurementDetail
                    key={measurementTieBreaker(row)}
                    row={row}
                    systems={state.data.systems}
                    history={state.history}
                    buildHref={buildHref}
                  />
                ))}
                {!rows.length && <p>No stable measurements match this model and these filters.</p>}
              </div>
            ) : (
              <p>Select a model to inspect its recorded observations.</p>
            )
          ) : (
            <div className="performance-table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Model</th>
                    <th>Observed configurations</th>
                    <th>Hardware systems</th>
                    <th>Most recent observation</th>
                  </tr>
                </thead>
                <tbody>
                  {[...new Set(rows.map((row) => row.model))]
                    .sort((left, right) => left.localeCompare(right))
                    .map((modelId) => {
                      const observations = rows.filter((row) => row.model === modelId);
                      const mostRecent = observations.reduce((latest, row) =>
                        Date.parse(row.measured_at) > Date.parse(latest.measured_at) ? row : latest,
                      );
                      return (
                        <tr key={modelId}>
                          <td>
                            <a
                              href={modelHref(modelId)}
                              onClick={(event) => {
                                event.preventDefault();
                                navigate({ view: "model", model: modelId });
                              }}
                            >
                              {modelId}
                            </a>
                          </td>
                          <td>{plural(observations.length, "observation")}</td>
                          <td>
                            {[...new Set(observations.map((row) => row.system_id ?? "Hardware metadata unavailable"))].join(
                              ", ",
                            )}
                          </td>
                          <td>{formatDate(mostRecent.measured_at)}</td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
              {!rows.length && <p>No stable llama.cpp ROCm measurements match these filters.</p>}
            </div>
          )}
          <Comparison current={state.data} comparison={state.comparison} filters={filters} />
        </>
      )}
    </section>
  );
}
