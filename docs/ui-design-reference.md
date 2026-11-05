# Dashboard design language

This reference governs the appearance of ROCm Readiness and Upstream Health,
including their detail views. It supersedes the visual styling in the MVP1
prototype and shell plan. Use **ROCm Readiness** as the dashboard identity
and keep source and repository attribution visible where it belongs.

## Palette

| Role | Dark theme | Light theme |
| --- | --- | --- |
| Canvas | Black `#000000` | White `#FFFFFF` |
| Raised surface | Neutral gray `#141414` | Neutral gray `#F5F5F5` |
| Primary text | White `#FFFFFF` | Black `#000000` |
| Secondary text | Gray `#B3B3B3` | Gray `#525252` |
| Accent | Gold `#C1A968` | Gold `#C1A968` |
| Text on gold | Black `#000000` | Black `#000000` |

Keep surfaces neutral and use gold sparingly for active navigation and primary
actions. In the light theme, give gold controls a dark boundary when the
control needs one to be recognizable. Use dark text for links and a dark
focus outline on light surfaces. On dark surfaces, gold can mark focus when
it meets contrast against adjacent colors.

Keep status colors separate from the accent. Use labels or distinct symbols
with color for pass, fail, skipped, and unavailable states. Keep missing
qualification evidence neutral. Qualification, test outcomes, and hardware
validation each retain their own meaning.

## Layout and interaction

- Share navigation, typography, spacing, and control styles across views.
  Use headings and spacing to show hierarchy.
- Lay out related cards side by side when space permits and stack them on
  narrow screens. Keep timeline dates and build links readable at either width.
- Preserve System, Light, and Dark preferences. Check text and controls against
  their actual backgrounds in both themes. Use at least 4.5:1 contrast for
  normal text and 3:1 for meaningful controls, icons, and focus indicators.
- Verify visible keyboard focus, touch targets, and tooltip access by keyboard
  and touch. Respect reduced-motion preferences.
