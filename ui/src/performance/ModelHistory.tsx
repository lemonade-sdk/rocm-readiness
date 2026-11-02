import {
  text,
  Measurement,
  SystemRecord,
  formatDate,
  metricName,
  metricValue,
  packageLabel,
  comparisonKey,
  measurementTieBreaker,
  plural,
} from "./modelData";

export function ModelHistory({
  rows,
  systems,
  metric,
  onMetric,
}: {
  rows: Measurement[];
  systems: Map<string, SystemRecord>;
  metric: string;
  onMetric: (value: string) => void;
}) {
  const groups = new Map<string, Measurement[]>();
  const unavailable: Measurement[] = [];
  for (const row of rows) {
    const compatible = comparisonKey(row, systems);
    const key =
      compatible && row.lemonade_version
        ? JSON.stringify([compatible, row.lemonade_version])
        : null;
    if (!key) {
      unavailable.push(row);
      continue;
    }
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const ordered = [...groups.values()].map((group) =>
    group.sort(
      (a, b) =>
        Date.parse(a.measured_at) - Date.parse(b.measured_at) ||
        measurementTieBreaker(a).localeCompare(measurementTieBreaker(b)),
    ),
  );
  return (
    <section
      className="performance-history"
      aria-label="Model measurement history"
    >
      <h3>Measurement history</h3>
      <label>
        History metric{" "}
        <select
          value={metric}
          onChange={(event) => onMetric(event.target.value)}
        >
          {["tg_tps", "pp_tps", "ttft_ms_mean", "vram_peak_gb"].map((name) => (
            <option key={name} value={name}>
              {metricName(name)}
            </option>
          ))}
        </select>
      </label>
      <p>
        Each series has the same recorded hardware, OS, model, quantization,
        workload, context and input tokens. Package revisions and observation
        dates remain visible below. A single point does not establish a trend.
      </p>
      {ordered.map((group, index) => {
        const points = group.filter(
          (row) => typeof row.metrics[metric] === "number",
        );
        const values = points.map((row) => row.metrics[metric]);
        const minimum = Math.min(...values),
          maximum = Math.max(...values);
        const firstDate = points.length ? Date.parse(points[0].measured_at) : 0;
        const dateSpan = points.length
          ? Date.parse(points.at(-1)!.measured_at) - firstDate
          : 0;
        const coords = points.map((row) => ({
          row,
          x:
            dateSpan === 0
              ? 300
              : 35 +
                ((Date.parse(row.measured_at) - firstDate) / dateSpan) * 530,
          y:
            maximum === minimum
              ? 100
              : 165 -
                ((row.metrics[metric] - minimum) / (maximum - minimum)) * 130,
        }));
        return (
          <article
            key={comparisonKey(group[0], systems)!}
            className="performance-history-series"
          >
            <h4>
              Series {index + 1}: {group[0].quant} · {group[0].scenario} ·{" "}
              {group[0].system_id}
            </h4>
            {!!points.length && (
              <svg
                viewBox="0 0 600 210"
                role="img"
                aria-label={`${metricName(metric)} history, series ${index + 1}; values in the following table`}
              >
                <text x="35" y="15">
                  {metricValue(metric, maximum)}
                </text>
                {minimum !== maximum && (
                  <text x="35" y="170">
                    {metricValue(metric, minimum)}
                  </text>
                )}
                <line
                  x1="30"
                  y1="175"
                  x2="575"
                  y2="175"
                  className="history-axis"
                />
                {coords.length > 1 && (
                  <polyline
                    points={coords.map((p) => `${p.x},${p.y}`).join(" ")}
                    className="history-line"
                  />
                )}
                {coords.map(({ row, x, y }, i) => (
                  <g key={measurementTieBreaker(row)}>
                    <circle cx={x} cy={y} r="5" className="history-point">
                      <title>
                        {packageLabel(row)} · {formatDate(row.measured_at)} ·{" "}
                        {metricValue(metric, row.metrics[metric])}
                      </title>
                    </circle>
                    <text x={x} y="200" textAnchor="middle">
                      {i + 1}
                    </text>
                  </g>
                ))}
              </svg>
            )}
            {!points.length && (
              <p>
                This series has no reported {metricName(metric).toLowerCase()}.
              </p>
            )}
            <div className="performance-table-wrap">
              <table>
                <caption>Series {index + 1} observations</caption>
                <thead>
                  <tr>
                    <th>Point / measured date</th>
                    <th>Engine package</th>
                    <th>{metricName(metric)}</th>
                    <th>Producing evidence</th>
                  </tr>
                </thead>
                <tbody>
                  {group.map((row) => (
                    <tr key={measurementTieBreaker(row)}>
                      <td>
                        {points.indexOf(row) >= 0
                          ? `${points.indexOf(row) + 1} · `
                          : ""}
                        {formatDate(row.measured_at)}
                      </td>
                      <td>{packageLabel(row)}</td>
                      <td>
                        {typeof row.metrics[metric] === "number"
                          ? metricValue(metric, row.metrics[metric])
                          : "Not reported"}
                      </td>
                      <td>
                        {row.run_url ? (
                          <a
                            href={row.run_url}
                            target="_blank"
                            rel="noreferrer"
                          >
                            Run {row.run_id ?? "evidence"} ↗
                          </a>
                        ) : (
                          "Run unavailable"
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </article>
        );
      })}
      {!!unavailable.length && (
        <p>
          {plural(unavailable.length, "observation")} excluded from comparable
          history because hardware or workload metadata is incomplete.
          Individual observations remain below.
        </p>
      )}
      {!rows.length && <p>No measurements in this scope.</p>}
    </section>
  );
}
