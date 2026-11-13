import { useContext, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useMediaQuery, usePhoneLayout } from "../mobile";
import { EvidenceExpansion, EvidenceTarget } from "./EvidenceRegion";
import { EvidenceBody } from "./EvidenceDisclosure";
import { Link } from "react-router";
import type { ButtonHTMLAttributes, MouseEvent, ReactNode } from "react";
import {
  arrow, autoUpdate, flip, FloatingArrow, FloatingFocusManager, FloatingPortal,
  offset, safePolygon, shift, size, useClick, useDismiss, useFloating,
  useFocus, useHover, useInteractions, useRole,
} from "@floating-ui/react";
import "./Tooltip.css";

export const tooltipTiming = { openDelayMs: 400 };

export function TooltipContent({ heading, status, children, format = "details" }: {
  format?: "details" | "custom";
  heading: ReactNode;
  status?: ReactNode;
  children: ReactNode;
}) {
  return <span className="structured-tooltip">
    <span className="structured-tooltip-header"><strong>{heading}</strong>{status}</span>
    <span className="structured-tooltip-body" data-format={format}>{children}</span>
  </span>;
}

type TooltipProps = Parameters<typeof StyledTooltip>[0] & (
  | { tooltipMode?: "styled"; systemText?: never }
  | { tooltipMode: "system"; systemText: string }
);

/** Choose a single renderer. Native tooltips require an explicit plain-text alternative. */
export function Tooltip(props: TooltipProps) {
  if (props.tooltipMode !== "system") return <StyledTooltip {...props} />;
  const { label, systemText, children, to, triggerClassName, onLinkClick, buttonProps } = props;
  return <span className="comparison-tooltip">
    {to ? <Link to={to} className={triggerClassName} aria-label={label}
      title={systemText} onClick={onLinkClick}>{children}</Link>
      : <button {...buttonProps} type="button" className={`comparison-trigger ${triggerClassName ?? ""}`}
        aria-label={label} title={systemText}>{children}</button>}
  </span>;
}

function StyledTooltip({
  label, content, children, to, triggerClassName, onLinkClick, onOpen, buttonProps,
  interactive = false, contentClassName, initialOpen = false, side = false, isOpen, onOpenChange, mobilePrimary = false, mobileDisclosure = true, hoverOnly = false,
}: {
  label: string;
  buttonProps?: ButtonHTMLAttributes<HTMLButtonElement>;
  side?: boolean;
  content: ReactNode;
  children: ReactNode;
  to?: string;
  triggerClassName?: string;
  onLinkClick?: (event: MouseEvent<HTMLAnchorElement>) => void;
  onOpen?: () => void;
  interactive?: boolean;
  initialOpen?: boolean;
  isOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  floating?: boolean;
  contentClassName?: string;
  mobilePrimary?: boolean;
  mobileDisclosure?: boolean;
  hoverOnly?: boolean;
}) {
  const [localOpen, setOpen] = useState(initialOpen);
  const open = isOpen ?? localOpen;
  const phoneLayout = usePhoneLayout();
  const phone = phoneLayout && mobileDisclosure && !hoverOnly;
  const narrow = useMediaQuery("(max-width: 540px)");
  const evidenceTarget = useContext(EvidenceTarget);
  const expansion = useContext(EvidenceExpansion);
  const evidenceId = useId();
  const mobileTrigger = useRef<HTMLButtonElement>(null);
  const mobileClose = useRef(() => {});
  mobileClose.current = () => { setOpen(false); onOpenChange?.(false); };
  const registerExpansion = expansion?.register;
  useEffect(() => {
    if (!phone || !registerExpansion) return;
    return registerExpansion(evidenceId, open, () => mobileClose.current());
  }, [phone, open, evidenceId, registerExpansion]);
  const arrowRef = useRef<SVGSVGElement>(null);
  const scrollRef = useRef<HTMLSpanElement>(null);
  const contentRef = useRef<HTMLSpanElement>(null);
  const [moreBelow, setMoreBelow] = useState(false);
  const updateScrollHint = () => {
    const panel = scrollRef.current;
    setMoreBelow(Boolean(panel && panel.scrollHeight - panel.scrollTop > panel.clientHeight + 2));
  };
  const { refs, elements, floatingStyles, context, placement } = useFloating({
    open,
    onOpenChange(next) {
      if (next) onOpen?.();
      setOpen(next);
      onOpenChange?.(next);
    },
    placement: side ? "right-start" : "bottom-start",
    strategy: "fixed",
    whileElementsMounted: autoUpdate,
    middleware: [
      offset(10),
      flip({ padding: 12, ...(side ? { fallbackPlacements: ["left-start"], flipAlignment: false } : {}) }),
      shift({ padding: 12, crossAxis: side }),
      size({
        padding: 12,
        apply({ availableWidth, availableHeight, elements }) {
          elements.floating.style.setProperty("--tooltip-available-width", `${Math.max(0, availableWidth)}px`);
          elements.floating.style.setProperty("--tooltip-available-height", `${Math.max(0, availableHeight)}px`);
        },
      }),
      arrow({ element: arrowRef, padding: 12 }),
    ],
  });
  useEffect(() => {
    if (!open || !interactive) return;
    updateScrollHint();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(updateScrollHint);
    if (scrollRef.current) observer.observe(scrollRef.current);
    if (contentRef.current) observer.observe(contentRef.current);
    return () => observer.disconnect();
  }, [open, interactive, elements.floating]);
  const hover = useHover(context, {
    enabled: !phone,
    delay: { open: tooltipTiming.openDelayMs, close: hoverOnly ? 0 : 180 },
    move: false,
    handleClose: hoverOnly ? undefined : safePolygon(),
  });
  // URL-controlled popups open by hover or activation. Restoring focus after
  // dismissal must not reopen a popup that browser history just closed.
  const focus = useFocus(context, { visibleOnly: hoverOnly || Boolean(to), enabled: !phone && isOpen === undefined });
  const click = useClick(context, { enabled: !phone && !to && !hoverOnly, toggle: !interactive, stickIfOpen: true });
  const dismiss = useDismiss(context, { enabled: !phone });
  const role = useRole(context, { role: interactive ? "dialog" : "tooltip" });
  const { getReferenceProps, getFloatingProps } = useInteractions([hover, focus, click, dismiss, role]);

  if (phone) {
    // A navigation link stays a link. Supporting evidence never intercepts it.
    if (to) return <Link to={to} className={triggerClassName} aria-label={label} onClick={onLinkClick}>{children}</Link>;
    const change = (next: boolean) => {
      if (next) onOpen?.();
      setOpen(next);
      onOpenChange?.(next);
    };
    const expanded = open || (mobilePrimary && Boolean(expansion?.expanded.size));
    const close = () => { if (mobilePrimary) expansion?.closeOthers(evidenceId); change(false); mobileTrigger.current?.focus(); };
    const panel = open && <EvidenceBody id={evidenceId} role="region" aria-label={label}
      onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); close(); } }}
      className={contentClassName}>
      {!narrow && <button type="button" className="mobile-evidence-close" aria-label="Close evidence"
        onClick={close}>Close ×</button>}
      {content}
    </EvidenceBody>;
    return <span className="comparison-tooltip mobile-disclosure">
      <button ref={mobileTrigger} type="button" className={`comparison-trigger ${triggerClassName ?? ""}`}
        aria-label={label} aria-expanded={expanded} aria-controls={mobilePrimary && evidenceTarget ? evidenceTarget.id : open ? evidenceId : undefined}
        onKeyDown={(event) => { if (event.key === "Escape" && expanded) { event.stopPropagation(); close(); } }}
        onClick={() => { if (expanded) close(); else change(true); }}>{children}</button>
      {evidenceTarget ? createPortal(panel, evidenceTarget) : panel}
    </span>;
  }

  return <span className="comparison-tooltip">
    {hoverOnly ? <span
      ref={refs.setReference}
      tabIndex={0}
      className={`comparison-trigger tooltip-hover-trigger ${triggerClassName ?? ""}`}
      {...getReferenceProps({ "aria-label": label })}
    >{children}</span> : to ? <Link
      ref={refs.setReference}
      to={to}
      className={triggerClassName}
      {...getReferenceProps({ "aria-label": label, onClick: onLinkClick })}
    >{children}</Link> : <button
      ref={refs.setReference}
      type="button"
      className={`comparison-trigger ${triggerClassName ?? ""}`}
      {...getReferenceProps({ ...buttonProps, "aria-label": label })}
    >{children}</button>}
    {open && <FloatingPortal>
      <FloatingFocusManager context={context} modal={false} initialFocus={-1} disabled={!interactive}>
        <span
          ref={refs.setFloating}
          className={`comparison-bubble floating-tooltip ${contentClassName ?? ""}`}
          style={floatingStyles}
          data-placement={placement}
          {...getFloatingProps({ "aria-label": interactive ? label : undefined })}
        >
          <FloatingArrow ref={arrowRef} context={context} className="tooltip-arrow"
            fill="var(--panel)" stroke="var(--line)" strokeWidth={1} tipRadius={1} />
          <span className="tooltip-surface">
            {interactive && <button type="button" className="tooltip-close" aria-label="Close popup"
              onClick={(event) => context.onOpenChange(false, event.nativeEvent, "reference-press")}>×</button>}
            <span ref={scrollRef} className="tooltip-scroll-area" onScroll={updateScrollHint}>
              <span ref={contentRef} className="tooltip-content">{content}</span>
            </span>
            {interactive && moreBelow && <span className="tooltip-scroll-hint" aria-hidden="true">Scroll for more details ↓</span>}
          </span>
        </span>
      </FloatingFocusManager>
    </FloatingPortal>}
  </span>;
}
