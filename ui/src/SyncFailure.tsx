import type { Sync } from "./data";
import { producedAt } from "./overview/formatDate";
import sources from "../../sources.json";

const title = "Dashboard data couldn’t be updated";

function FailureDetails({ entry }: { entry: Sync["errors"][number] }) {
  const source = sources.sources.find(source => source.id === entry.source_id);
  const benchmark = source?.adapter === "lemonade-leaderboard-v1" && entry.field === "package_evidence";
  const accessFailure = benchmark && entry.reason.includes("benchmark job evidence access failed");
  // Only the collector's numeric run token is interpreted; reason text never supplies a URL.
  const runEvidence = accessFailure ? /^run=([1-9]\d{0,19}) engine=([A-Za-z0-9._-]+): benchmark job evidence access failed(?:\s|$)/.exec(entry.reason) : null;
  const run = runEvidence?.[1];
  const httpStatus = accessFailure ? /\bHTTP ([45]\d{2})\b/.exec(entry.reason)?.[1] : undefined;
  const measurement = benchmark ? /^\/by_model_scenario\/([^/|]{1,160})\|([^/]{1,80})\/\d+$/.exec(entry.record) : null;
  const workload = measurement?.[2].replace(/^context-(\d+)k$/, "$1K context");
  const sourceUrl = benchmark && source?.ref && source.path
    ? `https://github.com/${source.repository}/blob/${encodeURIComponent(source.ref)}/${source.path.split("/").map(encodeURIComponent).join("/")}`
    : undefined;
  return <div>
    <p><strong>{benchmark ? "Benchmark measurements could not be refreshed." : "A data source could not be refreshed."}</strong></p>
    {accessFailure && <p>Lemonade published this result, but the dashboard couldn’t open the GitHub job that records which software build was tested{httpStatus ? ` (HTTP ${httpStatus})` : ""}.</p>}
    {measurement && <p>Affected measurement: {measurement[1]} · {workload}</p>}
    {runEvidence && <p>Reported software build: {runEvidence[2]}</p>}
    {sourceUrl && <p>
      <a href={sourceUrl} target="_blank" rel="noreferrer">Lemonade benchmark leaderboard</a>
      {run && <> · <a href={`https://github.com/${source!.repository}/actions/runs/${run}`} target="_blank" rel="noreferrer">Benchmark run</a></>}
    </p>}
    <details>
      <summary>Technical details</summary>
      <dl>
        <dt>Source</dt><dd>{entry.source_id}</dd>
        {entry.record && <><dt>Record</dt><dd>{entry.record}</dd></>}
        {entry.field && <><dt>Field</dt><dd>{entry.field}</dd></>}
        <dt>Reason</dt><dd>{entry.reason}</dd>
      </dl>
    </details>
  </div>;
}

export function SyncFailure({ sync }: { sync: Sync }) {
  return <div className="notice warning" role="region" aria-label={title}>
    <strong>{title}</strong>
    <p>Last update attempt: <time dateTime={sync.attempted_at}>{producedAt(sync.attempted_at)}</time>.</p>
    {sync.last_successful_at
      ? <p>Showing the last successful dataset, collected <time dateTime={sync.last_successful_at}>{producedAt(sync.last_successful_at)}</time>.</p>
      : <p>No successful dataset has been published yet.</p>}
    {sync.errors.map((entry, index) => <FailureDetails key={index} entry={entry} />)}
  </div>;
}
