import { useEffect, useLayoutEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router";
import type { MouseEvent, ReactNode } from "react";
import "./Tooltip.css";

// Shared timing for application hover disclosures; not a user preference panel.
export const tooltipTiming = { openDelayMs: 400 };

export function Tooltip({
  label,
  content,
  children,
  to,
  triggerClassName,
  onLinkClick,
}: {
  label: string;
  content: ReactNode;
  children: ReactNode;
  to?: string;
  triggerClassName?: string;
  onLinkClick?: (event: MouseEvent<HTMLAnchorElement>) => void;
}) {
  const id = useId();
  const container = useRef<HTMLSpanElement>(null);
  const bubble = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0 });
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
      const rect = container.current?.getBoundingClientRect();
      if (rect)
        setPosition({
          left: Math.max(
            16,
            Math.min(
              rect.left,
              window.innerWidth - Math.min(400, window.innerWidth - 72) - 16,
            ),
          ),
          top: rect.bottom + 6,
        });
      setOpen(true);
      timer.current = null;
    }, tooltipTiming.openDelayMs);
  };
  useLayoutEffect(() => {
    if (!open || !to || !container.current || !bubble.current) return;
    const target = container.current.getBoundingClientRect(),
      size = bubble.current.getBoundingClientRect();
    setPosition({
      left: Math.max(
        12,
        Math.min(target.left, window.innerWidth - size.width - 12),
      ),
      top:
        target.bottom + size.height + 6 <= window.innerHeight - 12
          ? target.bottom + 6
          : Math.max(12, target.top - size.height - 6),
    });
  }, [open, to]);
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
    const moved = () => setOpen(false);
    if (to) {
      window.addEventListener("scroll", moved, true);
      window.addEventListener("resize", moved);
    }
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", dismiss);
    return () => {
      if (to) {
        window.removeEventListener("scroll", moved, true);
        window.removeEventListener("resize", moved);
      }
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", dismiss);
    };
  }, [open, to]);
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
      {to ? (
        <Link
          to={to}
          className={triggerClassName}
          aria-label={label}
          aria-describedby={open ? id : undefined}
          onClick={onLinkClick}
          onFocus={schedule}
          onBlur={close}
        >
          {children}
        </Link>
      ) : (
        <>
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
        </>
      )}
      {open &&
        (to ? (
          createPortal(
            <span
              role="tooltip"
              id={id}
              ref={bubble}
              className="comparison-bubble build-tooltip-bubble"
              style={{
                position: "fixed",
                left: position.left,
                top: position.top,
                right: "auto",
              }}
            >
              {content}
            </span>,
            document.body,
          )
        ) : (
          <span role="tooltip" id={id} className="comparison-bubble">
            {content}
          </span>
        ))}
    </span>
  );
}
