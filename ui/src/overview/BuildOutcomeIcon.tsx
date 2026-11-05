export function BuildOutcomeIcon({
  outcome,
}: {
  outcome: "pass" | "warn" | "fail" | null;
}) {
  return (
    <svg
      className={`build-outcome-bar ${outcome ?? "unknown"}`}
      width="42"
      height="6"
      viewBox="0 0 42 6"
      aria-hidden="true"
      focusable="false"
    >
      <rect
        x="1"
        y="1"
        width="40"
        height="4"
        fill={outcome === "pass" ? "currentColor" : "none"}
        stroke="currentColor"
        strokeDasharray={outcome === null ? "2 2" : undefined}
      />
      {outcome === "warn" && (
        <rect x="1" y="1" width="20" height="4" fill="currentColor" />
      )}
    </svg>
  );
}
