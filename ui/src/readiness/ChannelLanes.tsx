import type { Overview, Session } from "../data";
import type { UpstreamOverview } from "../upstream/data";

type Source = NonNullable<Session["index"]["sources"]>[number];

const STATUS = {
  fresh: "fresh",
  stale: "stale",
  empty: "no builds yet",
  awaiting_data: "awaiting data",
  error: "error",
} as Record<string, string>;

/**
 * ROCm readiness by channel. Each engine's qualification feeds are lanes
 * (stable, nightly), shown with what they hold for the selected ROCm version,
 * followed by the forks known from projects.json that no feed reads yet. This
 * is where an upcoming ROCm shows up first: in a nightly lane or a fork.
 */
export function ChannelLanes({
  sources,
  engines,
  version,
  upstream,
}: {
  sources: Source[];
  engines: Overview["engines"];
  version: string;
  upstream: UpstreamOverview | null;
}) {
  const ids = new Set([
    ...engines.map((e) => e.id),
    ...sources.map((s) => s.engine),
  ]);
  const lanes = [...ids].map((engine) => {
    const label = engines.find((e) => e.id === engine)?.label ?? engine;
    const feeds = sources.filter(
      (s) => s.engine === engine && s.adapter === "qualification-v1",
    );
    const builds = engines.find((e) => e.id === engine)?.latest_builds ?? [];
    const read = new Set(feeds.map((s) => s.repository).filter(Boolean));
    const forks =
      upstream?.projects
        .find((p) => p.id === engine)
        ?.forks.filter((f) => !read.has(f.repository)) ?? [];
    return { engine, label, feeds, builds, forks };
  });
  if (!lanes.some((lane) => lane.feeds.length || lane.forks.length))
    return null;
  return (
    <section className="card channel-lanes" aria-label="Channels and forks">
      <h2>Channels and forks</h2>
      <p className="muted">
        Stable and nightly qualification feeds for ROCm {version}, then forks
        that carry AMD work but are not read yet.
      </p>
      {lanes.map((lane) => (
        <table key={lane.engine} className="lanes-table">
          <caption>{lane.label}</caption>
          <thead>
            <tr>
              <th scope="col">Channel</th>
              <th scope="col">Repository</th>
              <th scope="col">Feed</th>
              <th scope="col">Latest builds on ROCm {version}</th>
            </tr>
          </thead>
          <tbody>
            {lane.feeds.map((feed) => {
              const rows = lane.builds.filter(
                (b) => b.channel === feed.channel,
              );
              return (
                <tr key={feed.id}>
                  <th scope="row">{feed.channel}</th>
                  <td>
                    {feed.repository ? (
                      <a
                        href={`https://github.com/${feed.repository}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {feed.repository}
                      </a>
                    ) : (
                      "–"
                    )}
                  </td>
                  <td
                    className={
                      feed.status === "fresh"
                        ? "good"
                        : feed.status === "error"
                          ? "bad"
                          : "warning-text"
                    }
                  >
                    {STATUS[feed.status] ?? feed.status}
                  </td>
                  <td>
                    {rows.length
                      ? rows
                          .map((b) => `${b.tag ?? b.build_id} (${b.os})`)
                          .join(", ")
                      : feed.status === "awaiting_data"
                        ? "not published yet"
                        : "none for this ROCm version"}
                  </td>
                </tr>
              );
            })}
            {lane.forks.map((fork) => (
              <tr key={fork.repository} className="muted">
                <th scope="row">{fork.channel ?? "fork"}</th>
                <td>
                  <a
                    href={`https://github.com/${fork.repository}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {fork.repository}
                  </a>
                </td>
                <td>not collected</td>
                <td>no feed yet · {fork.role}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ))}
    </section>
  );
}
