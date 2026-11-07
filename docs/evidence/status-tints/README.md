# Status tint comparison

The images compare the original 16% tint with the updated 28% tint for pass,
warning, and failure cells. Each image places **before above after**, at the
same scale, in the same theme.

- [Light theme comparison](light-comparison.png)
- [Dark theme comparison](dark-comparison.png)

Captured in Chromium on November 7, 2026, at a 1440 × 1050 viewport and device
scale factor 1. Each screenshot is cropped to the ROCm 10.1 overview region;
only the labels above the captures were added when stacking them.

Both states use the same loaded page and published dataset, pinned to
`a266b95c8da23a42399a439f98b85db0aaf6fa0b`. The before capture temporarily
appends the original shared evidence-status CSS block from
`a9810591221f99667db65020c36a537c0013d5ae`; removing that override produces
the after capture. Data, layout, status foregrounds, and glyphs are identical.

The page was also checked in both themes at a 390-pixel viewport, with no
page-level horizontal overflow. The calendar retains its own horizontal scroll.
