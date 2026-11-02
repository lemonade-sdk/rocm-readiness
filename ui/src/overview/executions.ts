import { z } from "zod";
import {
  readJson,
  resolveDatasetPath,
  type Fetcher,
  type Session,
} from "../data";

const attemptSchema = z.object({
  source_id: z.string().min(1),
  source_url: z
    .string()
    .url()
    .refine((v) => v.startsWith("https://")),
  source_pointer: z.string(),
  engine: z.string(),
  channel: z.enum(["stable", "nightly"]),
  rocm_version: z.string(),
  engine_version: z.string().nullable(),
  qualification_build_id: z.string().nullable().optional(),
  model: z.string(),
  execution_status: z.enum(["passed", "failed", "partial", "unknown"]),
  measured_at: z.string().refine((v) => Number.isFinite(Date.parse(v))),
  package_os: z.string(),
  package_url: z
    .string()
    .url()
    .refine((v) => v.startsWith("https://")),
  scenario: z.string(),
  context_size: z.number().nonnegative().nullable(),
  hardware: z.record(z.string(), z.unknown()),
});
const executionSchema = z.object({
  schema_version: z.literal(1),
  rocm_version: z.string(),
  attempts: z.array(attemptSchema),
  summaries: z.array(z.unknown()),
});
export type ExecutionAttempt = z.infer<typeof attemptSchema>;

export async function loadExecutions(
  session: Session,
  fetcher: Fetcher,
  signal?: AbortSignal,
): Promise<ExecutionAttempt[]> {
  const reference = session.overview?.execution;
  if (!reference) return [];
  if (reference.path !== `rocm/${session.version}/executions.json`)
    throw new Error(
      "Execution inventory path does not match the selected ROCm version",
    );
  const data = await readJson(
    resolveDatasetPath(session.indexUrl, reference.path),
    executionSchema,
    fetcher,
    signal,
  );
  if (
    data.rocm_version !== session.version ||
    data.attempts.length !== reference.attempt_count
  )
    throw new Error("Execution inventory does not match its overview");
  for (const row of data.attempts) {
    if (
      row.rocm_version !== session.version ||
      !session.overview!.engines.some((engine) => engine.id === row.engine)
    )
      throw new Error(
        "Execution attempt does not match its ROCm version or engine",
      );
    if (
      session.index.sources &&
      !session.index.sources.some((source) => source.id === row.source_id)
    )
      throw new Error("Execution attempt references an unknown source");
  }
  return data.attempts;
}
