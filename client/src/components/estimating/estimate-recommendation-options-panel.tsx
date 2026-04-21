import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";

export { runEstimatePricingReviewStateAction } from "./estimate-pricing-review-table";

type RecommendationOption = {
  id: string;
  optionKind: "recommended" | "alternate" | "manual";
  optionLabel: string;
  rank?: number | null;
  rationale?: string | null;
  evidenceText?: string | null;
};

type RecommendationAction =
  | { action: "accept_recommended" | "accept_manual_row" | "reject" | "pending_review" }
  | { action: "switch_to_alternate"; alternateOptionId: string }
  | {
      action: "override";
      recommendedUnitPrice: string;
      recommendedTotalPrice: string;
      reason: string;
    };

export interface EstimateRecommendationRow {
  id: string;
  sectionName?: string | null;
  normalizedIntent?: string | null;
  duplicateGroupKey?: string | null;
  duplicateGroupBlocked?: boolean | null;
  selectedSourceType?: string | null;
  selectedOptionId?: string | null;
  catalogBacking?: string | null;
  promotedLocalCatalogItemId?: string | null;
  recommendedUnitPrice?: string | number | null;
  recommendedTotalPrice?: string | number | null;
  recommendationOptions?: RecommendationOption[];
  evidenceJson?: unknown;
  assumptionsJson?: unknown;
  sourceType?: string | null;
}

export interface EstimateRecommendationOptionsPanelProps {
  dealId: string;
  recommendation: EstimateRecommendationRow | null;
  onReviewAction: (input: RecommendationAction) => Promise<void> | void;
  onPromoteLocalCatalog: (recommendationId: string) => Promise<void> | void;
}

function formatLabel(value: string | null | undefined, fallback: string) {
  if (!value) return fallback;
  return value;
}

function summarizeUnknown(value: unknown) {
  if (!value) return "No detail";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return "No detail";
  }
}

function getRankLabel(option: RecommendationOption, index: number) {
  if (typeof option.rank === "number" && Number.isFinite(option.rank)) {
    return `Rank ${option.rank}`;
  }
  return `Rank ${index + 1}`;
}

function isFreeTextManualRow(recommendation: EstimateRecommendationRow) {
  return (
    recommendation.selectedSourceType === "manual" &&
    !recommendation.selectedOptionId &&
    recommendation.catalogBacking !== "local_catalog" &&
    !recommendation.promotedLocalCatalogItemId
  );
}

export async function runEstimatePromoteLocalCatalogAction({
  dealId,
  recommendationId,
  refresh,
}: {
  dealId: string;
  recommendationId: string;
  refresh: () => Promise<void>;
}) {
  await api(`/deals/${dealId}/estimating/manual-rows/${recommendationId}/promote-local-catalog`, {
    method: "POST",
  });
  await refresh();
}

export function EstimateRecommendationOptionsPanel({
  dealId,
  recommendation,
  onReviewAction,
  onPromoteLocalCatalog,
}: EstimateRecommendationOptionsPanelProps) {
  if (!recommendation) {
    return (
      <section className="rounded-lg border bg-background p-4 text-sm text-muted-foreground">
        Select a draft pricing row to review ranked options and evidence.
      </section>
    );
  }

  const options = [...(recommendation.recommendationOptions ?? [])].sort((left, right) => {
    const leftRank = left.rank ?? Number.MAX_SAFE_INTEGER;
    const rightRank = right.rank ?? Number.MAX_SAFE_INTEGER;
    if (leftRank !== rightRank) return leftRank - rightRank;
    if (left.optionKind !== right.optionKind) {
      if (left.optionKind === "recommended") return -1;
      if (right.optionKind === "recommended") return 1;
      if (left.optionKind === "alternate") return -1;
      if (right.optionKind === "alternate") return 1;
    }
    return left.optionLabel.localeCompare(right.optionLabel);
  });

  const recommendedOption = options.find((option) => option.optionKind === "recommended") ?? null;
  const alternateOptions = options.filter((option) => option.optionKind === "alternate");
  const selectedOption = options.find((option) => option.id === recommendation.selectedOptionId) ?? recommendedOption ?? options[0] ?? null;

  return (
    <section className="rounded-lg border bg-background" data-deal-id={dealId}>
      <div className="border-b px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold">Recommendation Options</h3>
          {recommendation.duplicateGroupBlocked ? (
            <Badge variant="destructive">Duplicate blocked</Badge>
          ) : null}
          {recommendation.catalogBacking === "local_catalog" ? (
            <Badge variant="secondary">Local catalog</Badge>
          ) : null}
          {recommendation.sourceType === "inferred" ? <Badge variant="outline">Inferred</Badge> : null}
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          {formatLabel(recommendation.sectionName, "Generated Estimate")} ·{" "}
          {formatLabel(recommendation.normalizedIntent, "No normalized intent")}
          {recommendation.duplicateGroupKey ? ` · ${recommendation.duplicateGroupKey}` : ""}
        </p>
      </div>

      <div className="grid gap-4 px-4 py-4">
        <div className="grid gap-3">
          <div className="flex items-center justify-between gap-2">
            <div className="text-xs uppercase tracking-wide text-muted-foreground">Selected option</div>
            {selectedOption ? <Badge variant="secondary">{getRankLabel(selectedOption, 0)}</Badge> : null}
          </div>
          {selectedOption ? (
            <div className="rounded-lg border bg-muted/20 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <div className="font-medium">{selectedOption.optionLabel}</div>
                {selectedOption.optionKind === "recommended" ? <Badge>Recommended</Badge> : null}
                {selectedOption.optionKind === "recommended" ? <Badge variant="outline">Default</Badge> : null}
                {selectedOption.optionKind === "alternate" ? <Badge variant="outline">Alternate</Badge> : null}
              </div>
              <div className="mt-2 text-xs text-muted-foreground">
                {selectedOption.rationale || "No rationale provided."}
              </div>
              {selectedOption.evidenceText ? (
                <div className="mt-2 text-xs text-muted-foreground">{selectedOption.evidenceText}</div>
              ) : null}
            </div>
          ) : (
            <div className="text-sm text-muted-foreground">No selected option available.</div>
          )}
        </div>

        {recommendedOption ? (
          <div className="grid gap-2">
            <div className="text-xs uppercase tracking-wide text-muted-foreground">Recommended</div>
            <div className="rounded-lg border p-3 text-sm">
              <div className="flex items-center gap-2">
                <div className="font-medium">{recommendedOption.optionLabel}</div>
                <Badge>Recommended</Badge>
                <Badge variant="outline">Default</Badge>
              </div>
              <div className="mt-2 text-xs text-muted-foreground">
                {recommendedOption.rationale || "Ranked as the primary option."}
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button size="xs" onClick={() => onReviewAction({ action: "accept_recommended" })}>
                  Accept recommended
                </Button>
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() =>
                    onReviewAction({
                      action: "override",
                      recommendedUnitPrice: `${recommendation.recommendedUnitPrice ?? ""}`,
                      recommendedTotalPrice: `${recommendation.recommendedTotalPrice ?? ""}`,
                      reason: "Override from workbench",
                    })
                  }
                >
                  Override
                </Button>
                <Button size="xs" variant="ghost" onClick={() => onReviewAction({ action: "pending_review" })}>
                  Pending review
                </Button>
                <Button size="xs" variant="destructive" onClick={() => onReviewAction({ action: "reject" })}>
                  Reject
                </Button>
              </div>
            </div>
          </div>
        ) : null}

        {alternateOptions.length > 0 ? (
          <div className="grid gap-2">
            <div className="text-xs uppercase tracking-wide text-muted-foreground">Alternates</div>
            <div className="grid gap-2">
              {alternateOptions.map((option, index) => (
                <div key={option.id} className="rounded-lg border p-3 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="font-medium">{option.optionLabel}</div>
                    <Badge variant="outline">{getRankLabel(option, index)}</Badge>
                    <Badge variant="outline">Alternate</Badge>
                  </div>
                  <div className="mt-2 text-xs text-muted-foreground">
                    {option.rationale || "No rationale provided."}
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button
                      size="xs"
                      variant="outline"
                      onClick={() =>
                        onReviewAction({
                          action: "switch_to_alternate",
                          alternateOptionId: option.id,
                        })
                      }
                    >
                      Switch to alternate
                    </Button>
                    <Button size="xs" variant="ghost" onClick={() => onReviewAction({ action: "accept_manual_row" })}>
                      Accept manual row
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        <div className="grid gap-2">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">Evidence</div>
          <div className="rounded-lg border bg-muted/20 p-3 text-xs text-muted-foreground">
            {summarizeUnknown(recommendation.evidenceJson)}
          </div>
          <div className="rounded-lg border bg-muted/20 p-3 text-xs text-muted-foreground">
            Assumptions: {summarizeUnknown(recommendation.assumptionsJson)}
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          {isFreeTextManualRow(recommendation) ? (
            <Button size="sm" variant="outline" onClick={() => onPromoteLocalCatalog(recommendation.id)}>
              Promote to local catalog
            </Button>
          ) : null}
        </div>
      </div>
    </section>
  );
}
