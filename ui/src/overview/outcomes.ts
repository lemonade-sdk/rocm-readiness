/** Shared table outcome vocabulary. Domain-specific legends may clarify labels. */
export const tableOutcomes = {
  pass: { glyph: "✓", label: "Pass" },
  warn: { glyph: "!", label: "Warn" },
  fail: { glyph: "×", label: "Fail" },
  skip: { glyph: "–", label: "Skipped" },
  not_applicable: { glyph: "∕", label: "Not applicable" },
  unreported: { glyph: "?", label: "Unreported" },
  not_run: { glyph: "□", label: "Requested, no runs" },
  pending: { glyph: "○", label: "No pass or fail result" },
} as const;

export type TableOutcome = keyof typeof tableOutcomes;

/** Collector overrides describe not-applicable results, never a report that supersedes them with another outcome. */
export function qualificationOutcomeLabel(outcome: TableOutcome, supplied?: string): string {
  return outcome === "not_applicable" ? supplied ?? tableOutcomes[outcome].label : tableOutcomes[outcome].label;
}
