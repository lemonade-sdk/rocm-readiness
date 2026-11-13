import { useState } from "react";
import { Link } from "react-router";
import type { Build } from "../data";
import { PlatformIcon } from "../PlatformIcon";
import { exactBuildHref } from "../overview/buildTimeline";
import { Tooltip, TooltipContent } from "../overview/Tooltip";
import { measurementIdentity, metricValue, type PerformanceData } from "./PerformanceView";
import { PerformanceIndicator } from "./PerformanceIndicator";
import "./PerformancePreview.css";

type Measurement = PerformanceData["measurements"][number];
type Observation = { build: Build; row: Measurement };
const platforms = ["windows", "linux"] as const;
const metrics = [
  { key: "pp_tps", label: "Prefill TPS", direction: "Higher is better" },
  { key: "tg_tps", label: "Decode TPS", direction: "Higher is better" },
] as const;

export function matchedPerformanceObservations(
  packages: Build[],
  measurements?: ReadonlyMap<Build, PerformanceData["measurements"]>,
): Observation[] {
  return [...measurements ?? []].filter(([build]) => packages.some((member) =>
    member === build || Boolean(member.run_id && build.run_id &&
      member.engine === build.engine && member.channel === build.channel &&
      member.rocm_version === build.rocm_version && member.source_id === build.source_id &&
      member.tag === build.tag && member.run_id === build.run_id &&
      member.gfx_family === build.gfx_family),
  )).flatMap(([build, rows]) => rows.map((row) => ({ build, row })));
}

function observationHref({ build, row }: Observation, exact = true) {
  const query = new URLSearchParams(exactBuildHref(build, "model").slice(1));
  query.set("model", row.model);
  if (exact) {
    query.set("observation", measurementIdentity(row));
    query.set("workload", row.scenario);
  }
  return `?${query}`;
}

function PerformanceCharts({ observations }: { observations: Observation[] }) {
  const [selection, setSelection] = useState<"both" | "windows" | "linux">("both");
  const available = platforms.filter((os) => observations.some(({ build, row }) =>
    build.os === os && metrics.some(({ key }) => row.metrics[key] != null)));
  const visible = available.filter((os) => selection === "both" || selection === os);
  const models = new Map<string, Map<string, Observation>>();
  for (const entry of [...observations].sort((a, b) => Date.parse(b.row.measured_at) - Date.parse(a.row.measured_at))) {
    const byPlatform = models.get(entry.row.model) ?? new Map<string, Observation>();
    if (!byPlatform.has(entry.build.os)) byPlatform.set(entry.build.os, entry);
    models.set(entry.row.model, byPlatform);
  }
  const maxima = new Map(metrics.map(({ key }) => [
    key,
    Math.max(0, ...[...models.values()].flatMap((entries) =>
      visible.map((os) => entries.get(os)?.row.metrics[key] ?? 0))),
  ]));
  function toggle(os: "windows" | "linux") {
    if (available.length < 2) return;
    setSelection(selection === "both" ? os === "windows" ? "linux" : "windows" : "both");
  }
  return <div className="performance-preview">
    <fieldset className="build-filter-options performance-preview-platforms" aria-label="Measurement platforms">
      {platforms.map((os) => <span key={os} className="performance-preview-platform-choice"
        title={!available.includes(os) ? "Unavailable" : undefined}><button type="button"
        disabled={!available.includes(os)}
        title={!available.includes(os) ? "Unavailable" : undefined}
        aria-pressed={visible.includes(os)}
        onClick={() => toggle(os)}>
        <PlatformIcon platform={os} />{os === "windows" ? "Windows" : "Linux"}
      </button></span>)}
    </fieldset>
    <div className="performance-chart">
    <div className="performance-chart-headings">
      <span>Model</span>
      {metrics.map(({ key, label, direction }) => <span key={key}><strong>{label}</strong><small>{direction}</small></span>)}
    </div>
    <div className="performance-chart-models">
      {[...models].sort(([a], [b]) => a.localeCompare(b)).map(([model, entries]) => {
        const first = visible.map((os) => entries.get(os)).find((entry) => entry);
        if (!first) return null;
        return <div className="performance-chart-model" key={model}>
          <Link className="performance-chart-model-name" to={observationHref(first, false)}
            aria-label={model} title={`${first.build.os} · ${first.row.scenario} · ${first.row.quant ?? "Quantization unreported"} · ${first.row.measured_at}`}>{model}</Link>
          {metrics.map(({ key, label, direction }) => <div className="performance-chart-bars" key={key}
            role="group" aria-label={`${model} · ${label}`}>
            {visible.map((os) => {
              const entry = entries.get(os);
              const value = entry?.row.metrics[key];
              const maximum = maxima.get(key) ?? 0;
              const width = value == null || maximum === 0 ? 0 : value / maximum * 100;
              return <div className="performance-chart-platform" key={os}>
                {visible.length > 1 && <span className="performance-chart-platform-label">
                  {os === "windows" ? "Windows" : "Linux"}
                </span>}
                {entry && value != null ? <Link className="performance-chart-track" data-platform={os}
                  to={observationHref(entry)}
                  aria-label={`${model} · ${os} · ${label} ${metricValue(key, value)} · ${direction}`}
                  title={`${os} · ${entry.row.scenario} · ${entry.row.quant ?? "Quantization unreported"} · ${entry.row.context_size ?? "Unknown"} context tokens · ${entry.row.system_id ?? "Hardware unreported"} · ${entry.row.measured_at}`}>
                  <span className="performance-chart-fill" style={{ width: `${width}%` }} />
                  <span className="performance-chart-value">{metricValue(key, value)}</span>
                </Link> : <span className="performance-chart-unavailable muted" title="Unavailable">Unavailable</span>}
              </div>;
            })}
          </div>)}
        </div>;
      })}
    </div>
    </div>
    <div className="performance-preview-details">
      {visible.map((os) => {
        const entry = observations.find(({ build }) => build.os === os);
        return entry && <Link key={os} to={exactBuildHref(entry.build, "build-performance")}
          aria-label={`Performance details for ${os === "windows" ? "Windows" : "Linux"} package ${entry.build.build_id}`}>
          {os === "windows" ? "Windows" : "Linux"} performance details
        </Link>;
      })}
    </div>
  </div>;
}

export function PerformancePreview({ heading, observations }: { heading: string; observations: Observation[] }) {
  if (!observations.length) return null;
  // Decision 0001: model comparisons need chart columns rather than detail rows.
  return <Tooltip side interactive contentClassName="performance-preview-popup"
    triggerClassName="performance-preview-trigger" label={`Performance data for ${heading}`}
    content={<TooltipContent heading={`Performance · ${heading}`} format="custom">
      <PerformanceCharts observations={observations} />
    </TooltipContent>}>
    <PerformanceIndicator />
  </Tooltip>;
}
