import type { Build } from "../data";
import type { ExecutionAttempt } from "./executions";

export function BenchmarkExecutions({
  attempts,
  visibleBuilds,
}: {
  attempts: ExecutionAttempt[];
  visibleBuilds: Build[];
}) {
  if (!attempts.length) return null;
  const unlinked = attempts.filter(
    (row) =>
      !visibleBuilds.some(
        (build) =>
          row.qualification_build_id === build.build_id &&
          row.channel === build.channel &&
          row.package_os === build.os,
      ),
  );
  const issues = (["failed", "partial", "unknown"] as const)
    .map((status) => ({
      status,
      rows: unlinked.filter((row) => row.execution_status === status),
    }))
    .filter((group) => group.rows.length);
  return (
    <p className="benchmark-executions">
      Benchmark execution is separate from qualification.{" "}
      {issues.length ? (
        <>
          Not linked to a build in this timeline:{" "}
          {issues.map(({ status, rows }, index) => (
            <span key={status}>
              {index > 0 ? ", " : ""}
              <a
                className={`execution-status ${status}`}
                href={rows[0].source_url}
                target="_blank"
                rel="noreferrer"
              >
                {rows.length} {status === "unknown" ? "incomplete" : status}
              </a>{" "}
              (
              {[...new Set(rows.map((row) => row.measured_at.slice(0, 10)))]
                .sort()
                .join(", ")}
              )
            </span>
          ))}
          .
        </>
      ) : (
        <>Recorded issues appear beside their builds.</>
      )}
    </p>
  );
}
