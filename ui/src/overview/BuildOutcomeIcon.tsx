import type { ReactNode } from "react";
import type { TableOutcome } from "./outcomes";

const outcomeShapes: Record<TableOutcome, ReactNode> = {
  pass: <path d="m5 12 4.5 4.5L19 7" />,
  warn: <><path d="M12 4v10" /><path d="M12 19h.01" /></>,
  fail: <path d="m5 5 14 14M19 5 5 19" />,
  skip: <path d="M5 19v-8a6 6 0 0 1 12 0v3m-4-4 4 4 4-4" />,
  not_applicable: <path d="m17 4-10 16" />,
  unreported: <path d="M4 12h16" />,
  not_run: <rect x="4" y="4" width="16" height="16" rx="1" />,
  pending: <circle cx="12" cy="12" r="8" />,
  running: <><circle cx="12" cy="12" r="8" /><path d="M12 7v5h5" /></>,
  cancelled: <><circle cx="12" cy="12" r="8" /><path d="m6.3 17.7 11.4-11.4" /></>,
};

export function BuildOutcomeIcon({ outcome }: { outcome: TableOutcome | null }) {
  const status = outcome ?? "unreported";
  return <svg className="table-status-glyph" data-outcome={status} viewBox="0 0 24 24"
    fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round"
    aria-hidden="true" focusable="false">{outcomeShapes[status]}</svg>;
}
