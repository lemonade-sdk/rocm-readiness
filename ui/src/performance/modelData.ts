import { z } from "zod";

export const timestamp = z
  .string()
  .refine(
    (value) => Number.isFinite(Date.parse(value)),
    "Expected an ISO timestamp",
  );
export const text = z.string().min(1);
export const nullableText = text.nullable().optional();
export const nullableCount = z
  .number()
  .finite()
  .int()
  .nonnegative()
  .nullable()
  .optional();

export const measurementSchema = z.object({
  source_id: text,
  source_url: z.string().url().nullable().optional(),
  run_url: z.string().url().nullable().optional(),
  run_id: nullableText,
  lemonade_version: nullableText,
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

export const systemSchema = z
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

export const performanceSchema = z.object({
  schema_version: z.literal(2),
  measurements: z.array(measurementSchema),
  systems: z.array(systemSchema),
});

export type Measurement = z.infer<typeof measurementSchema>;
export type SystemRecord = z.infer<typeof systemSchema>;
export type PerformanceData = {
  measurements: Measurement[];
  systems: Map<string, SystemRecord>;
};
export const metricInfo: Record<string, { label: string; unit: string }> = {
  tps_mean: { label: "Mean throughput", unit: "tok/s" },
  tps_p95: { label: "P95 throughput", unit: "tok/s" },
  tg_tps: { label: "Token generation throughput", unit: "tok/s" },
  pp_tps: { label: "Prompt processing throughput", unit: "tok/s" },
  ttft_ms_mean: { label: "Mean time to first token", unit: "s" },
  ttft_ms_best: { label: "Best time to first token", unit: "s" },
  vram_peak_gb: { label: "Peak reported VRAM", unit: "GB" },
};
export const missingSystemFilter = "__missing_hardware__";

export function sourceSystemKey(sourceId: string, systemId: string) {
  return JSON.stringify([sourceId, systemId]);
}

export function errorMessage(reason: unknown, fallback: string) {
  return reason instanceof Error ? reason.message : fallback;
}

export function isAbort(reason: unknown) {
  return reason instanceof DOMException && reason.name === "AbortError";
}

export function formatDate(value: string) {
  return (
    new Intl.DateTimeFormat("en", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "UTC",
    }).format(new Date(value)) + " UTC"
  );
}

export function formatNumber(value: number) {
  return new Intl.NumberFormat("en", { maximumFractionDigits: 2 }).format(
    value,
  );
}

export function metricName(name: string) {
  return metricInfo[name]?.label ?? name.replaceAll("_", " ");
}

export function metricValue(name: string, value: number) {
  const unit = metricInfo[name]?.unit;
  if (name.startsWith("ttft_ms_")) value /= 1000;
  return unit
    ? `${formatNumber(value)} ${unit}`
    : `${formatNumber(value)} (unit unavailable)`;
}

export function packageLabel(row: Measurement) {
  return row.engine_version ?? "Engine tag unavailable";
}

export function stableMeasurements(data: PerformanceData) {
  return data.measurements.filter(
    (row) =>
      row.engine === "llamacpp" &&
      row.channel === "stable" &&
      row.backend === "rocm",
  );
}

export function canonical(value: unknown): unknown {
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

export function hardwareFingerprint(record: SystemRecord) {
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

export function hasCompleteHardwareIdentity(record: SystemRecord) {
  return (
    Boolean(record.cpu && record.gpu && record.os) &&
    Array.isArray(record.gpu_full) &&
    record.gpu_full.length > 0 &&
    typeof record.ram_gb === "number" &&
    typeof record.vram_gb === "number"
  );
}

export function recordFor(
  row: Measurement,
  systems: Map<string, SystemRecord>,
) {
  return row.system_id
    ? systems.get(sourceSystemKey(row.source_id, row.system_id))
    : undefined;
}

export function comparisonKey(
  row: Measurement,
  systems: Map<string, SystemRecord>,
) {
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
    row.lemonade_version ?? null,
  ]);
}

export function measurementTieBreaker(row: Measurement) {
  return JSON.stringify([
    row.measured_at,
    row.source_id,
    row.model,
    row.quant,
    row.scenario,
    row.system_id,
    row.context_size,
    row.input_tokens,
    row.run_url,
    row.engine_version ?? "",
    row.package_url ?? "",
    row.qualification_build_id ?? "",
    canonical(row.metrics),
  ]);
}

export function latestByComparisonKey(
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

export function systemSummary(
  row: Measurement,
  systems: Map<string, SystemRecord>,
) {
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

export function plural(count: number, singular: string) {
  return `${count} ${count === 1 ? singular : `${singular}s`}`;
}

export const fixedReference = {
  model: "Gemma-4-31B-it-GGUF",
  quant: "Q4_K_M",
  scenario: "context-32k",
  context: 32768,
};

export function isFixedReference(row: Measurement) {
  return (
    row.model === fixedReference.model &&
    row.quant === fixedReference.quant &&
    row.scenario === fixedReference.scenario &&
    row.context_size === fixedReference.context
  );
}
