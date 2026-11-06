import { useEffect, useLayoutEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router";
import type { MouseEvent, ReactNode } from "react";
import "./Tooltip.css";

// Shared timing for application hover disclosures; not a user preference panel.
export const tooltipTiming = { openDelayMs: 400 };

export function TooltipContent({ heading, status, children }: {
  heading: ReactNode;
  status?: ReactNode;
  children: ReactNode;
}) {
  return <span className="structured-tooltip">
    <span className="structured-tooltip-header"><strong>{heading}</strong>{status}</span>
    <span className="structured-tooltip-body">{children}</span>
  </span>;
}

export function Tooltip({
  label,
  content,
  children,
  to,
  triggerClassName,
  onLinkClick,
  onOpen,
  interactive = false,
  floating = Boolean(to),
}: {
  label: string;
  content: ReactNode;
  children: ReactNode;
  to?: string;
  onOpen?: () => void;
  interactive?: boolean;
  floating?: boolean;
  triggerClassName?: string;
  onLinkClick?: (event: MouseEvent<HTMLAnchorElement>) => void;
}) {
  const id = useId();
  const container = useRef<HTMLSpanElement>(null);
  const bubble = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hovered = useRef(false);
  const contains = (target: EventTarget | null) => target instanceof Node &&
    (container.current?.contains(target) || bubble.current?.contains(target));
  const cancelClose = () => {
    if (closeTimer.current !== null) clearTimeout(closeTimer.current);
    closeTimer.current = null;
  };
  const cancel = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  };
  const close = () => {
    cancel();
    cancelClose();
    setOpen(false);
  };
  const leave = () => {
    hovered.current = false;
    if (!open && !contains(document.activeElement)) cancel();
    cancelClose();
    closeTimer.current = setTimeout(() => {
      if (!hovered.current && !contains(document.activeElement)) close();
    }, 180);
  };
  const enter = () => {
    hovered.current = true;
    cancelClose();
  };
  const schedule = () => {
    cancelClose();
    if (open || timer.current !== null) return;
    timer.current = setTimeout(() => {
      onOpen?.();
      setOpen(true);
      timer.current = null;
    }, tooltipTiming.openDelayMs);
  };
  useLayoutEffect(() => {
    if (!open || !floating || !container.current || !bubble.current) return;
    const anchor = container.current;
    const panel = bubble.current;
    const place = () => {
      const target = anchor.getBoundingClientRect();
      const size = panel.getBoundingClientRect();
      setPosition({
        left: Math.max(12, Math.min(target.left, window.innerWidth - size.width - 12)),
        top: target.bottom + size.height + 6 <= window.innerHeight - 12
          ? target.bottom + 6
          : Math.max(12, target.top - size.height - 6),
      });
    };
    place();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(place);
    observer.observe(panel);
    return () => observer.disconnect();
  }, [open, floating]);
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
      if (closeTimer.current !== null) clearTimeout(closeTimer.current);
    },
    [],
  );
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent | KeyboardEvent) => {
      if (
        (event instanceof KeyboardEvent && event.key === "Escape") ||
        (event instanceof PointerEvent &&
          !contains(event.target))
      ) {
        close();
      }
    };
    const moved = () => { if (!hovered.current && !contains(document.activeElement)) close(); };
    if (floating) {
      window.addEventListener("scroll", moved, true);
      window.addEventListener("resize", moved);
    }
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", dismiss);
    return () => {
      if (floating) {
        window.removeEventListener("scroll", moved, true);
        window.removeEventListener("resize", moved);
      }
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", dismiss);
    };
  }, [open, floating]);
  return (
    <span
      ref={container}
      className="comparison-tooltip"
      onPointerEnter={() => { enter(); schedule(); }}
      onPointerLeave={leave}
      onBlur={(event) => {
        if (!contains(event.relatedTarget) && !hovered.current) close();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          if (bubble.current?.contains(document.activeElement)) container.current?.querySelector<HTMLElement>("button, a")?.focus();
          close();
          event.stopPropagation();
        }
        if (interactive && open && event.key === "Tab" && !event.shiftKey && !bubble.current?.contains(event.target as Node)) {
          const first = bubble.current?.querySelector<HTMLElement>("a[href], button");
          if (first) { event.preventDefault(); first.focus(); }
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
        >
          {children}
        </Link>
      ) : (
        <>
          <button
            type="button"
            className={`comparison-trigger ${triggerClassName ?? ""}`}
            aria-label={label}
            aria-describedby={open && !interactive ? id : undefined}
            aria-controls={interactive && open ? id : undefined}
            aria-expanded={interactive ? open : undefined}
            aria-haspopup={interactive ? "dialog" : undefined}
            onFocus={schedule}
              onClick={() => {
              cancel();
              if (!open) onOpen?.();
              setOpen(interactive || !open);
            }}
          >
            {children}
          </button>
        </>
      )}
      {open &&
        (floating ? (
          createPortal(
            <span
              role={interactive ? "dialog" : "tooltip"}
              aria-label={interactive ? label : undefined}
              onPointerEnter={enter}
              onPointerLeave={leave}
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
          <span ref={bubble} onPointerEnter={enter} onPointerLeave={leave} role="tooltip" id={id} className="comparison-bubble">
            {content}
          </span>
        ))}
    </span>
  );
}
