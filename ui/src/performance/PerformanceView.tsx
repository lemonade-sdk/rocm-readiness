import { useEffect, useMemo, useState, type ReactNode } from "react";
import { z } from "zod";
import { loadHistory, resolveDatasetPath } from "../data";
import type { Build, Session } from "../data";
import "./PerformanceView.css";
import "../builds/QualificationMatrix.css";
import { FilterReset, FilterScope } from "../FilterReset";
import { Tooltip, TooltipContent } from "../overview/Tooltip";
import { PlatformIcon } from "../PlatformIcon";
import { usePhoneLayout, useMediaQuery } from "../mobile";
import { MobileFilters } from "../MobileFilters";
import { EvidenceDisclosure } from "../overview/EvidenceDisclosure";

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
  run_id: z.union([z.string(), z.number().int().nonnegative()]).nullable().optional(),
  run_url: z.string().regex(/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/actions\/runs\/[0-9]+$/).nullable().optional(),
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
  benchmark_assessment: z.object({
    message: text,
    last_run_label: text,
  }).nullable().optional(),
});

type Measurement = z.infer<typeof measurementSchema>;
type SystemRecord = z.infer<typeof systemSchema>;
export type PerformanceData = {
  measurements: Measurement[];
  systems: Map<string, SystemRecord>;
  benchmarkAssessment?: z.infer<typeof performanceSchema>["benchmark_assessment"];
};
type HistoryState = { builds: Build[] | null; error: string | null };
type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; data: PerformanceData; history: HistoryState }
  | { kind: "error"; error: string };

const metricInfo: Record<string, { label: string; unit: string }> = {
  tps_mean: { label: "Mean throughput", unit: "tok/s" },
  tps_p95: { label: "P95 throughput", unit: "tok/s" },
  tg_tps: { label: "Token generation throughput", unit: "tok/s" },
  pp_tps: { label: "Prompt processing throughput", unit: "tok/s" },
  ttft_ms_mean: { label: "Mean time to first token", unit: "s" },
  ttft_ms_best: { label: "Best time to first token", unit: "s" },
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

export function metricValue(name: string, value: number) {
  const unit = metricInfo[name]?.unit;
  const displayed = name.startsWith("ttft_ms_") ? value / 1000 : value;
  return unit ? `${formatNumber(displayed)} ${unit}` : `${formatNumber(displayed)} (unit unavailable)`;
}

function packageLabel(row: Measurement) {
  return row.engine_version ?? "Engine tag unavailable";
}

export function rocmMeasurements(data: PerformanceData) {
  return data.measurements.filter(
    (row) =>
      row.engine === "llamacpp" &&
      row.backend === "rocm",
  );
}

function isQualificationCandidate(row: Measurement) {
  return Boolean(row.qualification_build_id);
}

export async function readPerformance(session: Session, signal: AbortSignal, fetcher = fetch): Promise<PerformanceData> {
  const performance = session.overview?.performance;
  if (!performance || performance.status !== "available" || !performance.path) {
    throw new Error("This ROCm version has no published performance file.");
  }
  const url = resolveDatasetPath(session.indexUrl, performance.path);
  const response = await fetcher(url, {
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
  return { measurements: parsed.data.measurements, systems, benchmarkAssessment: parsed.data.benchmark_assessment };
}

async function loadHistoryIfNeeded(
  session: Session,
  rows: Measurement[],
  signal: AbortSignal,
  fetcher = fetch,
): Promise<HistoryState> {
  if (!rows.some(isQualificationCandidate)) return { builds: null, error: null };
  try {
    return { builds: await loadHistory(session, fetcher, signal), error: null };
  } catch (reason) {
    if (signal.aborted || isAbort(reason)) throw reason;
    return { builds: null, error: errorMessage(reason, "Unable to load qualification history.") };
  }
}

async function loadViewData(
  session: Session,
  signal: AbortSignal,
  fetcher = fetch,
): Promise<{ data: PerformanceData; history: HistoryState }> {
  const data = await readPerformance(session, signal, fetcher);
  const history = await loadHistoryIfNeeded(session, rocmMeasurements(data), signal, fetcher);
  return { data, history };
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

export function comparisonKey(row: Measurement, systems: Map<string, SystemRecord>) {
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

export function measurementIdentity(row: Measurement) {
  return JSON.stringify([
    row.source_id, row.fork_id, row.engine_version, row.model, row.scenario,
    row.quant, row.measured_at, row.run_id == null ? null : String(row.run_id),
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
      build.channel !== row.channel ||
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

export function systemSummary(row: Measurement, systems: Map<string, SystemRecord>) {
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
  system: string[],
  workload: string[],
  platform: string[],
) {
  return rows.filter((row) => {
    if (model && row.model !== model) return false;
    if (system.length && !system.includes(row.system_id ?? missingSystemFilter)) return false;
    if (workload.length && !workload.includes(row.scenario)) return false;
    return !platform.length || platform.includes(row.package_os ?? "");
  });
}

export function workloadLabel(value: string) {
  return value.replace(/^context-(\d+)k$/i, (_, count: string) => `${count}K`);
}

function contextLabel(value: number | null | undefined) {
  return value == null ? "—" : value % 1024 === 0 ? `${value / 1024}K` : formatNumber(value);
}

function hardwareLabel(id: string, rows: Measurement[], systems: Map<string, SystemRecord>) {
  const records = rows.filter((row) => row.system_id === id).map((row) => recordFor(row, systems)).filter(Boolean);
  const record = records[0];
  const cpu = record?.cpu?.replace(/\s+w\/.*$/i, "").replace(/^AMD\s+/i, "");
  const integrated = record?.cpu?.match(/w\/\s*(.+)$/i)?.[1];
  const gpu = integrated ?? record?.gpu_full?.map((entry) => typeof entry === "object" && entry && "name" in entry ? String(entry.name) : "").filter(Boolean).join(" / ") ?? record?.gpu;
  return [cpu, gpu].filter(Boolean).join(" · ") || id.split("|")[0];
}

function packageGpuFamily(row: Measurement) {
  if (!row.package_url) return null;
  const filename = new URL(row.package_url).pathname.split("/").at(-1) ?? "";
  return filename.match(/-(gfx[0-9a-f]+)-/i)?.[1] ?? null;
}

function latestConfigurations(rows: Measurement[]) {
  const groups = new Map<string, Measurement[]>();
  for (const row of rows) {
    const key = JSON.stringify([row.source_id, row.engine, row.backend, row.fork_id,
      row.engine_repository, row.channel, row.engine_version, row.model, row.quant, row.scenario, row.input_tokens, row.package_os,
      row.channel === "nightly" ? packageGpuFamily(row) : null]);
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return [...groups.values()].flatMap((group) => {
    const sorted = [...group].sort((a, b) => Date.parse(b.measured_at) - Date.parse(a.measured_at) ||
      measurementTieBreaker(b).localeCompare(measurementTieBreaker(a)));
    const latest = new Map<string, Measurement>();
    for (const row of sorted) {
      // Prefer newer attributed observations within this build/configuration.
      if (!row.system_id && latest.size) continue;
      const key = row.system_id ? JSON.stringify([row.system_id, row.context_size]) : "unknown";
      if (!latest.has(key)) latest.set(key, row);
    }
    return [...latest.values()];
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
        <dd>{workloadLabel(row.scenario)}</dd>
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
        <dt>Channel</dt>
        <dd>{row.channel}</dd>
      </div>
      <div>
        <dt>Engine package</dt>
        <dd>
          {row.package_url ? (
            <a href={row.package_url} target="_blank" rel="noreferrer">
              {packageLabel(row)}
            </a>
          ) : (
            packageLabel(row)
          )}
        </dd>
      </div>
      {row.run_url && <div>
        <dt>Benchmark run</dt>
        <dd><a href={row.run_url} target="_blank" rel="noreferrer">{row.run_id ?? "Open benchmark run"}</a></dd>
      </div>}
      <div>
        <dt>Measured (UTC)</dt>
        <dd><time dateTime={row.measured_at}>{new Date(row.measured_at).toISOString().slice(0, 16).replace("T", " ")}</time></dd>
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

function MeasurementEvidence({ row, systems, history, buildHref }: {
  row: Measurement; systems: Map<string, SystemRecord>; history: HistoryState;
  buildHref: (buildId: string, platform: string) => string;
}) {
  return <TooltipContent heading={row.model}>
    <ul className="qualification-popup-packages"><li>
      <h4 className="qualification-platform-heading"><PlatformIcon platform={row.package_os ?? ""} /> {row.package_os === "windows" ? "Windows" : row.package_os === "linux" ? "Linux" : "OS unavailable"}</h4>
      <div className="performance-evidence-section">
        <h5>Performance</h5>
        <Metrics row={row} />
      </div>
      <div className="qualification-compiled-targets">
        <h5>Test configuration</h5>
        <dl><dt>Workload</dt><dd>{workloadLabel(row.scenario)}</dd>
          <dt>Context</dt><dd>{contextLabel(row.context_size)}</dd>
          <dt>Input tokens</dt><dd>{row.input_tokens == null ? "Not recorded" : formatNumber(row.input_tokens)}</dd>
          <dt>Quantization</dt><dd>{row.quant ?? "Not recorded"}</dd>
        </dl>
      </div>
      <div className="qualification-compiled-targets">
        <h5>Hardware</h5>
        <dl><dt>System</dt><dd>{systemSummary(row, systems)}</dd></dl>
      </div>
      <div className="qualification-compiled-targets">
        <h5>Package and benchmark</h5>
        <dl><dt>Engine package</dt><dd>{row.package_url ? <a href={row.package_url} target="_blank" rel="noreferrer">{packageLabel(row)}</a> : packageLabel(row)}</dd>
          <dt>Channel</dt><dd>{row.channel}</dd>
          <dt>Benchmark run</dt><dd>{row.run_url ? <a href={row.run_url} target="_blank" rel="noreferrer">{row.run_id ?? "Open benchmark run"}</a> : "Not recorded"}</dd>
          <dt>Measured (UTC)</dt><dd><time dateTime={row.measured_at}>{new Date(row.measured_at).toISOString().slice(0, 16).replace("T", " ")}</time></dd>
        </dl>
      </div>
      <div className="qualification-compiled-targets">
        <h5>Qualification</h5>
        <Qualification row={row} history={history} buildHref={buildHref} />
      </div>
    </li></ul>
  </TooltipContent>;
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
    return <p className="performance-provenance">No matching qualification history record</p>;
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

export function MeasurementDetail({
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
          <span className="eyebrow">LLAMA.CPP ROCM OBSERVATION</span>
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

function PerformanceFilter({ label, value, options, onSelect }: {
  label: string; value: string[]; options: [string, string][]; onSelect: (value: string[]) => void;
}) {
  const selected = value.length ? value : options.map(([id]) => id);
  return <fieldset className="build-filter-options">
    <legend>{label}</legend>
    {options.map(([id, name]) => <button key={id} type="button"
      title={label === "Hardware system" ? id : undefined} aria-pressed={selected.includes(id)} disabled={selected.length === 1 && selected.includes(id)}
      onClick={() => {
        const next = selected.includes(id) ? selected.filter((entry) => entry !== id) : [...selected, id];
        onSelect(next.length === options.length ? [] : next);
      }}>
      {label === "Measurement platform" && <PlatformIcon platform={id} />}{name}
    </button>)}
  </fieldset>;
}

export function PerformanceView({
  session,
  params,
  onNavigate,
  buildHref,
  versionFilter,
  fetcher = fetch,
}: {
  fetcher?: typeof fetch;
  versionFilter?: ReactNode;
  session: Session;
  params: URLSearchParams;
  onNavigate: (params: URLSearchParams) => void;
  buildHref: (buildId: string, platform: string) => string;
}) {
  const phone = usePhoneLayout();
  const wideEvidence = useMediaQuery("(min-width: 1024px)");
  const overview = session.overview;
  const [retry, setRetry] = useState(0);
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const performancePath =
    overview?.performance.status === "available" ? overview.performance.path : undefined;

  useEffect(() => {
    if (!overview || overview.performance.status !== "available" || !performancePath) return;
    const controller = new AbortController();
    setState({ kind: "loading" });
    loadViewData(session, controller.signal, fetcher)
      .then((loaded) => {
        if (!controller.signal.aborted) setState({ kind: "ready", ...loaded });
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted && !isAbort(reason)) {
          setState({ kind: "error", error: errorMessage(reason, "Unable to load performance data.") });
        }
      });
    return () => controller.abort();
  }, [session, overview, performancePath, retry, fetcher]);

  const model = params.get("model");
  const system = params.getAll("system").filter((value) => value !== "all");
  const selectedWorkloads = params.getAll("workload").filter((value) => value !== "all");
  const buildQuery = params.get("build_filter") ?? "";
  const platform = params.getAll("platform").filter((value) => value !== "all");
  const observation = params.get("observation");
  const selectedBuild = params.get("build");
  const selectedSource = params.get("source");
  const selectedChannel = params.get("channel");
  const selectedEngine = params.get("engine");
  const allRows = useMemo(
    () => state.kind === "ready" ? rocmMeasurements(state.data).filter((row) => {
      if (!selectedBuild) return true;
      const build = findExactQualificationBuild(row, state.history.builds);
      return build?.build_id === selectedBuild &&
        (!selectedSource || build.source_id === selectedSource) &&
        (!selectedChannel || build.channel === selectedChannel) &&
        (!selectedEngine || build.engine === selectedEngine);
    }) : [],
    [state, selectedBuild, selectedSource, selectedChannel, selectedEngine],
  );
  const exactObservation = observation ? allRows.find((row) => measurementIdentity(row) === observation) : undefined;
  const workload = exactObservation ? [exactObservation.scenario] : selectedWorkloads;
  const rows = useMemo(
    () => filterRows(allRows, model, system, workload, platform).filter(
      (row) => (!observation || measurementIdentity(row) === observation) &&
        (!buildQuery || [row.engine_version, row.qualification_build_id].some((value) => value?.toLowerCase().includes(buildQuery.toLowerCase()))),
    ),
    [allRows, model, system, workload, platform, observation, buildQuery],
  );
  const visibleRows = observation ? rows : latestConfigurations(rows);
  const buildGroups = new Map<string, { tag: string; rows: Measurement[] }>();
  for (const row of [...visibleRows].sort((a, b) => Date.parse(b.measured_at) - Date.parse(a.measured_at))) {
    const key = JSON.stringify([row.engine_repository, row.fork_id, row.channel, row.engine_version]);
    if (!buildGroups.has(key)) buildGroups.set(key, { tag: row.engine_version ?? "Build unavailable", rows: [] });
    buildGroups.get(key)!.rows.push(row);
  }
  const requestedSort = params.get("sort") === "tps" ? "decode" : params.get("sort");
  const sortKey = ["model", "context", "prefill", "decode", "vram"].includes(requestedSort ?? "") ? requestedSort! : "model";
  const descending = params.get("direction") === "desc";
  const numericValue = (row: Measurement, key: string): number | undefined => {
    if (key === "context") {
      const namedSize = row.scenario.match(/^context-(\d+)k$/i);
      return row.context_size ?? (namedSize ? Number(namedSize[1]) * 1024 : undefined);
    }
    return row.metrics[{ prefill: "pp_tps", decode: "tg_tps", vram: "vram_peak_gb" }[key] ?? ""];
  };
  const compareRows = (a: Measurement, b: Measurement) => {
    if (sortKey === "model") return (descending ? -1 : 1) * a.model.localeCompare(b.model) || Date.parse(b.measured_at) - Date.parse(a.measured_at);
    const left = numericValue(a, sortKey), right = numericValue(b, sortKey);
    if (left == null || right == null) return left == null && right == null ? a.model.localeCompare(b.model) : left == null ? 1 : -1;
    return (descending ? -1 : 1) * (left - right) || a.model.localeCompare(b.model);
  };
  const cohortKeys = state.kind === "ready" ? visibleRows.map((row) => comparisonKey(row, state.data.systems)) : [];
  const canRankBuilds = sortKey !== "model" && sortKey !== "context" && cohortKeys.length > 1 && cohortKeys.every((key) => key !== null && key === cohortKeys[0]);
  const orderedBuildGroups = [...buildGroups];
  if (params.get("build_order") === "metric" && canRankBuilds) orderedBuildGroups.sort(([, a], [, b]) => compareRows([...a.rows].sort(compareRows)[0], [...b.rows].sort(compareRows)[0]));
  const gpuFamily = (row: Measurement) => {
    const build = state.kind === "ready" ? findExactQualificationBuild(row, state.history.builds) : undefined;
    return build?.gfx_family ?? packageGpuFamily(row) ?? "GPU family unavailable";
  };
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

  const nextParams = (changes: Record<string, string | string[] | null>) => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(changes)) {
      if (Array.isArray(value)) {
        next.delete(key);
        for (const entry of value) next.append(key, entry);
      } else if (value === null || value === "") next.delete(key);
      else next.set(key, value);
    }
    next.delete("compare");
    next.delete("performance_history");
    return next;
  };
  const navigate = (changes: Record<string, string | string[] | null>) =>
    onNavigate(nextParams({ observation: null, ...changes }));

  function sortHeader(key: string, label: string, definition?: string) {
    return <th scope="col" aria-sort={sortKey === key ? descending ? "descending" : "ascending" : "none"}>
      <span className="performance-sort-heading">
        {definition ? <Tooltip side label={`${label} definition`} content={definition}>{label}</Tooltip> : label}
        <button type="button" className="performance-sort" aria-label={`Sort by ${label}`} onClick={() => navigate({ sort: key,
          direction: sortKey === key ? descending ? "asc" : "desc" : ["prefill", "decode"].includes(key) ? "desc" : "asc" })}>
          {sortKey === key ? descending ? "↓" : "↑" : "↕"}
        </button>
      </span>
    </th>;
  }

  function measurementTable(groups: { key: string; label: string; rows: Measurement[] }[], nightly: boolean) {
    if (state.kind !== "ready") return null;
    return <div className="qualification-table-scroll" role="region" aria-label="Model measurements" tabIndex={0}>
      <table className={`qualification-table performance-measurements ${nightly ? "" : "qualification-stable-table"}`}>
        <thead><tr>
          <th scope="col" className="qualification-family-column">{nightly ? "GPU family" : "Build"}</th>
              {sortHeader("model", "Model")}
              {sortHeader("prefill", "Prefill TPS", "Prompt processing throughput, in tokens per second, reported as pp_tps. Higher is better.")}
              {sortHeader("decode", "Decode TPS", "Token generation throughput, in tokens per second, reported as tg_tps. Higher is better.")}
              {sortHeader("context", "CTX size", "Configured context window capacity in tokens: 4K = 4,096 and 32K = 32,768. A workload label is used when the numeric size is missing.")}
              {sortHeader("vram", "Peak VRAM", "Peak video memory usage, in GB.")}
        </tr></thead>
        {groups.map((group) => <tbody key={group.key}>
          {[...group.rows].sort(compareRows)
            .map((row, index) => <tr className="performance-measurement-row" key={measurementIdentity(row) + measurementTieBreaker(row)}>
              {index === 0 && <th scope="rowgroup" rowSpan={group.rows.length}>
                <Tooltip side label={`${nightly ? "GPU family" : "Build"} ${group.label}`} content={<div>
                  <strong>{group.label}</strong><p>{plural(group.rows.length, "measurement")} · All times UTC</p>
                </div>}>{group.label}</Tooltip>
              </th>}
                <th scope="row"><span className="performance-model-identity"><Tooltip side={!wideEvidence} interactive label={`Measurement details for ${row.model} · ${row.package_os ?? "Unknown OS"} · ${row.measured_at}`}
                  triggerClassName="performance-model-trigger" contentClassName="qualification-popup performance-model-popup"
                  content={<MeasurementEvidence row={row} systems={state.data.systems} history={state.history} buildHref={buildHref} />}>{row.model}</Tooltip>
                <span className="performance-os" role="img" aria-label={row.package_os === "windows" ? "Windows" : row.package_os === "linux" ? "Linux" : "OS unavailable"} title={row.package_os === "windows" ? "Windows" : row.package_os === "linux" ? "Linux" : "OS unavailable"}><PlatformIcon platform={row.package_os ?? ""} />{!row.package_os && "—"}</span></span></th>
                <td>{row.metrics.pp_tps == null
                  ? <Tooltip label="Prefill TPS unavailable" content="Prefill throughput was not recorded for this benchmark.">—</Tooltip>
                  : formatNumber(row.metrics.pp_tps)}</td>
                <td>{row.metrics.tg_tps == null
                  ? <Tooltip label="Decode TPS unavailable" content="Decode throughput was not recorded for this benchmark.">—</Tooltip>
                  : formatNumber(row.metrics.tg_tps)}</td>
                <td>{row.context_size == null && /^context-\d+k$/i.test(row.scenario) ? workloadLabel(row.scenario) : contextLabel(row.context_size)}</td>
                <td>{row.metrics.vram_peak_gb == null ? "—" : formatNumber(row.metrics.vram_peak_gb)}</td>
            </tr>)}
        </tbody>)}
      </table>
    </div>;
  }

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
        <div className="build-browser-toolbar build-filters">{versionFilter}</div>
        <p>No recorded model measurements for ROCm {overview.rocm_version}</p>
        <p>Performance remains unmeasured; no package or qualification conclusion is implied.</p>
      </section>
    );
  }

  return (
    <section className="performance-view" aria-labelledby="performance-heading">
      <div className="performance-heading">
        <div>
          <span className="eyebrow">LLAMA.CPP ROCM · HISTORICAL MEASUREMENTS</span>
          <h2 id="performance-heading">
            Performance details
          </h2>
          {state.kind === "ready" && state.data.benchmarkAssessment && <>
            <p className="performance-intro">{state.data.benchmarkAssessment.message}</p>
          </>}
        </div>
      </div>
      {state.kind === "ready" && (
        <MobileFilters label="Performance filters" count={[model, system.length, selectedWorkloads.length, platform.length, buildQuery, selectedBuild, observation].filter(Boolean).length}>
        <div className="build-browser-toolbar build-filters performance-filter-bar" aria-label="Performance filters">
          {versionFilter}
          <PerformanceFilter label="Measurement platform" value={platform}
            options={[["windows", "Windows"], ["linux", "Linux"]]}
            onSelect={(value) => navigate({ platform: value })} />
          <PerformanceFilter label="Hardware system" value={system}
            options={[...systems.map((entry): [string, string] => [entry, hardwareLabel(entry, allRows, state.data.systems)]),
              ...(allRows.some((row) => row.system_id === null) ? [[missingSystemFilter, "Hardware metadata unavailable"] as [string, string]] : [])]}
            onSelect={(value) => navigate({ system: value })} />
          <PerformanceFilter label="Workload" value={workload}
            options={[...workloads.map((entry): [string, string] => [entry, workloadLabel(entry)])]}
            onSelect={(value) => navigate({ workload: value })} />
          <label className="performance-model-filter">
            Model
            <select
              value={model ?? ""}
              onChange={(event) =>
                navigate({
                  model: event.target.value || null,
                  view: "performance",
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
          <label className="build-search">Find build <input type="search" value={buildQuery} placeholder="Package tag or build ID"
            onChange={(event) => navigate({ build_filter: event.target.value || null })} /></label>
          {selectedBuild && <FilterScope label={`Build: ${allRows[0]?.engine_version ?? selectedBuild}`} onClear={() => navigate({ build: null, source: null, observation: null })} />}
          {observation && <FilterScope label="Exact measurement" onClear={() => navigate({ observation: null })} />}
          {phone && <div className="performance-card-sort"><label>Sort measurements
            <select aria-label="Sort measurements" value={sortKey} onChange={(event) => navigate({ sort: event.target.value })}>
              <option value="model">Model</option><option value="context">Context</option><option value="tps">TPS</option><option value="p95">P95</option><option value="vram">VRAM</option><option value="ttft">TTFT</option>
            </select></label>
            <button type="button" aria-label="Reverse measurement sort" onClick={() => navigate({ direction: descending ? "asc" : "desc" })}>{descending ? "↓" : "↑"}</button>
          </div>}
          {phone && <div className="performance-build-order"><Tooltip label="Build order help" content="Newest orders build groups by their latest measurement. Selected metric orders builds only when every visible row has the same fully recorded model, workload, quantization, OS, and hardware. Choose a metric sort first.">Build order</Tooltip>
            <select aria-label="Build order" value={params.get("build_order") === "metric" && canRankBuilds ? "metric" : "newest"} onChange={(event) => navigate({ build_order: event.target.value === "newest" ? null : "metric" })}>
              <option value="newest">Newest first</option><option value="metric" disabled={!canRankBuilds}>Selected metric</option>
            </select>
          </div>}
          <FilterReset onReset={() => {
            const next = new URLSearchParams(params);
            for (const key of ["build", "source", "model", "system", "workload", "platform", "observation", "engine", "channel", "build_filter", "day", "focus", "package_identity", "sort", "direction", "build_order"])
              next.delete(key);
            next.set("view", "performance");
            onNavigate(next);
          }} />


        </div>
        </MobileFilters>
      )}
      {state.kind !== "ready" && <div className="build-browser-toolbar build-filters">{versionFilter}</div>}

      {state.kind === "loading" && <p role="status">Loading historical measurements…</p>}
      {state.kind === "error" && (
        <div className="notice error" role="alert">
          <strong>Couldn’t load model measurements</strong>
          <p>{state.error}</p>
          <button onClick={() => setRetry((value) => value + 1)}>Retry</button>
        </div>
      )}
      {state.kind === "ready" && <>
        <section className="qualification-matrix" aria-label="Model performance">
          <div className="performance-table-heading">
            {!phone && <h2>Model performance</h2>}
            {state.data.benchmarkAssessment && <p className="performance-last-run">{state.data.benchmarkAssessment.last_run_label}</p>}
          </div>
          {!phone && <label className="performance-build-order"><Tooltip label="Build order help" content="Newest orders build groups by their latest measurement. Selected metric orders builds only when every visible row has the same fully recorded model, workload, quantization, OS, and hardware. Choose a metric sort first.">Build order</Tooltip>
            <select aria-label="Build order" value={params.get("build_order") === "metric" && canRankBuilds ? "metric" : "newest"} onChange={(event) => navigate({ build_order: event.target.value === "newest" ? null : "metric" })}>
              <option value="newest">Newest first</option><option value="metric" disabled={!canRankBuilds}>Selected metric</option>
            </select>
          </label>}
          <div className="qualification-releases">
            {phone ? orderedBuildGroups.map(([key, group]) => <section className="performance-card-group" key={key} aria-label={`Build ${group.tag}`}>
              <header className="performance-card-build">
                <h2>ROCm {session.version} <span className="performance-channel">{group.rows[0].channel === "stable" ? "Stable" : group.rows[0].channel === "nightly" ? "Nightly" : group.rows[0].channel}</span></h2>
                <p>{group.tag} · {group.rows[0].engine === "llamacpp" ? "llama.cpp" : group.rows[0].engine}</p>
              </header>
              {[...group.rows].sort(compareRows).map((row) => <article className="performance-card" key={measurementIdentity(row) + measurementTieBreaker(row)} aria-label={`${row.model} · ${workloadLabel(row.scenario)}`}>
                <h3>{row.model}</h3>
                <p className="performance-card-subtitle">{workloadLabel(row.scenario)} · <PlatformIcon platform={row.package_os ?? ""} /> {row.package_os === "windows" ? "Windows" : row.package_os === "linux" ? "Linux" : "OS unavailable"}{row.channel !== "stable" && ` · ${gpuFamily(row)}`}</p>
                <dl className="performance-card-metrics">
                  <div><dt>TPS</dt><dd>{row.metrics.tps_mean != null || row.metrics.tg_tps != null ? `${formatNumber(row.metrics.tps_mean ?? row.metrics.tg_tps)} tok/s` : "Not recorded"}</dd></div>
                  <div><dt>Peak VRAM</dt><dd>{row.metrics.vram_peak_gb == null ? "Not recorded" : `${formatNumber(row.metrics.vram_peak_gb)} GB`}</dd></div>
                  <div><dt>TTFT</dt><dd>{row.metrics.ttft_ms_mean == null ? "Not recorded" : `${formatNumber(row.metrics.ttft_ms_mean / 1000)} s`}</dd></div>
                </dl>
                <EvidenceDisclosure className="performance-card-evidence" initialOpen={Boolean(observation)}>
                  <MeasurementEvidence row={row} systems={state.data.systems} history={state.history} buildHref={buildHref} />
                </EvidenceDisclosure>
              </article>)}
            </section>) : visibleRows.every((row) => row.channel === "stable")
              ? measurementTable(orderedBuildGroups.map(([key, group]) => ({ key, label: group.tag, rows: group.rows })), false)
              : orderedBuildGroups.map(([key, group]) => {
                const families = new Map<string, Measurement[]>();
                for (const row of group.rows) {
                  const family = gpuFamily(row);
                  families.set(family, [...(families.get(family) ?? []), row]);
                }
                return <section className="qualification-release" key={key}>
                  <header className="qualification-release-heading">
                    <span className="qualification-heading-label">Build</span>
                    <h3><Tooltip side label={`Build ${group.tag}`} content={group.tag}>{group.tag}</Tooltip></h3>
                  </header>
                  {measurementTable([...families].sort(([a], [b]) => a.localeCompare(b)).map(([family, entries]) => ({ key: family, label: family, rows: entries })), true)}
                </section>;
              })}
          </div>
          {!rows.length && <p>No llama.cpp ROCm measurements match these filters.</p>}
        </section>

      </>}
    </section>
  );
}
