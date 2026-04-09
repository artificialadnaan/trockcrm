import { useState } from "react";
import { toast } from "sonner";
import { Check } from "lucide-react";
import { api } from "@/lib/api";
import type { DealDetail } from "@/hooks/use-deals";

interface DealEstimatingSubstageProps {
  deal: DealDetail;
  onUpdate: () => void;
}

type EstimatingSubstage =
  | "scope_review"
  | "site_visit"
  | "missing_info"
  | "building_estimate"
  | "under_review"
  | "sent_to_client";

const SUBSTAGES: EstimatingSubstage[] = [
  "scope_review",
  "site_visit",
  "missing_info",
  "building_estimate",
  "under_review",
  "sent_to_client",
];

const SUBSTAGE_LABELS: Record<EstimatingSubstage, string> = {
  scope_review: "Scope Review",
  site_visit: "Site Visit",
  missing_info: "Missing Info",
  building_estimate: "Building Estimate",
  under_review: "Under Review",
  sent_to_client: "Sent to Client",
};

export function DealEstimatingSubstage({ deal, onUpdate }: DealEstimatingSubstageProps) {
  const [loading, setLoading] = useState(false);

  const current = (deal.estimatingSubstage ?? "scope_review") as EstimatingSubstage;
  const currentIndex = SUBSTAGES.indexOf(current);

  const updateSubstage = async (substage: EstimatingSubstage) => {
    if (substage === current || loading) return;
    setLoading(true);
    try {
      await api(`/deals/${deal.id}`, {
        method: "PATCH",
        json: { estimatingSubstage: substage },
      });
      toast.success(`Estimating stage: ${SUBSTAGE_LABELS[substage]}`);
      onUpdate();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to update estimating stage");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      role="group"
      aria-label="Estimating progress"
      className="flex flex-wrap items-center gap-1 py-2 px-1"
    >
      {SUBSTAGES.map((stage, index) => {
        const isCompleted = index < currentIndex;
        const isActive = index === currentIndex;
        const isFuture = index > currentIndex;
        const stepState = isCompleted ? "completed" : isActive ? "current" : "upcoming";

        return (
          <button
            key={stage}
            disabled={loading}
            onClick={() => updateSubstage(stage)}
            aria-current={isActive ? "step" : undefined}
            aria-label={`Step ${index + 1} of 6: ${SUBSTAGE_LABELS[stage]} — ${stepState}`}
            className={[
              "flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium border transition-colors",
              "focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-red",
              isCompleted
                ? "bg-green-100 text-green-700 border-green-200 hover:bg-green-200"
                : isActive
                ? "bg-brand-red text-white border-brand-red"
                : isFuture
                ? "bg-muted text-muted-foreground border-border hover:bg-muted/80"
                : "",
              loading ? "opacity-50 cursor-not-allowed" : "cursor-pointer",
            ].join(" ")}
          >
            {isCompleted && <Check className="h-3 w-3 flex-shrink-0" />}
            {SUBSTAGE_LABELS[stage]}
          </button>
        );
      })}
    </div>
  );
}
