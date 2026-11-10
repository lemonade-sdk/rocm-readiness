import { useEffect, useMemo, useState } from "react";
import type { Build, Fetcher, Session } from "../data";
import { findExactQualificationBuild, readPerformance, rocmMeasurements, type PerformanceData } from "../performance/PerformanceView";

type Measurement = PerformanceData["measurements"][number];

export function useBuildMeasurements(session: Session, history: Build[] | null, fetcher: Fetcher) {
  const [result, setResult] = useState<{ session: Session; data?: PerformanceData; error?: true }>();
  const [retry, setRetry] = useState(0);
  const available = session.overview?.performance.status === "available" && Boolean(session.overview.performance.path);
  useEffect(() => {
    if (!available) return;
    const controller = new AbortController();
    readPerformance(session, controller.signal, fetcher).then(
      (data) => { if (!controller.signal.aborted) setResult({ session, data }); },
      () => { if (!controller.signal.aborted) setResult({ session, error: true }); },
    );
    return () => controller.abort();
  }, [session, available, fetcher, retry]);

  const data = result?.session === session ? result.data : undefined;
  const matches = useMemo(() => {
    const byId = new Map<string, Build[]>();
    for (const build of history ?? []) {
      const candidates = byId.get(build.build_id) ?? [];
      candidates.push(build);
      byId.set(build.build_id, candidates);
    }
    const matched = new Map<Build, Measurement[]>();
    for (const row of data ? rocmMeasurements(data) : []) {
      const build = findExactQualificationBuild(row, byId.get(row.qualification_build_id ?? "") ?? []);
      if (!build) continue;
      const rows = matched.get(build) ?? [];
      rows.push(row);
      matched.set(build, rows);
    }
    return matched;
  }, [data, history]);

  const message = !available ? "No matched benchmarks"
    : result?.session !== session ? "Loading model performance…"
    : result.error ? "Model performance unavailable" : "";
  return {
    data, matches, message, retry: result?.session === session && result.error ? () => {
      setResult(undefined);
      setRetry((value) => value + 1);
    } : undefined,
  };
}

