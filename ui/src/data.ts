import { z } from "zod";

export const POINTER_URL =
  "https://raw.githubusercontent.com/lemonade-sdk/rocm-readiness/main/data/latest.json";
const time = z
  .string()
  .refine(
    (value) => Number.isFinite(Date.parse(value)),
    "Expected an ISO timestamp",
  );
const count = z.number().int().nonnegative();
const testsSchema = z
  .object({
    passed: count,
    failed: count,
    warned: count.optional(),
    skipped: count.optional(),
    missing: count.optional(),
    total: count,
  })
  .refine((value) => {
    const sum =
      value.passed +
      value.failed +
      (value.warned ?? 0) +
      (value.skipped ?? 0) +
      (value.missing ?? 0);
    const complete =
      value.warned !== undefined &&
      value.skipped !== undefined &&
      value.missing !== undefined;
    return complete ? sum === value.total : sum <= value.total;
  }, "Check counts do not match the total");
export const syncSchema = z.object({
  attempted_at: time,
  status: z.enum(["success", "failed"]),
  last_successful_at: time.nullable(),
  errors: z.array(
    z.object({
      source_id: z.string(),
      record: z.string(),
      field: z.string(),
      reason: z.string(),
    }),
  ),
});
const pointerSchema = z.object({
  schema_version: z.literal(1),
  data_commit: z
    .string()
    .regex(/^[a-f0-9]{40}$/)
    .nullable(),
  index_url: z.string().nullable(),
  sync: syncSchema,
});
const indexSchema = z.object({
  schema_version: z.literal(2),
  generated_at: time,
  default_version: z.string().nullable(),
  versions: z.array(
    z.object({
      rocm_version: z.string().min(1),
      overview: z.string(),
      build_count: count,
    }),
  ),
});
const buildSchema = z.object({
  build_id: z.string(),
  engine: z.string(),
  channel: z.literal("stable"),
  rocm_version: z.string(),
  os: z.string(),
  tag: z.string().nullable().optional(),
  artifact: z.string().nullable().optional(),
  source_id: z.string().nullable().optional(),
  upstream_sha: z.string().nullable().optional(),
  event: z.string().nullable().optional(),
  run_id: z.string().nullable().optional(),
  run_attempt: z.number().int().nonnegative().nullable().optional(),
  source_url: z.string().nullable().optional(),
  results: z.record(z.string(), z.string()).nullable().optional(),
  generated_at: time,
  qualified: z.boolean().nullable().optional(),
  version_qualified: z.boolean().nullable().optional(),
  overall: z.string().nullable().optional(),
  hardware_validated: z.boolean().nullable().optional(),
  report_url: z.string().nullable().optional(),
  gfx_target: z.string().nullable().optional(),
  tests: testsSchema.nullable().optional(),
  gfx: z
    .object({ requested: count, present: count, missing: z.array(z.string()) })
    .nullable()
    .optional(),
});
const historySchema = z.object({
  schema_version: z.literal(2),
  rocm_version: z.string(),
  month: z.string(),
  builds: z.array(buildSchema),
});
const overviewSchema = z.object({
  schema_version: z.literal(2),
  generated_at: time,
  rocm_version: z.string(),
  engines: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      build_count: count,
      platforms: z.array(z.string()),
      latest_builds: z.array(buildSchema),
    }),
  ),
  history: z.array(
    z.object({ month: z.string(), path: z.string(), build_count: count }),
  ),
  performance: z.discriminatedUnion("status", [
    z.object({
      status: z.literal("available"),
      measurement_count: count,
      path: z.string(),
    }),
    z.object({
      status: z.literal("not_measured"),
      measurement_count: z.undefined().optional(),
      path: z.undefined().optional(),
    }),
  ]),
});

export type Sync = z.infer<typeof syncSchema>;
export type Pointer = z.infer<typeof pointerSchema>;
export type Overview = z.infer<typeof overviewSchema>;
export type Build = z.infer<typeof buildSchema>;
export type Session = {
  pointer: Pointer;
  index: z.infer<typeof indexSchema>;
  indexUrl: string;
  version: string | null;
  overview: Overview | null;
};
export type Fetcher = typeof fetch;

export async function loadHistory(
  session: Session,
  fetcher: Fetcher = fetch,
  signal?: AbortSignal,
): Promise<Build[]> {
  if (!session.overview) return [];
  const chunks = await Promise.all(
    session.overview.history.map(async (chunk) => {
      const url = resolveDatasetPath(session.indexUrl, chunk.path);
      const data = await read(url, historySchema, fetcher, signal);
      if (
        data.rocm_version !== session.version ||
        data.month !== chunk.month ||
        data.builds.length !== chunk.build_count
      )
        throw new Error(
          `${url}: history does not match its version, month or build count`,
        );
      if (data.builds.some((build) => build.rocm_version !== session.version))
        throw new Error(
          `${url}: history build version does not match the selected version`,
        );
      return data.builds;
    }),
  );
  const builds = chunks.flat();
  const identities = new Set(
    builds.map((build) =>
      JSON.stringify([build.source_id, build.engine, build.os, build.build_id]),
    ),
  );
  if (identities.size !== builds.length)
    throw new Error("Duplicate build identities in retained history");
  return builds;
}

async function read<T>(
  url: string,
  schema: z.ZodType<T>,
  fetcher: Fetcher,
  signal?: AbortSignal,
): Promise<T> {
  const timeout = AbortSignal.timeout(20_000);
  const response = await fetcher(url, {
    cache: "no-store",
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    redirect: "error",
  });
  if (!response.ok)
    throw new Error(
      `${url}: HTTP ${response.status}. Retry or check the published data.`,
    );
  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    throw new Error(`${url}: invalid JSON. Retry or check the published file.`);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(
      `${url}: invalid ${issue.path.join(".") || "document"} — ${issue.message}`,
    );
  }
  return parsed.data;
}

export function resolveDatasetPath(indexUrl: string, path: string): string {
  if (
    !/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_.-]+)*\.json$/.test(path) ||
    path.split("/").some((part) => part === "." || part === "..")
  ) {
    throw new Error(`Invalid dataset path: ${path}`);
  }
  const root = new URL(".", indexUrl);
  const resolved = new URL(path, root);
  if (!resolved.href.startsWith(root.href))
    throw new Error(`Invalid dataset path: ${path}`);
  return resolved.href;
}

export async function loadVersion(
  session: Session,
  version: string,
  fetcher: Fetcher = fetch,
  signal?: AbortSignal,
): Promise<Session> {
  const row = session.index.versions.find(
    (entry) => entry.rocm_version === version,
  );
  if (!row)
    throw new Error(
      `ROCm ${version} is not available in this dataset. Choose an available version.`,
    );
  const url = resolveDatasetPath(session.indexUrl, row.overview);
  const overview = await read(url, overviewSchema, fetcher, signal);
  if (overview.rocm_version !== version)
    throw new Error(`${url}: overview does not match ROCm ${version}`);
  for (const chunk of overview.history)
    resolveDatasetPath(session.indexUrl, chunk.path);
  if (overview.performance.path)
    resolveDatasetPath(session.indexUrl, overview.performance.path);
  for (const engine of overview.engines) {
    for (const build of engine.latest_builds) {
      if (build.rocm_version !== version || build.engine !== engine.id) {
        throw new Error(
          `${url}: build ${build.build_id} does not match its version or engine`,
        );
      }
    }
  }
  return { ...session, version, overview };
}

export async function loadSession(
  version?: string,
  fetcher: Fetcher = fetch,
  signal?: AbortSignal,
  onPointer?: (pointer: Pointer) => void,
  requireOverview = true,
): Promise<Session> {
  const pointer = await read(POINTER_URL, pointerSchema, fetcher, signal);
  const expected = `https://raw.githubusercontent.com/lemonade-sdk/rocm-readiness/${pointer.data_commit}/data/index.json`;
  if (pointer.data_commit !== null && pointer.index_url !== expected) {
    throw new Error(
      `${POINTER_URL}: index_url must identify the immutable data_commit`,
    );
  }
  if (pointer.data_commit === null && pointer.index_url !== null)
    throw new Error("Invalid publication pointer");
  onPointer?.(pointer);
  if (pointer.data_commit === null || pointer.index_url === null) {
    throw new Error(
      "No successful dataset has been published yet. Check ingestion status and retry.",
    );
  }
  const index = await read(pointer.index_url, indexSchema, fetcher, signal);
  if (
    new Set(index.versions.map((entry) => entry.rocm_version)).size !==
    index.versions.length
  ) {
    throw new Error(`${pointer.index_url}: Duplicate ROCm versions`);
  }
  for (const row of index.versions)
    resolveDatasetPath(pointer.index_url, row.overview);
  if (
    index.versions.length &&
    !index.versions.some((row) => row.rocm_version === index.default_version)
  ) {
    throw new Error(
      `${pointer.index_url}: default_version is not in the catalog`,
    );
  }
  if (!index.versions.length && index.default_version !== null)
    throw new Error(
      `${pointer.index_url}: empty catalog must have a null default_version`,
    );
  const session: Session = {
    pointer,
    index,
    indexUrl: pointer.index_url,
    version: null,
    overview: null,
  };
  const selected = version || index.default_version;
  if (selected && !index.versions.some((row) => row.rocm_version === selected))
    throw new Error(
      `ROCm ${selected} is not available in this dataset. Choose an available version.`,
    );
  if (!requireOverview) return { ...session, version: selected };
  return selected ? loadVersion(session, selected, fetcher, signal) : session;
}
