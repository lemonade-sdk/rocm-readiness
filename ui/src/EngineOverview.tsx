import { Link } from "react-router";
import type { Build, Overview } from "./data";
import { PlatformChecks } from "./ReadinessVisuals";

type Props = {
  engines: Overview["engines"];
  version: string;
};

function engineLink(version: string, engine: string, build?: Build) {
  const query = new URLSearchParams({ version, view: "engine", engine });
  if (build) {
    query.set("channel", build.channel);
    query.set("platform", build.os);
    query.set("build", build.build_id);
    if (build.source_id) query.set("source", build.source_id);
  }
  return `?${query}`;
}

export function EngineOverview({ engines, version }: Props) {
  return (
    <section aria-label="Engine readiness" className="grid items-start gap-6">
      {engines
        .filter((engine) => engine.latest_builds.length > 0)
        .map((engine) => (
          <article className="card engine-card" key={engine.id}>
            <div className="card-heading">
              <div className="engine-identity">
                <span className="engine-icon" aria-hidden="true">
                  ⌘
                </span>
                <div>
                  <h2>{engine.label}</h2>
                  <p>Current stable · ROCm {version}</p>
                </div>
              </div>
              <Link className="text-link" to={engineLink(version, engine.id)}>
                Explore engine <span aria-hidden="true">↗</span>
              </Link>
            </div>
            <p className="readiness-definition">
              Qualified means cleared the shipping gates.
            </p>
            <div className="platform-grid">
              {engine.latest_builds.map((build) => (
                <div
                  className="platform-card"
                  key={`${build.source_id ?? ""}:${build.os}:${build.build_id}`}
                >
                  <div className="card-heading">
                    <h3>
                      {build.os === "linux"
                        ? "Linux"
                        : build.os === "windows"
                          ? "Windows"
                          : build.os}
                    </h3>
                    {build.qualified != null && (
                      <span
                        className={`pill ${build.qualified ? "good" : "bad"}`}
                      >
                        <span aria-hidden="true">●</span>{" "}
                        {build.qualified ? "Qualified" : "Not qualified"}
                      </span>
                    )}
                  </div>
                  <Link
                    className="build-tag"
                    to={engineLink(version, engine.id, build)}
                  >
                    {build.tag ?? build.build_id}{" "}
                    <span aria-hidden="true">↗</span>
                  </Link>
                  <span className="package-rocm">
                    ROCm {build.rocm_version} · Stable
                  </span>
                  <p>
                    Report:{" "}
                    <time dateTime={build.generated_at}>
                      {new Intl.DateTimeFormat("en", {
                        dateStyle: "medium",
                        timeStyle: "short",
                        timeZone: "UTC",
                      }).format(new Date(build.generated_at))}{" "}
                      UTC
                    </time>
                  </p>
                  {build.tests && <PlatformChecks build={build} />}
                  {build.overall && (
                    <div className="evidence-line">
                      <span>Test outcome</span>
                      <strong
                        className={
                          build.overall === "warn" ? "warning-text" : ""
                        }
                      >
                        {build.overall}
                      </strong>
                    </div>
                  )}
                  {build.hardware_validated != null && (
                    <div className="evidence-line">
                      <span>GPU hardware verification</span>
                      <strong>
                        {build.hardware_validated
                          ? `Recorded${build.gfx_target ? ` · ${build.gfx_target}` : ""}`
                          : "Not validated"}
                      </strong>
                    </div>
                  )}
                  {build.report_url && (
                    <a
                      className="text-link"
                      href={build.report_url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Source report ↗
                    </a>
                  )}
                </div>
              ))}
            </div>
          </article>
        ))}
    </section>
  );
}
