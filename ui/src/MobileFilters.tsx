import { useEffect, useId, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { usePhoneLayout } from "./mobile";

export function FilterIcon() {
  return <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
    <circle cx="12" cy="12" r="10" /><path d="M6.5 8h11M8.5 12h7M10.5 16h3" />
  </svg>;
}

/** The desktop toolbar remains visible; phones disclose the same controls. */
export function MobileFilters({ children, label = "Filters", count = 0 }: { children: ReactNode; label?: string; count?: number }) {
  const [open, setOpen] = useState(false);
  const phone = usePhoneLayout();
  const id = useId();
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useEffect(() => setSlot(document.getElementById("mobile-filter-slot")), []);
  const toggle = <button type="button" className="mobile-filter-toggle" aria-label={count ? `${label}, ${count} active` : label}
    aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
    <FilterIcon />{count > 0 && <span className="mobile-filter-count" aria-hidden="true">{count}</span>}
  </button>;
  return <div className="mobile-filters" data-open={open || undefined}>
    {phone && (slot ? createPortal(toggle, slot) : toggle)}
    <div id={id} className="mobile-filter-content">{children}</div>
  </div>;
}
