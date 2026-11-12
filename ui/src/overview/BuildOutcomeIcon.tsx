import { tableOutcomes, type TableOutcome } from "./outcomes";

export function BuildOutcomeIcon({ outcome }: { outcome: TableOutcome | null }) {
  return <span className="table-status-glyph" aria-hidden="true">{tableOutcomes[outcome ?? "unreported"].glyph}</span>;
}
