import type { ExecutionAttempt } from "./executions";

const labels = {
  passed: "Passed",
  failed: "Failed",
  partial: "Partial",
  unknown: "Incomplete evidence",
};
export function BenchmarkExecutions({
  attempts,
}: {
  attempts: ExecutionAttempt[];
}) {
  if (!attempts.length) return null;
  return (
    <section className="benchmark-executions" aria-label="Benchmark executions">
      <h4>Benchmark executions</h4>
      <p>
        Benchmark completion, separate from build qualification and model
        accuracy.
      </p>
      <div className="execution-summary">
        {(["passed", "failed", "partial", "unknown"] as const).map((status) => (
          <span key={status} className={`execution-status ${status}`}>
            {labels[status]}:{" "}
            {attempts.filter((row) => row.execution_status === status).length}
          </span>
        ))}
      </div>
      <details>
        <summary>Inspect benchmark attempts</summary>
        <ul className="execution-attempts">
          {attempts.map((row, index) => (
            <li key={`${row.source_url}:${row.source_pointer}:${index}`}>
              <strong className={`execution-status ${row.execution_status}`}>
                {labels[row.execution_status]}
              </strong>{" "}
              {row.model} · {row.engine_version ?? "Package tag unavailable"} ·{" "}
              {row.package_os} · {row.scenario}
              {row.context_size !== null &&
                ` · context ${row.context_size}`} ·{" "}
              {new Date(row.measured_at).toISOString().slice(0, 10)}
              <div>
                {typeof row.hardware.cpu === "string"
                  ? row.hardware.cpu
                  : "CPU not recorded"}
                {" · "}
                {Array.isArray(row.hardware.gpu)
                  ? row.hardware.gpu
                      .map((gpu) =>
                        typeof gpu === "object" && gpu && "name" in gpu
                          ? String(gpu.name)
                          : "GPU not recorded",
                      )
                      .join(", ")
                  : "GPU not recorded"}
              </div>
              <a href={row.source_url} target="_blank" rel="noreferrer">
                Source report
              </a>
              {" · "}
              <a href={row.package_url} target="_blank" rel="noreferrer">
                Engine package
              </a>
              {" · "}
              <span>Record {row.source_pointer || "/"}</span>
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}
