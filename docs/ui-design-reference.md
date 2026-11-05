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
- Use the selected ROCm version and engine to scope the build calendars.
  Show each available track in its calendar heading. When the version already
  provides the track context, omit the separate track control.
- Use independent platform toggles with a filled and accessible pressed state.
  Keep at least one platform selected, and keep unavailable platforms visible
  and disabled. Determine platform availability from the version and engine
  before applying search or date paging. Keep filter selections in the URL.
- Group version and platform controls together, with search at the trailing
  edge when space permits. Let the controls wrap at narrow widths. Use the
  workspace rail for navigation between dashboard views. Place ROCm version
  selection with the view filters. Show short version lists as visible choices. Keep the current title in the shared
  header and the theme control at its trailing edge. Mark the focused build
  date at its header and keep the column on the shared calendar surface.
- Put workspace navigation at the top of the desktop side rail and dataset
  provenance at the bottom. At narrow widths, keep navigation above the
  content and provenance below it. Nest view links under their workspace
  and use the shared filled selection style for the current view. Keep
  keyboard focus visually distinct from the selected state.
- Make the ROCm version the primary heading and place engine names above the
  timeline surface. In Upstream Health, group project metrics separately from
  the dated activity table. Place the CI legend beneath its own calendar.
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
  weight to scan above the timeline panel. Show **Latest Stable** for the
  configured anchor and **Nightly** for versions newer than it.
- Keep the rail focused on dashboard navigation and dataset provenance. Treat
  additional destinations or selectors as separate design decisions.

## Evidence and status

- Place each calendar’s legend directly below its table so it explains the
  marks used there. Give calendar
  tables a visible heading above their shared, low-contrast surface. Use the shared heading style
  for the title, with the track, platform, or date window in smaller secondary
  text beside it. Keep headings and table labels available to assistive tools.
- Group consecutive UTC dates under a spanning month name. Show only the day
  number in each column and carry a subtle divider through the month boundary.
  Apply this pattern to Readiness Overview, Engine Builds, and Upstream CI
  calendars. Preserve the full UTC date in the accessible labels.

- Preserve the Readiness calendar's operating-system rows, month and day
  headers, and links to individual builds. In Upstream Health, keep metrics,
  coverage notes, and daily CI activity in distinct groups. Use the shared
  header for the dashboard title and lead with the CI summary in the body.
- Use compact, square-ended horizontal bars for build outcomes. Stack build
  bars vertically within each date in Engine Builds. In the Overview, show
  one bar per engine, track, platform, and UTC date using the latest build.
  Keep the full set of builds in Engine Builds. A solid teal bar
  indicates qualification, a half-filled amber bar indicates qualification
  with warnings, a hollow rose bar indicates failure, and a dashed neutral bar
  indicates missing evidence. Keep the text legend and descriptive build links.
  In Upstream Health, the shared
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
