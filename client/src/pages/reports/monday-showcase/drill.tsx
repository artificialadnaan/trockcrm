import { createContext, useContext, type ReactNode } from "react";
import type { EvidenceRequest } from "./types";

// Lets any number deep in a variant open the evidence drawer without prop-drilling through every layer.
interface DrillContextValue {
  open: (request: EvidenceRequest) => void;
}

const DrillContext = createContext<DrillContextValue | null>(null);

export function DrillProvider({
  open,
  children,
}: {
  open: (request: EvidenceRequest) => void;
  children: ReactNode;
}) {
  return <DrillContext.Provider value={{ open }}>{children}</DrillContext.Provider>;
}

export function useDrill(): DrillContextValue | null {
  return useContext(DrillContext);
}

/**
 * Wraps a rendered number so clicking it opens the supporting records. Falls back to plain text when no
 * provider is mounted (e.g. a variant rendered in isolation in a test), so it's always safe to wrap.
 */
export function DrillNumber({
  request,
  children,
  className = "",
}: {
  request: EvidenceRequest;
  children: ReactNode;
  className?: string;
}) {
  const drill = useDrill();
  if (!drill) return <>{children}</>;
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        drill.open(request);
      }}
      title="Show the records behind this number"
      className={`cursor-pointer rounded outline-none transition hover:bg-slate-900/[0.04] focus-visible:ring-2 focus-visible:ring-sky-400/70 ${className}`}
    >
      {children}
    </button>
  );
}

// Reusable dotted-underline affordance for inline numbers (signals "click for the records").
export const DRILL_UNDERLINE =
  "underline decoration-dotted decoration-slate-300 underline-offset-[3px] hover:decoration-current";
