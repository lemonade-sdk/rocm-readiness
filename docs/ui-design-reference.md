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
Use a 38% status-color tint in dark mode and 28% in light mode for pass, warning,
and failure table cells so build outcomes are easy to scan against each theme's
surfaces. Keep skipped and unavailable cells at a quieter 16%
neutral tint, and retain the existing status foregrounds in both themes.

## Layout and interaction

- Share navigation, typography, spacing, and control styles across views.
  Use headings and spacing to show hierarchy.
- Use the selected ROCm version and engine to scope the qualification history.
  Show one ROCm version at a time and default to the configured stable anchor.
  Show only the selected release’s track in the trend and identify the track
  and ROCm version for each package.
- Use independent platform toggles with a filled and accessible pressed state.
  Keep at least one platform selected, and keep unavailable platforms visible
  and disabled. Determine platform availability from the version and engine
  before applying search or date paging. Keep filter selections in the URL.
- Group version and platform controls together, with search at the trailing
  edge when space permits. Let the controls wrap at narrow widths. Use the
  workspace rail for navigation between dashboard views. Place ROCm version
  selection with the view filters. Show short version lists as visible choices. Keep the current title in the shared
  header and the theme control at its trailing edge. Label the selected date and platform above the package history.
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
- Give parent sections a larger heading and more space above and below it.
  Place a short label beside a nested technical identifier when its role would
  otherwise be unclear. In package qualification, keep the build heading above
  its Nightly packages, with GPU family before the OS columns. For Stable
  shared archives, use a single table with Build as the first column.
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
- End the default ROCm Readiness calendars on the current UTC date, even
  when there are no builds that day. Mark today's date with stronger neutral type.
  Build Qualification also opens historical windows through paging or a date link.
- Group consecutive UTC dates under a spanning month name. Show only the day
  number in each column and carry a subtle divider through the month boundary.
  Apply this pattern to Readiness Overview and Upstream CI calendars. Preserve the full UTC date in the accessible labels.

- Lead Build Qualification with daily stacked outcome bars for the selected release track. Put day numbers below the bars and month groups below the days.
  Use separate labeled Windows and Linux charts with the same package-count scale.
  Show publishing by OS beside each build.
- Group packages by release workflow run, then GPU family when reported, then
  platform. List compiled Stable GPU targets by OS in the build-number popup.
  Show the runtime-validated target separately.
  Put the date and run ID in the build tooltip. Overview links preserve the
  selected package and its UTC date, version, track, engine, and platform.
  Use short platform or GPU package labels and compact tinted check cells with distinct glyphs.
  Use the shared padded tooltip header and body for tier and check details.
  Keep the tooltip open while the pointer or keyboard focus is within its trigger
  or panel. List the visible platform packages and report links in the GPU-family panel,
  or under the platform heading for shared archives. Size check cells from the
  longest tier in the package and keep that width across its tier rows.
  An individual check opens the same check in the exact package report.
- Compare benchmark results only within one compatible workload and hardware
  cohort using verified package matches.
- Preserve the Readiness calendar's operating-system rows, month and day
  headers, and links to individual builds. In Upstream Health, keep metrics,
  coverage notes, and daily CI activity in distinct groups. Use the shared
  header for the dashboard title and lead with the CI summary in the body.
- Use tinted status cells with distinct glyphs for table evidence. Show the latest
  build per engine, track, platform, and UTC date in Overview. Keep individual
  packages available in Build Qualification. Reserve stacked bars for trends.
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
