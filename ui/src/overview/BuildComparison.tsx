import type { Build } from "../data";
import { checkChanges } from "./comparison";

function reportDate(value: string) {
  return (
    new Intl.DateTimeFormat("en", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "UTC",
    }).format(new Date(value)) + " UTC"
  );
}
function outcome(value: string) {
  return (
    (
      {
        pass: "passed",
        fail: "failed",
        warn: "warning",
        skip: "skipped",
        missing: "missing",
      } as Record<string, string>
    )[value] ?? value
  );
}
export function BuildComparison({
  current,
  previous,
  kind,
}: {
  current: Build;
  previous: Build;
  kind: "qualification" | "checks";
}) {
  const changes = checkChanges(current, previous);
  return (
    <>
      <span role="heading" aria-level={4} className="comparison-title">
        Since the previous build
      </span>
      <span className="comparison-summary">
        {kind === "qualification" ? (
          <span>
            {current.qualified === previous.qualified
              ? `Shipping readiness unchanged: ${current.qualified ? "qualified" : "not qualified"}.`
              : `Shipping readiness: ${previous.qualified ? "qualified" : "not qualified"} → ${current.qualified ? "qualified" : "not qualified"}.`}
          </span>
        ) : (
          <>
            {changes?.transitions.map((entry) => (
              <span key={`${entry.from}:${entry.to}`}>
                {entry.count} {entry.count === 1 ? "check" : "checks"}:{" "}
                {outcome(entry.from)} → {outcome(entry.to)}.
              </span>
            ))}
            {changes && changes.added > 0 && (
              <span>{changes.added} checks added to reported coverage.</span>
            )}
            {changes && changes.removed > 0 && (
              <span>
                {changes.removed} checks absent from current reported coverage.
              </span>
            )}
            {changes &&
              !changes.transitions.length &&
              !changes.added &&
              !changes.removed && (
                <span>No recorded check-result changes.</span>
              )}
          </>
        )}
      </span>
      <table
        className="comparison-table"
        aria-label="Compared builds and report dates"
      >
        <thead>
          <tr>
            <th scope="col">Report</th>
            <th scope="col">Build</th>
            <th scope="col">Reported at</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <th scope="row">Previous</th>
            <td>{previous.tag}</td>
            <td>
              <time dateTime={previous.generated_at}>
                {reportDate(previous.generated_at)}
              </time>
            </td>
          </tr>
          <tr>
            <th scope="row">Current</th>
            <td>{current.tag}</td>
            <td>
              <time dateTime={current.generated_at}>
                {reportDate(current.generated_at)}
              </time>
            </td>
          </tr>
        </tbody>
      </table>
    </>
  );
}
