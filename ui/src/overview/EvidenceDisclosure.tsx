import type { HTMLAttributes, ReactNode } from "react";

/** Shared in-flow evidence surface for package, measurement and CI details. */
export function EvidenceBody({ className = "", ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={`mobile-evidence ${className}`} {...props} />;
}

export function EvidenceDisclosure({ children, initialOpen = false, className = "" }: {
  children: ReactNode; initialOpen?: boolean; className?: string;
}) {
  return <details className={`evidence-disclosure ${className}`} open={initialOpen}>
    <summary>Evidence &amp; configuration</summary>
    <EvidenceBody>{children}</EvidenceBody>
  </details>;
}
