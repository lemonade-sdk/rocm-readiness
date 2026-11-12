import { BuildOutcomeIcon } from "./BuildOutcomeIcon";
import { tableOutcomes, type TableOutcome } from "./outcomes";

export type OutcomeLegendItem = { outcome: TableOutcome; label?: string; mark?: "cell" | "bar" };

/** Labels describe the domain; glyphs, color roles and spacing stay shared. */
export function OutcomeLegend({ items, label, className = "" }: {
  items: readonly OutcomeLegendItem[];
  label: string;
  className?: string;
}) {
  return <ul className={`outcome-key ${className}`} aria-label={label}>
    {items.map((item, index) => <li key={`${item.outcome}:${index}`}>
      <span className={item.mark === "bar" ? "outcome-key-bar" : "table-status outcome-key-mark"}
        data-outcome={item.outcome} aria-hidden="true">
        {item.mark !== "bar" && <BuildOutcomeIcon outcome={item.outcome} />}
      </span>
      {item.label ?? tableOutcomes[item.outcome].label}
    </li>)}
  </ul>;
}
