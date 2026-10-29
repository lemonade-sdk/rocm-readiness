import type { Build } from "./data";
import type { CSSProperties } from "react";

type Segment = { label: string; count: number; tone: string };
function OutcomeBar({
  segments,
  label,
}: {
  segments: Segment[];
  label: string;
}) {
  const total = segments.reduce((sum, entry) => sum + entry.count, 0);
  return (
    <>
      <div className="outcome-bar" role="img" aria-label={label}>
        {segments
          .filter((entry) => entry.count > 0)
          .map((entry) => (
            <span
              key={entry.label}
              className={`segment-${entry.tone}`}
              style={{ width: `${total ? (100 * entry.count) / total : 0}%` }}
            />
          ))}
      </div>
      <div className="outcome-legend">
        {segments
          .filter((entry) => entry.count > 0)
          .map((entry) => (
            <span key={entry.label}>
              <i className={`segment-${entry.tone}`} />
              {entry.count} {entry.label}
            </span>
          ))}
      </div>
    </>
  );
}

export function BuildQualification({
  builds,
  total,
  error,
}: {
  builds: Build[] | null;
  total: number;
  error: string | null;
}) {
  const qualified =
    builds?.filter((build) => build.qualified === true).length ?? 0;
  const unknown =
    builds?.filter((build) => build.qualified == null).length ?? 0;
  const clean = builds?.filter((build) => build.overall === "pass").length ?? 0;
  const warnings =
    builds?.filter((build) => build.overall === "warn").length ?? 0;
  const failed =
    builds?.filter((build) => build.overall === "fail").length ?? 0;
  const other = (builds?.length ?? 0) - clean - warnings - failed;
  return (
    <div className="qualification-stat" aria-label="Build qualification">
      <span className="stat-caption">Qualified builds</span>
      <div className="qualification-head">
        <div>
          <strong>
            {builds
              ? total
                ? `${qualified} / ${total}`
                : "No builds"
              : `— / ${total}`}
          </strong>
          <small>Retained platform builds</small>
        </div>
        <div
          className="qualification-ring"
          aria-hidden="true"
          style={
            {
              "--qualified": `${builds && total ? (qualified / total) * 100 : 0}%`,
            } as CSSProperties
          }
        >
          <b>
            {builds && total
              ? `${Math.round((qualified / total) * 100)}%`
              : "—"}
          </b>
        </div>
      </div>
      {builds && total > 0 && (
        <OutcomeBar
          segments={[
            { label: "clean", count: clean, tone: "pass" },
            { label: "with warnings", count: warnings, tone: "warn" },
            { label: "failed", count: failed, tone: "fail" },
            { label: "unknown", count: other, tone: "unknown" },
          ]}
          label={`${clean} clean pass, ${warnings} with warnings, ${failed} failed, ${other} unknown`}
        />
      )}
      {unknown > 0 && <small>{unknown} qualification unknown</small>}
      {!builds && (
        <small className={error ? "warning-text" : ""}>
          {error
            ? "Build history unavailable. Use Refresh data to retry."
            : "Loading qualification history…"}
        </small>
      )}
    </div>
  );
}

function Checks({ tests }: { tests: NonNullable<Build["tests"]> }) {
  return (
    <div className="checks-visual">
      <div className="checks-heading">
        <span>Checks passed</span>
        <strong>
          {tests.passed} / {tests.total}
        </strong>
      </div>
      {tests.warned !== undefined &&
      tests.skipped !== undefined &&
      tests.missing !== undefined ? (
        <OutcomeBar
          label={`${tests.passed} passed, ${tests.warned} warnings, ${tests.failed} failed, ${tests.skipped} skipped, ${tests.missing} missing`}
          segments={[
            { label: "passed", count: tests.passed, tone: "pass" },
            { label: "warnings", count: tests.warned, tone: "warn" },
            { label: "failed", count: tests.failed, tone: "fail" },
            { label: "skipped", count: tests.skipped, tone: "skip" },
            { label: "missing", count: tests.missing, tone: "unknown" },
          ]}
        />
      ) : (
        <p>Detailed check breakdown unavailable</p>
      )}
    </div>
  );
}

export function LatestChecks({ builds }: { builds: Build[] }) {
  const available = builds.length > 0 && builds.every((build) => build.tests);
  const required = (key: "passed" | "failed" | "total") =>
    builds.reduce((sum, build) => sum + (build.tests?.[key] ?? 0), 0);
  const optional = (key: "warned" | "skipped" | "missing") =>
    builds.every((build) => build.tests?.[key] !== undefined)
      ? builds.reduce((sum, build) => sum + build.tests![key]!, 0)
      : undefined;
  const total = {
    passed: required("passed"),
    failed: required("failed"),
    total: required("total"),
    warned: optional("warned"),
    skipped: optional("skipped"),
    missing: optional("missing"),
  };
  return (
    <div className="latest-checks-stat">
      <span className="stat-caption">Latest package checks</span>
      {available ? <Checks tests={total} /> : <strong>Unavailable</strong>}
      <small>
        {builds.length
          ? `Latest ${[...new Set(builds.map((build) => (build.os === "linux" ? "Linux" : build.os === "windows" ? "Windows" : build.os)))].join(" + ")} packages`
          : "No package evidence"}
      </small>
    </div>
  );
}

export function PlatformChecks({ build }: { build: Build }) {
  return (
    <>
      {build.tests ? (
        <Checks tests={build.tests} />
      ) : (
        <p>Check breakdown unavailable</p>
      )}
      {build.gfx && (
        <div className="gpu-coverage">
          <div className="evidence-line">
            <span>Compiled GPU targets</span>
            <strong>
              {build.gfx.present} / {build.gfx.requested}
            </strong>
          </div>
          <div
            className="target-blocks"
            role="img"
            aria-label={`${build.gfx.present} of ${build.gfx.requested} requested GPU targets compiled`}
          >
            {Array.from(
              { length: Math.min(build.gfx.requested, 64) },
              (_, i) => (
                <i
                  key={i}
                  className={
                    (i + 0.5) / Math.min(build.gfx!.requested, 64) <=
                    build.gfx!.present / build.gfx!.requested
                      ? "present"
                      : ""
                  }
                />
              ),
            )}
          </div>
        </div>
      )}
    </>
  );
}
