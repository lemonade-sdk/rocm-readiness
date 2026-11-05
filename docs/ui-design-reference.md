# Signal Deck design language

Signal Deck is the shared design standard for the dashboard. This reference governs the appearance of ROCm Readiness and Upstream Health,
including their detail views. It supersedes the visual styling in the MVP1
prototype and shell plan. Use **ROCm Readiness** as the dashboard identity
and keep source and repository attribution visible where it belongs.

## Palette

| Role | Dark theme | Light theme |
| --- | --- | --- |
| Canvas | Charcoal `#1A1A1B` | Light gray `#F3F4F5` |
| Raised surface | Graphite `#27282B` | Light gray `#E9EAEC` |
| Primary text | Soft white `#DEDFE1` | Graphite `#27282B` |
| Secondary text | Gray `#B2B4B7` | Gray `#55575B` |
| Accent | Blue `#2899FF` | Blue `#0051C6` |
| Text on accent | Black `#000000` | White `#FFFFFF` |

Signal Deck takes its charcoal and graphite from the ROCm documentation header
and its blues from the ROCm documentation theme.
Use the accent for navigation, focus, and selected controls. Reuse the role
tokens in [the shared stylesheet](../ui/src/styles.css). Keep the established
palette in both themes. A palette change belongs in an explicit revision of
this standard and its shared tokens.

Keep status colors separate from the accent. Use labels or distinct symbols
with color for pass, fail, skipped, and unavailable states. Keep missing
qualification evidence neutral. Qualification, test outcomes, and hardware
validation each retain their own meaning.

## Layout and interaction

- Share navigation, typography, spacing, and control styles across views.
  Use headings and spacing to show hierarchy.
- Put dashboard navigation at the top of the desktop side rail and dataset
  provenance at the bottom. At narrow widths, keep navigation above the
  content and provenance below it.
- Make the ROCm version the primary heading and place engine names in the
  timeline header. In Upstream Health, group project metrics separately from
  the dated activity table and share one symbol legend across projects.
- Lay out related cards side by side when space permits and stack them on
  narrow screens. Keep timeline dates and build links readable at either width.
- Preserve System, Light, and Dark preferences. Check text and controls against
  their actual backgrounds in both themes. Use at least 4.5:1 contrast for
  normal text and 3:1 for meaningful controls, icons, and focus indicators.
- Verify visible keyboard focus, touch targets, and tooltip access by keyboard
  and touch. Respect reduced-motion preferences.

## Visual hierarchy

- Keep the technical character in the layout. Use compact sections, aligned
  data, and monospace for instrument labels, engine names, and comparable
  numbers. Use the shared sans-serif typography for prose and navigation.
- Separate related areas with space or a subtle change in surface tone. Use
  rules within data tables where they help track rows or date groups. Keep
  panel fills close to the canvas and reserve decorative treatment for the
  shared page header.
- Keep header controls quiet. Use a borderless theme icon with a visible focus
  state and make the active destination clear.
- Keep version and project headings prominent. Give the engine label enough
  weight to scan inside the timeline panel. Show **Latest Stable** for the
  configured anchor and **Nightly** for versions newer than it.
- Keep the rail focused on dashboard navigation and dataset provenance. Treat
  additional destinations or selectors as separate design decisions.

## Evidence and status

- Preserve the Readiness calendar's operating-system rows, month and day
  headers, and links to individual builds. In Upstream Health, keep metrics,
  coverage notes, and daily CI activity in distinct groups.
- Use status tokens consistently. Teal and a check indicate a qualified build,
  rose and a cross indicate a failure, and the neutral unavailable symbol
  indicates missing qualification evidence. In Upstream Health, the shared
  legend defines rate bands and distinguishes requested jobs that never ran
  from skipped jobs and days without collected evidence.
- Let wide tables scroll inside their own labeled, keyboard-focusable regions.
  Keep project and build drill-downs accessible by keyboard and touch.

## Reviewing UI changes

Review the affected view in both themes at narrow and wide widths. Compare it
with the other dashboard for shared navigation, spacing, and status conventions.
Check table semantics, keyboard focus, touch targets, and evidence links where
the change affects them. Update this reference when intentionally changing a
shared convention.
