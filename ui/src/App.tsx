import { useEffect, useRef, useState } from "react";
import type { MouseEvent } from "react";
import { Link, useSearchParams } from "react-router";
import {
  loadSession,
  loadVersion,
  loadHistory,
} from "./data";
import { ReadinessOverview } from "./ReadinessOverview";
import type { Build, Fetcher, Session, Sync } from "./data";
import "./styles.css";
import { BuildReview, EngineBuilds } from "./builds/BuildViews";
import { PerformanceView } from "./performance/PerformanceView";
import { uiCommit } from "./version";
import { ThemeControl } from "./ThemeControl";
import { UpstreamView } from "./upstream/UpstreamView";

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
  // Two dashboards over one dataset: ROCm readiness (default) and Upstream
  // health, the projects' own client AMD CI on their default branch.
  const track = params.get("track") === "upstream" ? "upstream" : "readiness";
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
    const run = async () => {
      setBusy(true);
      setError(null);
      try {
        let current = sessionRef.current;
        if (!current || completedRefresh.current !== refresh) {
          current = await loadSession(
            undefined,
            fetcher,
            controller.signal,
            (pointer) => {
              if (!controller.signal.aborted) setLiveSync(pointer.sync);
            },
            false,
          );
          if (controller.signal.aborted) return;
          if (!sessionRef.current || track === "upstream") {
            sessionRef.current = current;
            completedRefresh.current = refresh;
            setSession(current);
          }
        }
        const selected = version ?? (view === "engine" ? current.index.readiness?.stable_anchor : null) ?? current.index.default_version;
        if (
          track === "readiness" &&
          view !== "overview" &&
          selected &&
          current.version !== selected
        ) {
          current = await loadVersion(
            current,
            selected,
            fetcher,
            controller.signal,
          );
          if (controller.signal.aborted) return;
          sessionRef.current = current;
          setSession(current);
        }
        sessionRef.current = current;
        completedRefresh.current = refresh;
        setSession(current);
      } catch (reason: unknown) {
        if (!controller.signal.aborted) {
          if (sessionRef.current) completedRefresh.current = refresh;
          setError(
            reason instanceof Error
              ? reason.message
              : "Unable to read published data. Retry.",
          );
        }
      } finally {
        if (!controller.signal.aborted) setBusy(false);
      }
    };
    void run();
    return () => controller.abort();
  }, [version, track, view, refresh, fetcher]);

  const needsHistory = track === "readiness" && view !== "overview";
  useEffect(() => {
    if (!needsHistory || !session?.overview) return;
    const controller = new AbortController();
    setHistory({ session, builds: null, error: null });
    async function load(current: Session) {
      const builds = await loadHistory(current, fetcher, controller.signal);
      if (controller.signal.aborted) return;
      const expected = current.overview?.engines.reduce((sum, engine) => sum + engine.build_count, 0) ?? 0;
      if (builds.length !== expected) throw new Error("Retained history count does not match the overview");
      setHistory({ session: current, builds, error: null });
    }
    void load(session).catch((reason: unknown) => {
      if (!controller.signal.aborted) setHistory({
        session,
        builds: null,
        error: reason instanceof Error ? reason.message : "Unable to load build history",
      });
    });
    return () => controller.abort();
  }, [session, needsHistory, fetcher]);
  const currentHistory = history?.session === session ? history : null;
  const selected = version ?? (view === "engine" ? session?.index.readiness?.stable_anchor ?? session?.index.default_version : null) ?? session?.version ?? "";
  const scopeMatches =
    session && (view === "overview" || !selected || session.version === selected);
  const overview = scopeMatches ? session.overview : null;
  const platformValid =
    view === "overview" || ["all", "linux", "windows"].includes(platform) ||
    (view === "engine" && platform === "none");
  const viewValid = [
    "overview",
    "engine",
    "build",
    "build-review",
    "build-performance",
    "performance",
    "model",
  ].includes(view);
  const qualificationView = view === "engine" || view === "build";
  const buildView = view === "build-review";
  const href = (nextView: string, extras: Record<string, string> = {}) => {
    const next = new URLSearchParams(params);
    if (selected) next.set("version", selected);
    next.set("view", nextView);
    if (nextView !== "engine" && next.get("platform") === "none") next.delete("platform");
    if (nextView === "engine") {
      next.delete("version");
      for (const key of ["build", "source", "engine", "channel", "platform", "day", "through", "focus", "build_filter", "package_identity", "tier", "check", "report_commit"])
        next.delete(key);
    }
    if (["build", "performance"].includes(nextView)) {
      for (const key of ["build", "source", "engine", "channel", "day", "through", "focus", "build_filter", "package_identity", "tier", "check", "report_commit", "model", "system", "workload", "compare", "observation"])
        next.delete(key);
    }
    for (const [key, value] of Object.entries(extras)) next.set(key, value);
    return `?${next}`;
  };
  const changeVersion = (value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set("version", value);
    else next.delete("version");
    next.delete("build");
    next.delete("source");
    next.delete("model");
    next.delete("observation");
    next.delete("day");
    next.delete("through");
    next.delete("focus");
    next.delete("package_identity");
    next.delete("channel");
    next.delete("tier");
    next.delete("check");
    next.delete("report_commit");
    next.delete("compare");
    if (buildView || qualificationView) next.set("view", "engine");
    if (view === "model" || view === "build-performance") next.set("view", "performance");
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

  const hasViewData = overview || (view === "overview" && Boolean(session?.index.versions.length));
  const showPageHeading = track === "readiness" && session && hasViewData &&
    viewValid && platformValid;
  const upstreamCI = params.get("view") === "ci" || (!params.has("view") && params.has("project"));
  const upstreamHref = (page: "overview" | "ci") => {
    const next = new URLSearchParams(params);
    next.set("track", "upstream");
    next.set("view", page);
    return `?${next}`;
  };
  const pageTitle =
    track === "upstream" ? (upstreamCI ? "CI Activity" : "Upstream Overview") :
    qualificationView ? "Build Qualification" :
    view === "build-review" ? "Build details" :
    view === "build-performance" ? "Performance details" :
    view === "performance" || view === "model" ? "Performance details" :
    "ROCm Readiness";
  const versionOptions = session?.index.versions ?? [];
  const performanceView = ["performance", "model", "build-performance"].includes(view);
  const versionFilter = qualificationView || performanceView ? (
    <fieldset className="build-filter-options">
      <legend>ROCm version</legend>
      {!session && <span className="muted">Loading…</span>}
      {selected && !versionOptions.some((row) => row.rocm_version === selected) && (
        <button type="button" aria-pressed="true" disabled>{selected} · unavailable</button>
      )}
      {versionOptions.map(({ rocm_version }) => (
        <button
          key={rocm_version}
          type="button"
          aria-pressed={selected === rocm_version}
          onClick={() => { if (selected !== rocm_version) changeVersion(rocm_version); }}
        >
          {rocm_version}
        </button>
      ))}
    </fieldset>
  ) : (
    <label>
      ROCm version
      <select
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
    </label>
  );

  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="header">
        <Link className="brand" to={href("overview")}>
          ROCm Readiness
          <span className="deck-label">Signal Deck</span>
        </Link>
        <div className="header-page">
          <div className="header-page-heading">
            {showPageHeading || track === "upstream" ? <h1>{pageTitle}</h1> : <div className="header-page-title">{pageTitle}</div>}
            <div className="deck-context">
              {track === "readiness" ? "01 / Release qualification" : "02 / Continuous integration"}
            </div>
          </div>
        </div>
        <div className="header-controls"><ThemeControl /></div>
      </header>
      <aside className="deck-rail" aria-label="Workspaces">
        <div className="deck-kicker">Workspaces</div>
        <nav className="track-tabs" aria-label="Dashboards">
          <ul className="workspace-list">
            <li>
              <Link
                aria-current={track === "readiness" ? "true" : undefined}
                to={`?${new URLSearchParams(selected ? { version: selected } : {})}`}
              >
                ROCm readiness
              </Link>
              {track === "readiness" && (
                <ul className="workspace-views" aria-label="Dashboard views">
                  <li><Link aria-current={view === "overview" ? "page" : undefined} to={href("overview")}>Overview</Link></li>
                  <li>
                    <Link aria-current={qualificationView ? "page" : undefined} to={href("engine")}>Build Qualification</Link>
                    <ul className="workspace-views workspace-build-details" aria-label="Build Qualification pages">
                      <li><Link aria-current={["performance", "model", "build-performance"].includes(view) ? "page" : undefined} to={href("performance")}>Performance</Link></li>
                    </ul>
                  </li>
                </ul>
              )}
            </li>
            <li>
              <Link aria-current={track === "upstream" ? "true" : undefined} to="?track=upstream">
                Upstream health
              </Link>
              {track === "upstream" && (
                <ul className="workspace-views" aria-label="Upstream health views">
                  <li><Link aria-current={!upstreamCI ? "page" : undefined} to={upstreamHref("overview")}>Overview</Link></li>
                  <li><Link aria-current={upstreamCI ? "page" : undefined} to={upstreamHref("ci")}>CI Activity</Link></li>
                </ul>
              )}
            </li>
          </ul>
        </nav>
      </aside>
      <main id="main" tabIndex={-1}>
        {track === "readiness" && view !== "overview" &&
          !performanceView && (view !== "engine" || !currentHistory?.builds || !hasViewData || !platformValid) && (
            <div className="build-browser-toolbar build-filters">{versionFilter}</div>
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
        {track === "upstream" && session && (
          <UpstreamView
            session={session}
            fetcher={fetcher}
            params={params}
            onNavigate={(next) => setParams(next)}
          />
        )}
        {track === "readiness" &&
          session &&
          scopeMatches &&
          !overview &&
          !session.index.versions.length &&
          !busy &&
          !error && (
            <div className="empty">
              <h1>No ROCm versions available</h1>
              <p>
                The dataset contains no published versions. Refresh to check
                again.
              </p>
            </div>
          )}
        {track === "readiness" &&
          hasViewData &&
          (!viewValid || !platformValid) && (
            <div className="notice" role="alert">
              <h1>Unavailable view or platform</h1>
              <p>
                This URL requests a view or platform outside the selected
                dataset.
              </p>
              <Link
                to={`?version=${encodeURIComponent(selected)}&view=overview`}
              >
                Return to this version’s overview
              </Link>
            </div>
          )}
        {track === "readiness" &&
          session &&
          hasViewData &&
          viewValid &&
          platformValid && (
            <>
              {view === "overview" && (
                <ReadinessOverview
                  session={session}
                  fetcher={fetcher}
                  onRetry={refreshData}
                />
              )}
              {(qualificationView || buildView) && (
                currentHistory?.error ? (
                  <div className="notice error" role="alert">
                    <p>{currentHistory.error}</p>
                    <button onClick={refreshData}>Retry history</button>
                  </div>
                ) : currentHistory?.builds ? (
                  <div onClick={handleLocalNavigation}>
                    {qualificationView ? <EngineBuilds
                      session={session} history={currentHistory.builds} params={params} fetcher={fetcher}
                      versionFilter={versionFilter}
                      onNavigate={(next, replace) => setParams(next, { replace })}
                    /> : <BuildReview session={session} history={currentHistory.builds} params={params} fetcher={fetcher} />}
                  </div>
                ) : <p role="status">Loading retained build history…</p>
              )}
              {["performance", "model", "build-performance"].includes(view) && (
                <div onClick={handleLocalNavigation}>
                  <PerformanceView
                    versionFilter={versionFilter}
                    fetcher={fetcher}
                    session={session}
                    params={params}
                    onNavigate={(next) => setParams(next)}
                    buildHref={(id, os) => {
                      const candidates =
                        history?.session === session
                          ? history.builds?.filter(
                              (build) =>
                                build.build_id === id && build.os === os,
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
      </main>
      <footer className="deck-provenance" aria-label="Dashboard provenance">
        <div className="deck-kicker">About this data</div>
        {session && (
          <div className="provenance-updated">
            <span>Data updated</span>
            <time dateTime={session.index.generated_at}>
              {date(session.index.generated_at)}
            </time>
          </div>
        )}
        <div className="provenance-group">
          <div className="provenance-label">Revisions</div>
          <div className="provenance-links">
            {uiCommit ? (
              <span>
                UI deployment (
                <a
                  href={`https://github.com/lemonade-sdk/rocm-readiness/commit/${uiCommit}`}
                  aria-label={`UI deployment ${uiCommit.slice(0, 8)}`}
                  title={uiCommit}
                  target="_blank"
                  rel="noreferrer"
                >
                  {uiCommit.slice(0, 8)}
                </a>
                )
              </span>
            ) : (
              <span>UI deployment revision unavailable</span>
            )}
            {session && (session.pointer.data_commit ? (
              <span>
                Published data (
                <a
                  href={`https://github.com/lemonade-sdk/rocm-readiness/commit/${session.pointer.data_commit}`}
                  aria-label={`Published data ${session.pointer.data_commit.slice(0, 8)}`}
                  title={session.pointer.data_commit}
                  target="_blank"
                  rel="noreferrer"
                >
                  {session.pointer.data_commit.slice(0, 8)}
                </a>
                )
              </span>
            ) : (
              <span>Local dataset preview</span>
            ))}
          </div>
        </div>
        <div className="provenance-group">
          <div className="provenance-label">References</div>
          <div className="provenance-links">
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
        </div>
      </footer>
    </>
  );
}
