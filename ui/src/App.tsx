import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import {
  loadSession,
  loadVersion,
  loadHistory,
  resolveDatasetPath,
} from "./data";
import {
  BuildQualification,
  LatestChecks,
  PlatformChecks,
} from "./ReadinessVisuals";
import type { Build, Fetcher, Session, Sync } from "./data";
import "./styles.css";

function date(value: string | null) {
  return value
    ? new Intl.DateTimeFormat("en", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "UTC",
      }).format(new Date(value)) + " UTC"
    : "No successful ingestion";
}
function Qualification({ build }: { build: Build }) {
  const label =
    build.qualified === true
      ? "Qualified"
      : build.qualified === false
        ? "Not qualified"
        : "Qualification unknown";
  return (
    <span
      className={`pill ${build.qualified === true ? "good" : build.qualified === false ? "bad" : "muted"}`}
    >
      <span aria-hidden="true">●</span> {label}
    </span>
  );
}
function reportLink(build: Build) {
  if (!build.report_url) return null;
  const expected =
    /^https:\/\/raw\.githubusercontent\.com\/lemonade-sdk\/llama\.cpp\/[a-f0-9]{40}\/qualification\/reports\/[a-zA-Z0-9_.-]+\.json$/;
  return expected.test(build.report_url) ? build.report_url : null;
}

export function App({ fetcher = fetch }: { fetcher?: Fetcher }) {
  const [params, setParams] = useSearchParams();
  const version = params.get("version") || undefined;
  const view = params.get("view") ?? "overview";
  const platform = params.get("platform") ?? "all";
  const [session, setSession] = useState<Session | null>(null);
  const [liveSync, setLiveSync] = useState<Sync | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [history, setHistory] = useState<{
    session: Session;
    builds: Build[] | null;
    error: string | null;
  } | null>(null);
  const sessionRef = useRef<Session | null>(null);
  const completedRefresh = useRef(-1);

  useEffect(() => {
    const controller = new AbortController();
    const current = sessionRef.current;
    const refreshNeeded = completedRefresh.current !== refresh;
    const selected = version ?? current?.index.default_version ?? undefined;
    if (current && !refreshNeeded && current.version === (selected ?? null)) {
      setBusy(false);
      setError(null);
      return () => controller.abort();
    }
    setBusy(true);
    setError(null);
    const task =
      current && !refreshNeeded && selected
        ? loadVersion(current, selected, fetcher, controller.signal)
        : loadSession(version, fetcher, controller.signal, (pointer) => {
            if (!controller.signal.aborted) setLiveSync(pointer.sync);
          });
    task
      .then((next) => {
        if (controller.signal.aborted) return;
        sessionRef.current = next;
        completedRefresh.current = refresh;
        setSession(next);
        setBusy(false);
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        setError(
          reason instanceof Error
            ? reason.message
            : "Unable to read published data. Retry.",
        );
        setBusy(false);
      });
    return () => controller.abort();
  }, [version, refresh, fetcher]);

  useEffect(() => {
    if (!session?.overview) return;
    const controller = new AbortController();
    setHistory({ session, builds: null, error: null });
    loadHistory(session, fetcher, controller.signal)
      .then((rows) => {
        if (controller.signal.aborted) return;
        const builds = rows.filter((build) => build.engine === "llamacpp");
        const expected = session
          .overview!.engines.filter((engine) => engine.id === "llamacpp")
          .reduce((sum, engine) => sum + engine.build_count, 0);
        if (builds.length !== expected)
          throw new Error("Retained history count does not match the overview");
        setHistory({ session, builds, error: null });
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted)
          setHistory({
            session,
            builds: null,
            error:
              reason instanceof Error
                ? reason.message
                : "Unable to load build history",
          });
      });
    return () => controller.abort();
  }, [session, fetcher]);

  const selected = version ?? session?.version ?? "";
  const scopeMatches = session && (!version || session.version === version);
  const overview = scopeMatches ? session.overview : null;
  const engines =
    overview?.engines.filter((engine) => engine.id === "llamacpp") ?? [];
  const builds = engines
    .flatMap((engine) => engine.latest_builds)
    .filter((build) => platform === "all" || build.os === platform);
  const platformValid =
    platform === "all" ||
    engines.some((engine) => engine.platforms.includes(platform));
  const viewValid = [
    "overview",
    "engine",
    "build",
    "performance",
    "model",
  ].includes(view);
  const href = (nextView: string, extras: Record<string, string> = {}) => {
    const next = new URLSearchParams(params);
    if (selected) next.set("version", selected);
    next.set("view", nextView);
    for (const [key, value] of Object.entries(extras)) next.set(key, value);
    return `?${next}`;
  };
  const changeVersion = (value: string) => {
    const next = new URLSearchParams(params);
    next.set("version", value);
    next.delete("build");
    next.delete("model");
    if (view === "build") next.set("view", "engine");
    if (view === "model") next.set("view", "performance");
    setParams(next);
  };
  const refreshData = () => setRefresh((value) => value + 1);

  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="header">
        <Link className="brand" to={href("overview")}>
          <span className="brand-mark" aria-hidden="true">
            ◒
          </span>{" "}
          Lemonade <span className="brand-light">Performance</span>
        </Link>
        <div className="header-controls">
          <span className="channel">STABLE · LLAMA.CPP</span>
          <label htmlFor="version">ROCm version</label>
          <select
            id="version"
            value={selected}
            disabled={!session?.index.versions.length}
            onChange={(event) => changeVersion(event.target.value)}
          >
            {!session && <option value="">Loading…</option>}
            {version &&
              session &&
              !session.index.versions.some(
                (row) => row.rocm_version === version,
              ) && <option value={version}>{version} · unavailable</option>}
            {session?.index.versions.map((row) => (
              <option key={row.rocm_version} value={row.rocm_version}>
                {row.rocm_version}
              </option>
            ))}
          </select>
        </div>
      </header>
      <main id="main" tabIndex={-1}>
        <div className="topline">
          <nav aria-label="Breadcrumb">
            <Link to={href("overview")}>ROCm readiness</Link>
            {view !== "overview" && (
              <>
                <span aria-hidden="true">/</span>
                <Link to={href("engine")}>llama.cpp</Link>
              </>
            )}
            {selected && <span className="muted">/ {selected}</span>}
          </nav>
          <span className="preview-label">LOCAL PREVIEW · UI SHELL</span>
        </div>
        {liveSync?.status === "failed" && (
          <div className="notice warning">
            <strong>Latest ingestion failed</strong>
            <p>
              Last attempt: {date(liveSync.attempted_at)}. The last successful
              dataset remains available.
            </p>
            <p>
              Last successful ingestion: {date(liveSync.last_successful_at)}
            </p>
            {liveSync.errors.map((entry, i) => (
              <p key={i}>
                {entry.source_id}: {entry.reason}
                {entry.field && ` (${entry.field})`}
              </p>
            ))}
          </div>
        )}
        {error && (
          <div role="alert" className="notice error">
            <strong>Couldn’t load the requested data</strong>
            <p>{error}</p>
            {session && (
              <p>
                Keeping the last usable dataset from{" "}
                {date(session.index.generated_at)}.
              </p>
            )}
            <div className="actions">
              <button onClick={refreshData}>Retry</button>
              <button
                onClick={() => {
                  const next = new URLSearchParams(params);
                  next.delete("version");
                  next.set("view", "overview");
                  setParams(next);
                  refreshData();
                }}
              >
                Use default version
              </button>
            </div>
          </div>
        )}
        {busy && (!scopeMatches || !session) && (
          <div className="empty" role="status">
            <span className="loading-mark" aria-hidden="true">
              ◒
            </span>
            <h1>
              Loading {version ? `ROCm ${version}` : "published dataset"}…
            </h1>
            <p>Reading one immutable dataset revision.</p>
          </div>
        )}
        {session && scopeMatches && !overview && (
          <div className="empty">
            <h1>No ROCm versions available</h1>
            <p>
              The dataset contains no published versions. Refresh to check
              again.
            </p>
          </div>
        )}
        {overview && (!viewValid || !platformValid) && (
          <div className="notice" role="alert">
            <h1>Unavailable view or platform</h1>
            <p>
              This URL requests a view or platform outside the selected dataset.
            </p>
            <Link to={`?version=${encodeURIComponent(selected)}&view=overview`}>
              Return to this version’s overview
            </Link>
          </div>
        )}
        {session && overview && viewValid && platformValid && (
          <>
            <div className="hero">
              <div>
                <div className="eyebrow">ROCm / STABLE RELEASES</div>
                <h1>
                  {view === "overview"
                    ? `ROCm ${overview.rocm_version} readiness`
                    : view === "engine"
                      ? "llama.cpp builds"
                      : view === "build"
                        ? "Build evidence"
                        : "Model performance"}
                </h1>
                <p>
                  Build qualification and model performance, grounded in
                  published evidence.
                </p>
              </div>
              <span className="release-pill">ROCm {overview.rocm_version}</span>
            </div>
            <nav className="view-tabs" aria-label="Dashboard views">
              <Link
                aria-current={view === "overview" ? "page" : undefined}
                to={href("overview")}
              >
                Overview
              </Link>
              <Link
                aria-current={
                  ["engine", "build"].includes(view) ? "page" : undefined
                }
                to={href("engine")}
              >
                Engine builds
              </Link>
              <Link
                aria-current={
                  ["performance", "model"].includes(view) ? "page" : undefined
                }
                to={href("performance")}
              >
                Model performance
              </Link>
            </nav>
            {view === "overview" && (
              <>
                <div className="stats">
                  <BuildQualification
                    builds={
                      history?.session === session ? history.builds : null
                    }
                    total={engines.reduce(
                      (sum, engine) => sum + engine.build_count,
                      0,
                    )}
                    error={history?.session === session ? history.error : null}
                    onRetry={refreshData}
                  />
                  <LatestChecks
                    builds={engines.flatMap((engine) => engine.latest_builds)}
                  />
                  <div>
                    <span>Model measurements</span>
                    <strong
                      className={
                        overview.performance.status === "not_measured"
                          ? "unmeasured"
                          : undefined
                      }
                    >
                      {overview.performance.measurement_count ?? "Not measured"}
                    </strong>
                    <small>
                      Historical observations, not current-build tests
                    </small>
                  </div>
                </div>
                <div className="section-title">
                  <h2>Engine readiness</h2>
                </div>
                {engines.length ? (
                  engines.map((engine) => (
                    <article className="card engine-card" key={engine.id}>
                      <div className="card-heading">
                        <div className="engine-identity">
                          <span className="engine-icon" aria-hidden="true">
                            ⌘
                          </span>
                          <div>
                            <h2>{engine.label}</h2>
                            <p>
                              {engine.build_count} retained builds ·{" "}
                              {engine.platforms.join(" + ")}
                            </p>
                          </div>
                        </div>
                        <Link className="text-link" to={href("engine")}>
                          Explore builds <span aria-hidden="true">↗</span>
                        </Link>
                      </div>
                      <div className="platform-grid">
                        {engine.latest_builds.map((build) => (
                          <div className="platform-card" key={build.build_id}>
                            <div className="card-heading">
                              <h3>
                                {build.os === "linux"
                                  ? "Linux"
                                  : build.os === "windows"
                                    ? "Windows"
                                    : build.os}
                              </h3>
                              <Qualification build={build} />
                            </div>
                            <Link
                              className="build-tag"
                              to={href("build", {
                                build: build.build_id,
                                platform: build.os,
                              })}
                            >
                              {build.tag ?? build.build_id}{" "}
                              <span aria-hidden="true">↗</span>
                            </Link>
                            <span className="package-rocm">
                              ROCm {build.rocm_version}
                            </span>
                            <p>
                              Latest retained build · {date(build.generated_at)}
                            </p>
                            <PlatformChecks build={build} />
                            <div className="evidence-line">
                              <span>Test outcome</span>
                              <strong
                                className={
                                  build.overall === "warn" ? "warning-text" : ""
                                }
                              >
                                {build.overall ?? "Unavailable"}
                              </strong>
                            </div>
                            <div className="evidence-line">
                              <span>Hardware validation</span>
                              <strong>
                                {build.hardware_validated === true
                                  ? `Recorded${build.gfx_target ? ` · ${build.gfx_target}` : ""}`
                                  : build.hardware_validated === false
                                    ? "Not validated"
                                    : "Unknown"}
                              </strong>
                            </div>
                          </div>
                        ))}
                      </div>
                      {!engine.latest_builds.length && (
                        <p>No latest-build evidence is available.</p>
                      )}
                    </article>
                  ))
                ) : (
                  <div className="empty">
                    <h2>No stable llama.cpp builds</h2>
                    <p>
                      No in-scope engine evidence is present for this version.
                    </p>
                  </div>
                )}
              </>
            )}
            {["engine", "build"].includes(view) && (
              <>
                <div className="section-title">
                  <h2>Latest retained platform builds</h2>
                  <label>
                    Platform{" "}
                    <select
                      aria-label="Platform"
                      value={platform}
                      onChange={(event) => {
                        const next = new URLSearchParams(params);
                        next.set("version", selected);
                        next.set("platform", event.target.value);
                        next.delete("build");
                        next.set("view", "engine");
                        setParams(next);
                      }}
                    >
                      <option value="all">All platforms</option>
                      {[
                        ...new Set(
                          engines.flatMap((engine) => engine.platforms),
                        ),
                      ].map((os) => (
                        <option key={os} value={os}>
                          {os}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                {view === "build" ? (
                  <BuildEvidence
                    build={builds.find(
                      (build) => build.build_id === params.get("build"),
                    )}
                  />
                ) : (
                  <div className="card build-list">
                    {builds.map((build) => (
                      <div className="build-row" key={build.build_id}>
                        <div>
                          <span className="eyebrow">{build.os}</span>
                          <Link
                            className="build-tag"
                            to={href("build", { build: build.build_id })}
                          >
                            {build.tag ?? build.build_id}
                          </Link>
                          <p>{date(build.generated_at)}</p>
                        </div>
                        <Qualification build={build} />
                        <Link to={href("build", { build: build.build_id })}>
                          View evidence →
                        </Link>
                      </div>
                    ))}
                    {!builds.length && (
                      <p>No latest builds match this platform.</p>
                    )}
                  </div>
                )}
                <div className="card data-access">
                  <h2>Published build history</h2>
                  <p>
                    Full retained records are available in the pinned monthly
                    JSON files.
                  </p>
                  {overview.history.map((chunk) => (
                    <a
                      key={chunk.path}
                      href={resolveDatasetPath(session.indexUrl, chunk.path)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {chunk.month} · {chunk.build_count} builds ↗
                    </a>
                  ))}
                </div>
              </>
            )}
            {["performance", "model"].includes(view) && (
              <div className="card data-access">
                <div className="eyebrow">HISTORICAL MODEL MEASUREMENTS</div>
                <h2>
                  {overview.performance.status === "available"
                    ? `${overview.performance.measurement_count} recorded observations`
                    : "No recorded model measurements"}
                </h2>
                <p>
                  Measurements retain their own hardware, workload, package and
                  date. These observations do not establish the performance of
                  the latest build.
                </p>
                {params.get("model") && (
                  <p>Selected model: {params.get("model")}</p>
                )}
                {overview.performance.path ? (
                  <a
                    href={resolveDatasetPath(
                      session.indexUrl,
                      overview.performance.path,
                    )}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open published measurements ↗
                  </a>
                ) : (
                  <p>
                    No model measurements are available for this ROCm version.
                  </p>
                )}
              </div>
            )}
          </>
        )}
        <footer>
          <div>
            <strong>Evidence you can trace.</strong>
            <p>
              {session ? (
                <>
                  Dataset {session.pointer.data_commit?.slice(0, 8)} ·{" "}
                  {date(session.index.generated_at)}
                </>
              ) : (
                "Stable llama.cpp · ROCm readiness"
              )}
            </p>
          </div>
          <div className="footer-links">
            {session && (
              <a href={session.indexUrl} target="_blank" rel="noreferrer">
                Pinned dataset
              </a>
            )}
            <a
              href="https://github.com/lemonade-sdk/rocm-readiness"
              target="_blank"
              rel="noreferrer"
            >
              Source repository ↗
            </a>
          </div>
        </footer>
      </main>
    </>
  );
}

function BuildEvidence({ build }: { build?: Build }) {
  if (!build)
    return (
      <div className="empty">
        <h2>Build not in the loaded latest-build summary</h2>
        <p>
          Use the pinned monthly history below to inspect retained older
          records.
        </p>
      </div>
    );
  const url = reportLink(build);
  return (
    <article className="card data-access">
      <div className="card-heading">
        <h2>
          {build.tag ?? build.build_id} · {build.os}
        </h2>
        <Qualification build={build} />
      </div>
      <dl>
        <dt>Build ID</dt>
        <dd>{build.build_id}</dd>
        <dt>Measured build date</dt>
        <dd>{date(build.generated_at)}</dd>
        <dt>Test outcome</dt>
        <dd>{build.overall ?? "Unavailable"}</dd>
        <dt>Compiled GPU targets</dt>
        <dd>
          {build.gfx
            ? `${build.gfx.present} / ${build.gfx.requested} requested targets present`
            : "No compiled-target evidence"}
        </dd>
        <dt>Hardware validation</dt>
        <dd>
          {build.hardware_validated === true
            ? `Recorded${build.gfx_target ? ` on ${build.gfx_target}` : ""}`
            : build.hardware_validated === false
              ? "Not hardware validated"
              : "Unknown"}
        </dd>
      </dl>
      {url ? (
        <a href={url} target="_blank" rel="noreferrer">
          Open pinned producer report ↗
        </a>
      ) : (
        <p>No supported pinned producer report link is available.</p>
      )}
    </article>
  );
}
