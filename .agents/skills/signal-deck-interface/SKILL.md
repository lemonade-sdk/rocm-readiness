---
name: signal-deck-interface
description: Design or review interface changes for the ROCm Readiness and Upstream Health dashboards. Use for changes to the shared shell, navigation, themes, tables, evidence views, or status indicators.
---

# Signal Deck interface design

Read the repository's `docs/ui-design-reference.md` and inspect the existing view
and shared theme tokens before editing. Use Signal Deck as the baseline for both
dashboards.

1. Identify what readers need to find, compare, or act on. Make the page heading,
   section labels, and primary evidence follow that order. Separate unlike data
   with spacing and alignment before adding containers or visual decoration.
2. Reuse shared navigation, typography, spacing, and color roles. Give a new
   pattern the same meaning across views wherever it appears. Keep brand accents
   separate from evidence states.
3. Pair status color with a symbol or short label. Distinguish an unsuccessful
   result from a job that never ran and from missing evidence. Retain meaningful
   table headers, dates, links, and the data's existing scope.
4. Use semantic controls, descriptive labels, and visible focus. Review the
   changed view with keyboard and touch in mind. Check reading order, contrast,
   and overflow at narrow and wide widths in both themes. Keep wide tables
   scrollable within their own labeled regions.
5. Use the verification commands in `ui/README.md`. If an agreed change alters a
   shared convention, update the design reference alongside the implementation.
