const glyphs = {
  pass: "✓",
  warn: "!",
  fail: "×",
  skip: "–",
  not_applicable: "∕",
  unreported: "?",
};

export function BuildOutcomeIcon({ outcome }: { outcome: keyof typeof glyphs | null }) {
  return <span className="table-status-glyph" aria-hidden="true">{glyphs[outcome ?? "unreported"]}</span>;
}
