import { Link } from "react-router";
import { LinkArrow } from "./LinkArrow";
import type { Build, Overview } from "./data";
import { previousBuild, checkChanges } from "./overview/comparison";
import { Tooltip } from "./overview/Tooltip";
import { BuildComparison } from "./overview/BuildComparison";
import { PlatformChecks } from "./ReadinessVisuals";

type Props = {
  engines: Overview["engines"];
  version: string;
  history?: Build[] | null;
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

export function EngineOverview({ engines, version, history = null }: Props) {
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
                Explore engine <LinkArrow />
              </Link>
            </div>
            <div className="platform-grid">
              {engine.latest_builds.map((build) => {
                const previous = previousBuild(build, history);
                const qualification = (
                  <span className={`pill ${build.qualified ? "good" : "bad"}`}>
                    <span aria-hidden="true">●</span>{" "}
                    {build.qualified ? "Qualified" : "Not qualified"}
                  </span>
                );
                return (
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
                      {build.qualified != null &&
                        (previous?.qualified != null ? (
                          <Tooltip
                            key={`${build.build_id}:${previous.build_id}:qualification`}
                            label={`${build.qualified ? "Qualified" : "Not qualified"}. Compare ${build.os} shipping readiness with previous build`}
                            content={
                              <BuildComparison
                                current={build}
                                previous={previous}
                                kind="qualification"
                              />
                            }
                          >
                            {qualification}
                          </Tooltip>
                        ) : (
                          qualification
                        ))}
                    </div>
                    <Link
                      className="build-tag"
                      to={engineLink(version, engine.id, build)}
                    >
                      {build.tag ?? build.build_id} <LinkArrow />
                    </Link>
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
                    {build.tests && (
                      <PlatformChecks
                        build={build}
                        checksLabel={
                          previous && checkChanges(build, previous) ? (
                            <Tooltip
                              key={`${build.build_id}:${previous.build_id}:checks`}
                              label={`Checks passed ${build.tests.passed} of ${build.tests.total}. Compare ${build.os} check results with previous build`}
                              content={
                                <BuildComparison
                                  current={build}
                                  previous={previous}
                                  kind="checks"
                                />
                              }
                            >
                              Checks passed
                            </Tooltip>
                          ) : undefined
                        }
                      />
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
                        Source report <LinkArrow />
                      </a>
                    )}
                  </div>
                );
              })}
            </div>
          </article>
        ))}
    </section>
  );
}
