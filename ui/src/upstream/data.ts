import { z } from "zod";
import { readJson, resolveDatasetPath } from "../data";
import type { Fetcher, Session } from "../data";

const count = z.number().int().nonnegative();
const time = z
  .string()
  .refine((value) => Number.isFinite(Date.parse(value)), "Expected an ISO timestamp");
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const states = ["passed", "failed", "other", "stalled", "skipped", "running"] as const;

const cellSchema = z.object({
  passed: count,
  failed: count,
  other: count,
  stalled: count,
  skipped: count,
  running: count,
  slow: count,
});
const gateEntry = z.object({
  number: z.number().int().positive(),
  url: z.string().url(),
  author: z.string().nullable().optional(),
  verdict: z.enum(["passed", "failed", "not_triggered", "no_result"]),
  check_url: z.string().nullable().optional(),
  main: z.enum(["passed", "failed"]).nullable().optional(),
  main_url: z.string().nullable().optional(),
});
const jobSchema = z.object({
  id: z.string(),
  label: z.string(),
  category: z.enum(["tests", "builds", "nightlies", "releases"]),
  workflow: z.string(),
  target: z.string(),
  stack: z.enum(["rocm", "vulkan", "npu"]),
  os: z.enum(["linux", "windows"]),
  where: z.string(),
  cadence: z.string(),
  daily: z.record(day, cellSchema),
  decided: count,
  passed: count,
  started: count,
  skipped: count,
  stalled: count,
  last_ran: day.nullable(),
  quiet_days: z.array(day),
  median_queue_seconds: count.nullable(),
  failed_steps: z.record(z.string(), count),
  gate: z
    .object({
      merged: count,
      passed: count,
      failed: count,
      not_triggered: count,
      no_result: count,
      red: z.array(gateEntry),
      escaped: z.array(gateEntry),
    })
    .nullable(),
});
const platformSchema = z.object({
  built: z.boolean(),
  built_rate: z.number().nullable(),
  tested: z.boolean(),
  tested_rate: z.number().nullable(),
  shipped: z.string().nullable().optional(),
});
const projectSchema = z.object({
  id: z.string(),
  label: z.string(),
  repository: z.string(),
  default_branch: z.string(),
  note: z.string().nullable().optional(),
  forks: z.array(
    z.object({
      repository: z.string(),
      role: z.string(),
      channel: z.enum(["stable", "nightly", "preview"]).optional(),
    }),
  ),
  badge: z.object({ state: z.enum(["up", "partial", "down"]), reason: z.string() }),
  kpis: z.object({
    decided: count,
    passed: count,
    pass_rate: z.number().nullable(),
    not_running: count,
    merged_red: count,
  }),
  jobs: z.array(jobSchema),
  platforms: z.object({ linux: platformSchema, windows: platformSchema }),
  findings: z.array(
    z.object({ kind: z.string(), job: z.string().nullable(), head: z.string(), body: z.string() }),
  ),
  coverage: z.object({ complete: z.boolean() }).passthrough(),
  files: z.array(z.object({ month: z.string(), path: z.string(), run_count: count })),
});
export const upstreamOverviewSchema = z.object({
  schema_version: z.literal(1),
  generated_at: time,
  window: z.object({ start: day, end: day, days: count }),
  client_rule: z.object({ targets: z.array(z.string()) }).passthrough(),
  projects: z.array(projectSchema),
});
const runSchema = z.object({
  job: z.string(),
  run_id: z.string(),
  job_id: z.string(),
  day,
  created_at: time,
  event: z.string().nullable(),
  ref: z.string().nullable(),
  sha: z.string().nullable(),
  state: z.enum(states),
  failed_step: z.string().nullable(),
  queue_seconds: count.nullable(),
  runner: z.string().nullable(),
  url: z.string().url(),
  pr: gateEntry.pick({ number: true, url: true, verdict: true }).extend({
    author: z.string().nullable().optional(),
    check_url: z.string().nullable().optional(),
  }).optional(),
});
const runFileSchema = z.object({
  schema_version: z.literal(1),
  project: z.string(),
  month: z.string(),
  runs: z.array(runSchema),
});

export type UpstreamOverview = z.infer<typeof upstreamOverviewSchema>;
export type Project = z.infer<typeof projectSchema>;
export type Job = z.infer<typeof jobSchema>;
export type Cell = z.infer<typeof cellSchema>;
export type Run = z.infer<typeof runSchema>;
export const CATEGORIES = ["tests", "builds", "nightlies", "releases"] as const;

export function upstreamEntry(session: Session) {
  return session.index.upstream?.overview ?? null;
}

export async function loadUpstream(
  session: Session,
  fetcher: Fetcher = fetch,
  signal?: AbortSignal,
): Promise<UpstreamOverview | null> {
  const path = upstreamEntry(session);
  if (!path) return null;
  const url = resolveDatasetPath(session.indexUrl, path);
  const data = await readJson(url, upstreamOverviewSchema, fetcher, signal);
  const ids = new Set(data.projects.map((p) => p.id));
  if (ids.size !== data.projects.length) throw new Error(`${url}: duplicate project ids`);
  for (const project of data.projects)
    for (const chunk of project.files) resolveDatasetPath(session.indexUrl, chunk.path);
  return data;
}

/** Every run of a project in the window, read from its monthly files. */
export async function loadRuns(
  session: Session,
  project: Project,
  fetcher: Fetcher = fetch,
  signal?: AbortSignal,
): Promise<Run[]> {
  const chunks = await Promise.all(
    project.files.map(async (chunk) => {
      const url = resolveDatasetPath(session.indexUrl, chunk.path);
      const data = await readJson(url, runFileSchema, fetcher, signal);
      if (data.project !== project.id || data.month !== chunk.month || data.runs.length !== chunk.run_count)
        throw new Error(`${url}: run file does not match its project, month or count`);
      return data.runs;
    }),
  );
  return chunks.flat();
}

/** Days of the window, oldest first. */
export function windowDays(overview: UpstreamOverview, last?: number): string[] {
  const out: string[] = [];
  const end = new Date(`${overview.window.end}T00:00:00Z`);
  for (let i = overview.window.days - 1; i >= 0; i--) {
    const d = new Date(end);
    d.setUTCDate(end.getUTCDate() - i);
    out.push(d.toISOString().slice(0, 10));
  }
  return last ? out.slice(-last) : out;
}

export function emptyCell(): Cell {
  return { passed: 0, failed: 0, other: 0, stalled: 0, skipped: 0, running: 0, slow: 0 };
}

export function sumCells(jobs: Job[], dayKey: string): Cell {
  const total = emptyCell();
  for (const job of jobs) {
    const cell = job.daily[dayKey];
    if (!cell) continue;
    for (const key of Object.keys(total) as (keyof Cell)[]) total[key] += cell[key];
  }
  return total;
}

/** Day colour from that day's pass rate, the board's 95% / 80% thresholds. */
export function cellState(cell: Cell | undefined): "good" | "warn" | "bad" | "stall" | "skip" | "idle" | "none" {
  if (!cell) return "idle";
  const decided = cell.passed + cell.failed;
  const ran = decided + cell.other + cell.running;
  if (!ran) return cell.stalled ? "stall" : cell.skipped ? "skip" : "idle";
  if (!decided) return "none";
  const rate = (100 * cell.passed) / decided;
  return rate >= 95 ? "good" : rate >= 80 ? "warn" : "bad";
}

/** The filter: everything, one software stack, or one GPU target. */
export function keepJob(lens: string) {
  return (job: Job) => lens === "all" || job.stack === lens || job.target === lens;
}

export function rate(jobs: Job[]) {
  const decided = jobs.reduce((n, j) => n + j.decided, 0);
  const passed = jobs.reduce((n, j) => n + j.passed, 0);
  return { decided, passed, pct: decided ? Math.round((100 * passed) / decided) : null };
}

export function notRunning(job: Job) {
  return job.category === "tests" && (job.started === 0 || job.quiet_days.length > 0);
}

export function mergedRed(jobs: Job[]) {
  return new Set(jobs.flatMap((j) => (j.gate ? j.gate.red.map((g) => g.number) : []))).size;
}
