import { useEffect, useRef, useState } from "react";
import type { MouseEvent } from "react";
import { Link, useSearchParams } from "react-router";
import {
  loadSession,
  loadVersion,
  loadHistory,
  resolveDatasetPath,
} from "./data";
import { EngineOverview } from "./EngineOverview";
import type { Build, Fetcher, Session, Sync } from "./data";
import "./styles.css";
import { BuildBrowser } from "./builds/BuildBrowser";
import { PerformanceView } from "./performance/PerformanceView";
import { uiCommit } from "./version";
import { ThemeControl } from "./ThemeControl";

function date(value: string | null) {
  return value
    ? new Intl.DateTimeFormat("en", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "UTC",
      }).format(new Date(value)) + " UTC"
    : "No successful ingestion";
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
    if (
      current &&
      !refreshNeeded &&
      current.version === (selected ?? null) &&
      (view === "overview" || current.overview)
    ) {
      setBusy(false);
      setError(null);
      return () => controller.abort();
    }
    setBusy(true);
    setError(null);
    const task =
      current && !refreshNeeded && selected
        ? loadVersion(current, selected, fetcher, controller.signal)
        : loadSession(
            version,
            fetcher,
            controller.signal,
            (pointer) => {
              if (!controller.signal.aborted) setLiveSync(pointer.sync);
            },
            view !== "overview",
          );
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
  }, [version, refresh, fetcher, view]);

  useEffect(() => {
    if (!session?.overview || view === "overview") return;
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
  }, [session, fetcher, view]);

  const selected = version ?? session?.version ?? "";
  const scopeMatches = session && (!version || session.version === version);
  const overview = scopeMatches ? session.overview : null;
  const hasScope =
    scopeMatches &&
    (view === "overview"
      ? session.index.versions.length > 0
      : overview !== null);
  const platformValid =
    view === "overview" || ["all", "linux", "windows"].includes(platform);
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
    next.delete("source");
    next.delete("model");
    if (next.get("compare") === value) next.delete("compare");
    next.delete("date");
    if (view === "build") next.set("view", "engine");
    if (view === "model") next.set("view", "performance");
    setParams(next);
  };
  const refreshData = () => setRefresh((value) => value + 1);
  const handleLocalNavigation = (event: MouseEvent<HTMLDivElement>) => {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    const anchor =
      event.target instanceof Element ? event.target.closest("a[href]") : null;
    const target = anchor?.getAttribute("target");
    const query = anchor?.getAttribute("href");
    if (query?.startsWith("?") && (!target || target === "_self")) {
      event.preventDefault();
      setParams(new URLSearchParams(query.slice(1)));
    }
  };
  const changePlatform = (value: string) => {
    const next = new URLSearchParams(params);
    next.set("version", selected);
    next.set("platform", value);
    next.delete("build");
    next.delete("source");
    if (view === "build") next.set("view", "engine");
    setParams(next);
  };

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
          {view !== "overview" && (
            <>
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
            </>
          )}
          <ThemeControl />
        </div>
      </header>
      <main id="main" tabIndex={-1}>
        {view !== "overview" && (
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
          </div>
        )}
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
        {session && scopeMatches && !session.index.versions.length && (
          <div className="empty">
            <h1>No ROCm versions available</h1>
            <p>
              The dataset contains no published versions. Refresh to check
              again.
            </p>
          </div>
        )}
        {hasScope && (!viewValid || !platformValid) && (
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
        {session && hasScope && viewValid && platformValid && (
          <>
            <div
              className={view === "overview" ? "hero overview-hero" : "hero"}
            >
              <div>
                {view !== "overview" && (
                  <div className="eyebrow">ROCm / STABLE RELEASES</div>
                )}
                <h1>
                  {view === "overview"
                    ? "ROCm readiness"
                    : view === "engine"
                      ? "llama.cpp builds"
                      : view === "build"
                        ? "Build evidence"
                        : "Model performance"}
                </h1>
                <p>
                  {view === "overview"
                    ? "See qualification health over time across published ROCm versions. Select a status symbol to explore all contributing builds."
                    : "Build qualification and model performance, grounded in published evidence."}
                </p>
              </div>
              {view !== "overview" && (
                <span className="release-pill">ROCm {selected}</span>
              )}
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
                <EngineOverview
                  session={session}
                  fetcher={fetcher}
                  onRetry={refreshData}
                />
              </>
            )}
            {["engine", "build"].includes(view) &&
              (history?.session === session && history.error ? (
                <div className="notice error" role="alert">
                  <p>{history.error}</p>
                  <button onClick={refreshData}>Retry history</button>
                </div>
              ) : (
                <div onClick={handleLocalNavigation}>
                  {view === "engine" &&
                    (params.get("build") || params.get("date")) && (
                      <div className="notice">
                        <p>
                          {params.get("date")
                            ? `Qualification reports for ${params.get("date")} UTC`
                            : `Selected stable build: ${params.get("build")}`}
                        </p>
                        <Link
                          to={`?${new URLSearchParams({ version: selected, view: "engine", engine: "llamacpp" })}`}
                        >
                          Show all engine builds
                        </Link>
                      </div>
                    )}
                  <BuildBrowser
                    session={session}
                    history={
                      history?.session === session
                        ? (history.builds?.filter(
                            (build) =>
                              view !== "engine" ||
                              ((!params.get("date") ||
                                new Date(build.generated_at)
                                  .toISOString()
                                  .slice(0, 10) === params.get("date")) &&
                                (!params.get("build") ||
                                  build.build_id === params.get("build")) &&
                                (!params.get("source") ||
                                  build.source_id === params.get("source")) &&
                                (!params.get("engine") ||
                                  build.engine === params.get("engine")) &&
                                (!params.get("channel") ||
                                  build.channel === params.get("channel"))),
                          ) ?? null)
                        : null
                    }
                    platform={platform}
                    selectedBuildId={
                      view === "build" ? params.get("build") || "" : null
                    }
                    selectedSourceId={params.get("source") || null}
                    query={params.get("build_filter") ?? ""}
                    onQueryChange={(query) => {
                      const next = new URLSearchParams(params);
                      if (query) next.set("build_filter", query);
                      else next.delete("build_filter");
                      setParams(next, { replace: true });
                    }}
                    onPlatformChange={changePlatform}
                    buildHref={(build) =>
                      href("build", {
                        build: build.build_id,
                        platform: build.os,
                        ...(build.source_id ? { source: build.source_id } : {}),
                      })
                    }
                  />
                </div>
              ))}
            {["performance", "model"].includes(view) && (
              <div onClick={handleLocalNavigation}>
                <PerformanceView
                  session={session}
                  params={params}
                  onNavigate={(next) => setParams(next)}
                  buildHref={(id, os) => {
                    const candidates =
                      history?.session === session
                        ? history.builds?.filter(
                            (build) => build.build_id === id && build.os === os,
                          )
                        : [];
                    return href("build", {
                      build: id,
                      platform: os,
                      ...(candidates?.length === 1 && candidates[0].source_id
                        ? { source: candidates[0].source_id }
                        : {}),
                    });
                  }}
                />
              </div>
            )}
          </>
        )}
        <footer>
          <div>
            <p>
              {uiCommit ? (
                <a
                  href={`https://github.com/lemonade-sdk/rocm-readiness/commit/${uiCommit}`}
                  title={`UI commit ${uiCommit}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  UI {uiCommit.slice(0, 8)}
                </a>
              ) : (
                <span>UI version unavailable</span>
              )}
              {session ? (
                <>
                  {" · "}
                  <a
                    href={`https://github.com/lemonade-sdk/rocm-readiness/commit/${session.pointer.data_commit}`}
                    title={`Data commit ${session.pointer.data_commit}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Data {session.pointer.data_commit?.slice(0, 8)}
                  </a>
                  {" · "}
                  <time dateTime={session.index.generated_at}>
                    Data updated {date(session.index.generated_at)}
                  </time>
                </>
              ) : null}
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
