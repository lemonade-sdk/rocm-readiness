import { useEffect, useState } from "react";
import { resolveDatasetPath } from "../data";
import type { Fetcher, Session } from "../data";
import {
  performanceSchema,
  Measurement,
  SystemRecord,
  PerformanceData,
  sourceSystemKey,
  errorMessage,
  formatDate,
  metricValue,
  packageLabel,
  hardwareFingerprint,
  hasCompleteHardwareIdentity,
  recordFor,
  measurementTieBreaker,
  systemSummary,
  isFixedReference,
} from "./modelData";

export function VulkanComparison({
  session,
  rows,
  systems,
  fetcher,
}: {
  session: Session;
  rows: Measurement[];
  systems: Map<string, SystemRecord>;
  fetcher: Fetcher;
}) {
  const [state, setState] = useState<{
    data?: PerformanceData;
    error?: string;
  }>({});
  const [retry, setRetry] = useState(0);
  const path = session.index.comparison_performance?.path;
  useEffect(() => {
    setState({});
    if (!path) return;
    const controller = new AbortController();
    const load = async () => {
      const url = resolveDatasetPath(session.indexUrl, path);
      const response = await fetcher(url, {
        signal: controller.signal,
        redirect: "error",
        cache: "no-store",
      });
      if (!response.ok)
        throw new Error(`Vulkan baseline HTTP ${response.status}`);
      const parsed = performanceSchema.parse(await response.json());
      if (
        parsed.measurements.length !==
        session.index.comparison_performance?.count
      )
        throw new Error(
          "Baseline measurement count does not match the pinned index",
        );
      if (
        parsed.measurements.some(
          (row) =>
            !["vulkan", "hrx"].includes(row.backend) ||
            row.rocm_version != null ||
            row.qualification_build_id != null ||
            row.package_url != null ||
            row.package_os != null,
        )
      )
        throw new Error(
          "Baseline has conflicting ROCm package or qualification identity",
        );
      const records = new Map<string, SystemRecord>();
      for (const system of parsed.systems) {
        const key = sourceSystemKey(system.source_id, system.id);
        if (records.has(key))
          throw new Error("Duplicate baseline hardware identity");
        records.set(key, system);
      }
      if (!controller.signal.aborted)
        setState({
          data: { measurements: parsed.measurements, systems: records },
        });
    };
    void load().catch((reason) => {
      if (!controller.signal.aborted)
        setState({
          error: errorMessage(reason, "Baseline could not be loaded"),
        });
    });
    return () => controller.abort();
  }, [session, path, retry, fetcher]);
  function key(row: Measurement, records: Map<string, SystemRecord>) {
    const system = recordFor(row, records);
    if (
      !system ||
      !hasCompleteHardwareIdentity(system) ||
      !row.quant ||
      !row.context_size ||
      row.input_tokens == null ||
      !row.lemonade_version
    )
      return null;
    return JSON.stringify([
      row.source_id,
      hardwareFingerprint(system),
      row.engine,
      row.model,
      row.quant,
      row.scenario,
      row.context_size,
      row.input_tokens,
      row.package_os ?? system.os,
      row.lemonade_version,
    ]);
  }
  const pairs: [Measurement, Measurement][] = [];
  if (state.data)
    for (const row of rows.filter(isFixedReference)) {
      const identity = key(row, systems);
      if (!identity) continue;
      const candidates = state.data.measurements
        .filter(
          (other) =>
            other.backend === "vulkan" &&
            other.rocm_version == null &&
            isFixedReference(other) &&
            key(other, state.data!.systems) === identity,
        )
        .sort(
          (a, b) =>
            Date.parse(b.measured_at) - Date.parse(a.measured_at) ||
            measurementTieBreaker(b).localeCompare(measurementTieBreaker(a)),
        );
      if (candidates.length) pairs.push([row, candidates[0]]);
    }
  const latest = pairs.sort(
    (a, b) => Date.parse(b[0].measured_at) - Date.parse(a[0].measured_at),
  )[0];
  return (
    <section
      className="performance-comparison"
      aria-label="Fixed reference Vulkan comparison"
    >
      <h3>Fixed reference: ROCm and Vulkan</h3>
      <p>
        Latest compatible observations in this immutable snapshot, matched on
        ordinary Gemma 31B, Q4_K_M, 32K context, input tokens, physical
        system/OS and Lemonade version. Dates and engine revisions may differ;
        this is an observed configuration comparison and does not isolate a
        backend’s causal effect.
      </p>
      {state.error ? (
        <p role="alert">
          Vulkan baseline unavailable: {state.error}{" "}
          <button onClick={() => setRetry((value) => value + 1)}>
            Retry Vulkan baseline
          </button>
        </p>
      ) : !path ? (
        <p>Vulkan baseline unavailable in this dataset.</p>
      ) : !state.data ? (
        <p role="status">Loading Vulkan baseline…</p>
      ) : !latest ? (
        <p>
          No compatible Vulkan baseline with complete hardware and workload
          metadata.
        </p>
      ) : (
        <>
          <p>
            {systemSummary(latest[0], systems)} · {latest[0].input_tokens} input
            tokens
          </p>
          <div className="performance-table-wrap">
            <table>
              <caption>Observed backend configurations</caption>
              <thead>
                <tr>
                  <th>Backend / actual engine package</th>
                  <th>Measured</th>
                  <th>Generation</th>
                  <th>Prompt processing</th>
                  <th>TTFT</th>
                  <th>Peak reported VRAM</th>
                  <th>Evidence</th>
                </tr>
              </thead>
              <tbody>
                {latest.map((row) => (
                  <tr key={row.backend}>
                    <th scope="row">
                      {row.backend} · {row.engine_repository} ·{" "}
                      {packageLabel(row)}
                    </th>
                    <td>{formatDate(row.measured_at)}</td>
                    {["tg_tps", "pp_tps", "ttft_ms_mean", "vram_peak_gb"].map(
                      (metric) => (
                        <td key={metric}>
                          {typeof row.metrics[metric] === "number"
                            ? metricValue(metric, row.metrics[metric])
                            : "Not reported"}
                        </td>
                      ),
                    )}
                    <td>
                      {row.run_url ? (
                        <a href={row.run_url} target="_blank" rel="noreferrer">
                          Producing run ↗
                        </a>
                      ) : (
                        "Run unavailable"
                      )}
                      {" · "}
                      {row.source_url && (
                        <a
                          href={row.source_url}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Pinned source ↗
                        </a>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p>
            Vulkan is baseline evidence with no ROCm qualification identity.
            Peak reported VRAM may include shared memory on integrated GPUs.
          </p>
        </>
      )}
    </section>
  );
}
