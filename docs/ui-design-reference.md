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
  Pair platform labels with the Windows mark or Linux Tux in filters and package
  headings. Selected filters use a subtle hover tint while retaining their selected fill and text contrast.
- Group version and platform controls together, with search at the trailing
  edge when space permits. Let the controls wrap at narrow widths. Use the
  workspace rail for navigation between dashboard views. Place ROCm version
  selection with the view filters. Show short version lists as visible choices. Keep the current title in the shared
  header and the theme control at its trailing edge. Label the selected date and platform above the package history.
- Put workspace navigation at the top of the desktop side rail and dataset
  provenance at the bottom. At narrow widths, keep navigation above the
  content and provenance below it. Nest view links under their workspace
  and use the shared filled selection style for the current view.
  Nest Performance under Build Qualification. Keep
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
  Use plain tier labels. Show each check’s pinned evidence in a tooltip anchored
  to its outcome block.
  Use Floating UI for anchored tooltips and interactive package popups, with an
  arrow to the trigger, viewport-aware positioning, keyboard and touch access,
  Escape and outside dismissal, and a visible close control for interactive panels.
  Table evidence popups open to the right and flip left when space requires it;
  keep them beside the row so readers can scan vertically between triggers.
  Keep the tooltip open while the pointer or keyboard focus is within its trigger
  or panel. Size package popups to their content within the viewport. Show visible
  platform packages in one compact column. Use top and bottom spacing, a shared
  heading typeface, and clearly weighted subsection headings to establish hierarchy.
  Separate platform sections with stronger horizontal rules and subsections with
  lighter horizontal rules. Avoid vertical heading rules and borders around nested navigation.
  Show package metadata, the pinned producer summary, and provenance links in
  the package popup. Keep full model names in performance tables.
  Tooltip links inherit the surrounding text color with a faint dotted underline
  and a small navigation arrow. Strengthen the underline on hover or keyboard focus.
  Performance glyphs open their own graph popup, separate from build metadata.
  Show horizontal TTFT and TPS bars on independent shared scales, retaining full
  model labels and values inside the graph tracks. Label lower TTFT and higher
  TPS as better. Display TTFT in seconds, converting producer milliseconds.
  Use the latest observation per model and OS. Platform bars expose workload,
  hardware and timestamp context and link to that exact observation.
  Windows/Linux toggles can show either platform or paired bars. Gray out
  unmeasured platforms with an Unavailable hover label. Keep VRAM out of this preview.
  Show the same matched-performance glyph on qualification build/family labels,
  and selected build headings. Only verified package matches
  establish the indicator. Pair OS packages only within the same qualification
  run, source, release track and GPU family.
  Show full model names, wrapping on narrow screens, and a visible scroll cue when
  more content is below the panel. List the visible platform packages and report links in the GPU-family panel,
  or under the platform heading for shared archives. Size check cells from the
  longest tier in the package and keep that width across its tier rows.
  Existing check links open the matching check tooltip for the exact package.
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

Upstream Health mirrors the Readiness workspace navigation with nested **Overview**
and **CI Activity** pages and the shared active-page treatment. Overview presents
rolled-up project metrics and 14-day activity calendars in flat sections with
primary-text headings, spacing and subtle rules. Use one project per row at all
widths, with a prominent Projects section heading. Keep the summary compact;
coverage explanations belong with the project evidence rather than above Projects.
Do not use rounded project containers or generic View details controls. Project
headings are neutral primary-text links to that project's CI Activity page; do not
repeat navigation beneath the calendar. Keep repository/fork information and
collection notices in CI Activity. Overview keeps aligned project metrics and
clickable daily activity, retaining unknown/incomplete evidence semantics. CI Activity reuses Build Qualification's grouped filter controls and selected
states: Project, Platform, Stack, and Target. Stack and Target are independent inclusive
toggle groups: all included values use the filled selected state, without an
Everything AMD control. Retain at least one value per group and keep both groups
in the URL; legacy lens links remain supported. Disable platforms without configured
jobs; retain at least one available platform. Preserve project/filter context when
switching sidebar pages. Overview day links open the exact UTC date and category
in CI Activity; retain that selection in the URL through reload and browser history. Keep
legacy project-only URLs working. List source repositories directly in the compact project summary, without a
repository disclosure or breadcrumb. Show incomplete collection as quiet project
metadata while retaining collection failures as alerts. Keep Overview as the rate-band summary. CI Activity uses the same
month groups, typography, table rules and scroll behavior, but uses Qualification trend’s stacked outcome bars for each
category, with a common run-count scale. Show the total through bar height, with
pass/failure segments proportional to their counts.
Keep every day's zero baseline aligned, including mixed outcomes and empty days;
filter changes must not shift individual bars below zero. Tooltip wrappers around
bars use block layout so outcome segments cannot affect inline baseline alignment.
Put exact counts and totals in the tooltip, keeping the chart free of per-day numeric labels. Opening or
closing a day tooltip must not add in-flow content or shift the chart. Never hide an
individual failure inside a pass-rate band. Open day evidence in the shared
interactive anchored popup with job logs, commits and pull-request links; preserve
selected UTC dates in the URL and browser history. Keep missing evidence distinct
from zero failures and label requested-but-unrun, skipped and undecided outcomes. Place daily activity before project-wide
coverage and findings, with job-log, commit and pull-request evidence available
in run drill-downs. Keep wide tables independently keyboard-scrollable.

Performance keeps the compact model dropdown with the shared filter buttons. Show
measurements in one table, including filtered and legacy model URLs, with TPS,
VRAM, TTFT, OS, and context. Keep quantization in the evidence popup. Model names open anchored evidence
popups instead of a second detail page. Label UTC once and keep timestamps in
the evidence. Display context workload labels as 4K/32K without changing source
identities or inferring missing numeric context. Keep workload details in the evidence popup.

Performance mirrors Package Qualification’s structure: stable uses a single table
with Build as its first grouped column; nightly uses the shared release headings
above separate tables with GPU family as the first grouped column. Reuse the
qualification matrix, release, scrolling, header, and cell styles directly.

Keep all measured builds visible by default; select the latest observation within
each build/configuration rather than across builds. Keep test details in evidence
popups instead of a separate Recorded tests section.

Build Qualification and Performance place Find build and Reset filters together
in the filter toolbar. Reset clears view filters and package/day/model drill-down
constraints while preserving the ROCm version and current qualification window.
Model-name links from performance previews open all workloads for the selected
model/package; exact metric links must show the observation’s workload selected.

Use compact metric headers with shared definition tooltips for units. Show Context
for the configured window capacity. Sort measurement rows within their build and
GPU-family groups. Rank builds by a selected metric only within one fully known
compatible cohort; do not rank different models or workloads as faster builds.
Use removable scope controls consistently in qualification and performance filters.

In CI Activity, place repositories beside visible project-wide findings below the
CI jobs table, stacking on narrow screens. List individual CI jobs in an always
visible table with Job, an icon-only Platform column and 14 dated outcome
columns matching Daily activity. Put Stack, Target and the pass rate for those
14 days in the job-name tooltip; retain accessible platform names.
Job-name tooltips identify the job and its evidence; pass rate
covers decided results in the displayed 14-day window. Keep job metadata and per-day
run evidence available in accessible anchored tooltips. Use a matching calendar
surface for a ranked failing-step table with exact failure counts and affected-job
counts. Give each step equal row height so rare failures remain readable beside
dominant failures; do not encode these counts as relative bar lengths. Label its
collection window separately from the 14-day activity chart. Truncate long job
and step labels using ellipses and expose full labels on hover, keyboard and touch.

Keep the CI jobs heading directly above its table without helper paragraphs.
Use compact, evenly aligned rows with full-cell day triggers and no inline
baseline gaps. Keep quiet-job details in the job-name tooltip. Show incomplete
collection as a subdued status with a warning symbol beneath the project title,
without a bullet or a support disclaimer there.

Project findings use neutral, low-contrast notices with a restrained alert symbol;
reserve failure colors for specific outcome evidence. Run tooltips use the shared
structured header and body, with a date, outcome counts and grouped run/evidence
links. Keep the selected day fixed: no previous/next controls inside tooltips.
Follow [Decision 0001: Shared evidence tooltip format](design-decisions/0001-evidence-tooltips.md).
Qualification check tooltips establish the default: compact headers, a consistent
label column, left-aligned values and fine dividers beneath each detail row.
Use shared `TooltipContent` formatting instead of page-specific alignment rules.
Each CI run has a small job/time heading and explicit labeled result, log, failed
step, commit and pull-request fields. Model performance explicitly uses the custom
body format for comparison graphs while retaining the same tooltip shell.
Use the shared popup close control, with a close button on standalone saved-day
fallbacks. Match qualification evidence links with inherited text color, dotted
underlines and a small external navigation mark.

## Shared outcome icons and legends

Use [the shared outcome registry](../ui/src/overview/outcomes.ts),
[BuildOutcomeIcon](../ui/src/overview/BuildOutcomeIcon.tsx), and
[OutcomeLegend](../ui/src/overview/OutcomeLegend.tsx) for new evidence tables and
charts. Do not introduce local glyph maps or handwritten legend markup. This
applies to every project, including empty and partially collected projects.

| Outcome | Glyph | Meaning |
| --- | --- | --- |
| Pass | ✓ | Recorded results passed |
| Warn | ! | Recorded warning; explain its meaning in the evidence |
| Fail | × | At least one recorded failure |
| Skipped | – | The job/check was explicitly skipped |
| Not applicable | ∕ | The check does not apply |
| Unreported | ? | Evidence is unavailable or unreported |
| Requested, no runs | □ | A requested job never ran; not a failed execution |
| Pending / undecided | ○ | Collected activity has no final pass/fail verdict |

Use the same compact wrapping legend layout beneath each related table or chart.
Cell legends show the same tinted block and glyph as their cells; stacked-bar
legends use matching outcome swatches. Keep skipped, unreported, pending and
requested-but-unrun evidence neutral. Do not reuse the skipped dash for missing
evidence, or the not-applicable slash for running jobs. Give icons accessible
labels through the cell, control or tooltip, and keep the legend labels visible.

Domain labels may clarify what an outcome means, without changing its glyph or
color role. Package qualification uses the established check labels. Coverage
uses “Observed” and “Not observed / unreported,” with unknown evidence remaining
neutral. Upstream Overview retains explicitly labeled pass-rate bands; these are
aggregates, not individual job verdicts. In the CI jobs table, any recorded
failure renders Fail, while running/other undecided results render Pending.
No project gets its own icon set, legend layout or tooltip format.

Use the declarative heading **Failing steps on main** for the failure ranking.
