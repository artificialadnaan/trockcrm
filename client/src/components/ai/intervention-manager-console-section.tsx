import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface InterventionManagerConsoleSectionProps {
  id: "manager-brief" | "queue-health" | "manager-alerts" | "outcome-effectiveness" | "policy-recommendations";
  title: string;
  description: string;
  children: ReactNode;
}

export function InterventionManagerConsoleSection({
  id,
  title,
  description,
  children,
}: InterventionManagerConsoleSectionProps) {
  const headingId = `${id}-title`;

  return (
    <section
      id={id}
      aria-labelledby={headingId}
      className={cn(
        "scroll-mt-24 rounded-2xl border border-border/80 bg-white shadow-sm",
        "transition-shadow hover:shadow-md"
      )}
    >
      <div className="border-b border-border/70 px-4 py-4 sm:px-6">
        <div className="space-y-1">
          <h2 id={headingId} className="text-base font-semibold tracking-tight text-gray-900">
            {title}
          </h2>
          <p className="text-sm leading-6 text-muted-foreground">{description}</p>
        </div>
      </div>
      <div className="px-4 py-4 sm:px-6">{children}</div>
    </section>
  );
}
