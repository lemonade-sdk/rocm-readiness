import { useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";
import "./Tooltip.css";

// Shared timing for application hover disclosures; not a user preference panel.
export const tooltipTiming = { openDelayMs: 400 };

export function Tooltip({
  label,
  content,
  children,
}: {
  label: string;
  content: ReactNode;
  children: ReactNode;
}) {
  const id = useId();
  const container = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancel = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  };
  const close = () => {
    cancel();
    setOpen(false);
  };
  const schedule = () => {
    cancel();
    timer.current = setTimeout(() => {
      setOpen(true);
      timer.current = null;
    }, tooltipTiming.openDelayMs);
  };
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent | KeyboardEvent) => {
      if (
        (event instanceof KeyboardEvent && event.key === "Escape") ||
        (event instanceof PointerEvent &&
          !container.current?.contains(event.target as Node))
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", dismiss);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", dismiss);
    };
  }, [open]);
  return (
    <span
      ref={container}
      className="comparison-tooltip"
      onPointerEnter={schedule}
      onPointerLeave={() => {
        if (!container.current?.contains(document.activeElement)) close();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          close();
          event.stopPropagation();
        }
      }}
    >
      <button
        type="button"
        className="comparison-trigger"
        aria-label={label}
        aria-describedby={open ? id : undefined}
        onFocus={schedule}
        onBlur={close}
        onClick={() => {
          cancel();
          setOpen(!open);
        }}
      >
        {children}
      </button>
      {open && (
        <span role="tooltip" id={id} className="comparison-bubble">
          {content}
        </span>
      )}
    </span>
  );
}
