import { createContext, useCallback, useId, useRef, useState, type ReactNode } from "react";

export const EvidenceTarget = createContext<HTMLDivElement | null>(null);
export const EvidenceExpansion = createContext<{
  expanded: ReadonlySet<string>;
  register: (id: string, open: boolean, close: () => void) => () => void;
  closeOthers: (id: string) => void;
} | null>(null);

/** Phone evidence appears below the matrix, outside its scrolling viewport. */
export function EvidenceRegion({ children }: { children: ReactNode }) {
  const targetId = useId();
  const [target, setTarget] = useState<HTMLDivElement | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const closers = useRef(new Map<string, () => void>());
  const register = useCallback((id: string, open: boolean, close: () => void) => {
    if (open) closers.current.set(id, close);
    else closers.current.delete(id);
    setExpanded((previous) => {
      if (previous.has(id) === open) return previous;
      const next = new Set(previous);
      if (open) next.add(id); else next.delete(id);
      return next;
    });
    return () => {
      closers.current.delete(id);
      setExpanded((previous) => {
        if (!previous.has(id)) return previous;
        const next = new Set(previous); next.delete(id); return next;
      });
    };
  }, []);
  const closeOthers = useCallback((id: string) => {
    for (const [key, close] of closers.current) if (key !== id) close();
  }, []);
  return <EvidenceExpansion.Provider value={{ expanded, register, closeOthers }}><EvidenceTarget.Provider value={target}>
    {children}
    <div id={targetId} className="mobile-matrix-evidence" ref={setTarget} />
  </EvidenceTarget.Provider></EvidenceExpansion.Provider>;
}
