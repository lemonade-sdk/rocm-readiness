# Decision 0001: Shared evidence tooltip format

Status: Accepted · 2026-11-11

## Context

Build Qualification's package/check tooltips are the reference for evidence
throughout Signal Deck. CI Activity used different alignments, compressed link
clusters and abbreviated verdicts, making equivalent information harder to read.

## Decision

Use `Tooltip` and `TooltipContent` from `ui/src/overview/Tooltip.tsx`.
`TooltipContent` defaults to `format="details"`. The shared rules in
`ui/src/overview/Tooltip.css` own this format; individual pages must not duplicate
or override its label columns, value alignment, typography or row dividers.

- Header: identify the object or check; include a short outcome or total when
  useful. Dates include UTC. Keep scope in a subordinate line if needed.
- Body: use semantic `dl` label/value rows. Give labels a consistent column,
  left-align values directly beside them, and separate rows with fine horizontal
  rules. Use the Qualification check tooltip's compact spacing and type size.
- Hierarchy: put the summary first, then named evidence groups. For multiple
  records, identify each record with a small heading and repeat the same field
  structure. Do not pack unrelated links into a sentence or an unlabeled row.
- Language: use explicit labels such as Result, Job log, Failed step, Commit and
  Pull request. State verdicts in plain language. Distinguish a run failure from
  the pull request's CI result; avoid isolated “red,” “ok,” and “no run” labels.
- Evidence: preserve exact log, commit, report and pull-request links. Links use
  inherited text color, dotted underlines and a small navigation arrow. Pair
  outcome colors with the shared outcome symbols and a readable status.
- Size and interaction: ordinary evidence fits the shared 400px width, bounded
  by the viewport. Larger package collections may size to content. Long content
  scrolls inside the popup with a scroll cue. Retain anchored placement, hover,
  keyboard/touch access, Escape/outside dismissal and the interactive close
  control. Opening a tooltip must not move its source table or chart.

## Exceptions

Use `format="custom"` only when the content needs another representation, and
record the reason with that component. The model performance popup in
`ui/src/performance/PerformancePreview.tsx` needs aligned TTFT/TPS comparison
charts and full model labels; a two-column metadata list would lose that meaning.
It explicitly opts out of detail-row formatting while retaining the shared
header, surface, links, positioning, scrolling and accessibility behavior.

A specialized comparison table or graph may differ in body structure for the
same reason. More fields, another project, or a preference for different spacing
are not reasons for an exception. New exceptions belong in this decision.

## Verification

Check summary and detailed evidence in both themes at narrow and wide widths.
Verify labels and values align consistently, long text wraps within the popup,
links remain usable, and missing/failed/skipped states remain distinct. Shared
format tests live in `Tooltip.test.tsx`; CI browser regression checks cover
row alignment, dividers, viewport bounds and preserved evidence links.
