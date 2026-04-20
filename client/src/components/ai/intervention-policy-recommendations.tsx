import { useState, type ReactNode } from "react";
import {
  applyInterventionPolicyRecommendation,
  regenerateInterventionPolicyRecommendations,
  revertInterventionPolicyRecommendation,
  submitInterventionPolicyRecommendationFeedback,
  type InterventionPolicyRecommendation,
  type InterventionPolicyRecommendationReviewDecisionFilter,
  type InterventionPolicyRecommendationReviewWindow,
  type InterventionPolicyRecommendationsView,
  useInterventionPolicyRecommendationReview,
} from "@/hooks/use-ai-ops";
import { Button } from "@/components/ui/button";

type ReviewSectionKey = "overview" | "history" | "diagnostics" | "calibration" | "seededValidation";

const defaultReviewSections: Record<ReviewSectionKey, boolean> = {
  overview: true,
  history: false,
  diagnostics: false,
  calibration: false,
  seededValidation: false,
};

function formatFreshnessLabel(value: string | null | undefined) {
  if (!value) return "Unknown freshness";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown freshness";
  return `Generated ${date.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`;
}

function formatHistoryEventLabel(value: string) {
  if (value === "applied_noop") return "Applied no-op";
  if (value === "revert_noop") return "Undo no-op";
  if (value === "revert_rejected_conflict") return "Undo rejected";
  return value.split("_").join(" ");
}

function formatDiagnosticActionLabel(value: string) {
  return value.split("_").join(" ");
}

function formatDiagnosticBlockerLabel(value: string) {
  return value.split("_").join(" ");
}

function formatThresholdCalibrationNoProposalReason(value: string | null | undefined) {
  if (!value) return "No threshold changes are currently recommended.";
  if (value === "low_volume_dominates") {
    return "No threshold changes are currently recommended because low volume dominates.";
  }
  if (value === "predicate_failure_dominates") {
    return "No threshold changes are currently recommended because predicate failure dominates.";
  }
  if (value === "target_coverage_dominates") {
    return "No threshold changes are currently recommended because target coverage dominates.";
  }
  if (value === "cap_pressure_dominates") {
    return "No threshold changes are currently recommended because cap pressure should be reviewed first.";
  }
  return "No threshold changes are currently recommended because threshold pressure is not dominant.";
}

function formatDecisionFilterLabel(value: InterventionPolicyRecommendationReviewDecisionFilter) {
  if (value === "rendered") return "Rendered only";
  if (value === "suppressed") return "Suppressed only";
  return "All decisions";
}

function humanizeAction(value: string | null | undefined) {
  if (!value) return "hold current thresholds";
  return value.split("_").join(" ");
}

function humanizeReviewWindow(value: InterventionPolicyRecommendationReviewWindow | string) {
  return value.split("_").join(" ");
}

function getAttentionSummary(review: ReturnType<typeof useInterventionPolicyRecommendationReview>["data"]) {
  if (!review) return "Attention now: recommendation review data is unavailable.";
  const proposalCount = review.thresholdCalibrationProposals?.proposals.length ?? 0;
  if (proposalCount > 0) {
    return `Attention now: threshold review is recommended for ${proposalCount} ${proposalCount === 1 ? "taxonomy" : "taxonomies"}.`;
  }
  const nextAction = review.diagnostics?.systemDiagnostics.recommendedNextAction;
  if (nextAction === "seed_non_prod_validation") {
    return "Attention now: recommendation history is too thin to justify live changes.";
  }
  if (nextAction === "review_threshold_floor_in_code") {
    return "Attention now: threshold pressure is limiting live recommendations.";
  }
  if (nextAction === "review_ranking_cap_in_code") {
    return "Attention now: ranking cap pressure is crowding out recommendations.";
  }
  if (nextAction === "review_target_coverage" || nextAction === "review_apply_eligibility") {
    return "Attention now: target coverage is limiting live recommendations.";
  }
  return "Attention now: no immediate review action.";
}

function getCalibrationStatus(review: ReturnType<typeof useInterventionPolicyRecommendationReview>["data"]) {
  if (!review) return "Calibration status: review data is unavailable.";
  const proposalCount = review.thresholdCalibrationProposals?.proposals.length ?? 0;
  if (proposalCount > 0) {
    return `Calibration status: threshold review is recommended for ${proposalCount} ${proposalCount === 1 ? "taxonomy" : "taxonomies"}.`;
  }
  return `Calibration status: ${formatThresholdCalibrationNoProposalReason(
    review.thresholdCalibrationProposals?.noProposalReason
  )}`;
}

function buildOverviewItems(review: ReturnType<typeof useInterventionPolicyRecommendationReview>["data"]) {
  if (!review) {
    return {
      attention: "What needs attention now: review data is unavailable.",
      nextAction: "Next safe action: wait for recommendation review data.",
      calibration: "Calibration status: review data is unavailable.",
      context: "Latest snapshot: unknown freshness.",
    };
  }
  return {
    attention: `What needs attention now: ${getAttentionSummary(review).replace(/^Attention now:\s*/i, "")}`,
    nextAction: `Next safe action: ${humanizeAction(review.diagnostics?.systemDiagnostics.recommendedNextAction)}.`,
    calibration: getCalibrationStatus(review),
    context: `Latest snapshot: ${formatFreshnessLabel(review.snapshot?.generatedAt ?? null)} · Review window: ${humanizeReviewWindow(review.summary?.window ?? "last_30_days")}.`,
  };
}

function formatOccurredAtLabel(value: string | null | undefined) {
  if (!value) return "Unknown time";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown time";
  return date.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function formatPolicyDiffValue(value: number | string | null | undefined, mode?: "percent") {
  if (value == null) return "Not set";
  if (mode === "percent") return `${value}%`;
  return String(value);
}

export function buildPolicyDiffRows(
  proposedChange: InterventionPolicyRecommendation["proposedChange"]
) {
  if (!proposedChange) return [] as Array<{ label: string; before: string; after: string }>;

  const rows =
    proposedChange.kind === "snooze_policy_adjustment"
      ? [
          {
            label: "Max snooze days",
            before: formatPolicyDiffValue(proposedChange.currentValue.maxSnoozeDays),
            after: formatPolicyDiffValue(proposedChange.proposedValue.maxSnoozeDays),
          },
          {
            label: "Breach review threshold",
            before: formatPolicyDiffValue(proposedChange.currentValue.breachReviewThresholdPercent, "percent"),
            after: formatPolicyDiffValue(proposedChange.proposedValue.breachReviewThresholdPercent, "percent"),
          },
        ]
      : proposedChange.kind === "escalation_policy_adjustment"
        ? [
            {
              label: "Routing mode",
              before: formatPolicyDiffValue(proposedChange.currentValue.routingMode),
              after: formatPolicyDiffValue(proposedChange.proposedValue.routingMode),
            },
            {
              label: "Escalation threshold",
              before: formatPolicyDiffValue(proposedChange.currentValue.escalationThresholdPercent, "percent"),
              after: formatPolicyDiffValue(proposedChange.proposedValue.escalationThresholdPercent, "percent"),
            },
          ]
        : [
            {
              label: "Balancing mode",
              before: formatPolicyDiffValue(proposedChange.currentValue.balancingMode),
              after: formatPolicyDiffValue(proposedChange.proposedValue.balancingMode),
            },
            {
              label: "Overload share threshold",
              before: formatPolicyDiffValue(proposedChange.currentValue.overloadSharePercent, "percent"),
              after: formatPolicyDiffValue(proposedChange.proposedValue.overloadSharePercent, "percent"),
            },
            {
              label: "Minimum high-risk cases",
              before: formatPolicyDiffValue(proposedChange.currentValue.minHighRiskCases),
              after: formatPolicyDiffValue(proposedChange.proposedValue.minHighRiskCases),
            },
          ];

  return rows.filter((row) => row.before !== row.after);
}

export async function regeneratePolicyRecommendationState({
  regenerate,
  refreshView,
  refreshReview,
  delaysMs = [800, 1200, 1600, 2200, 3000, 4000, 5000],
  wait = (delayMs: number) => new Promise((resolve) => window.setTimeout(resolve, delayMs)),
}: {
  regenerate: () => Promise<unknown>;
  refreshView: () => Promise<void>;
  refreshReview: () => Promise<void>;
  delaysMs?: number[];
  wait?: (delayMs: number) => Promise<unknown>;
}) {
  await regenerate();
  await refreshView();
  await refreshReview();

  for (const delayMs of delaysMs) {
    await wait(delayMs);
    await refreshView();
    await refreshReview();
  }
}

function PolicyRecommendationCard({
  recommendation,
  onRefresh,
}: {
  recommendation: InterventionPolicyRecommendation;
  onRefresh: () => Promise<void> | void;
}) {
  const [feedbackValue, setFeedbackValue] = useState(recommendation.feedbackStateForViewer);
  const [comment, setComment] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [showReviewDetails, setShowReviewDetails] = useState(false);
  const [showApplyPreview, setShowApplyPreview] = useState(false);
  const [applying, setApplying] = useState(false);
  const [localApplyStatus, setLocalApplyStatus] = useState(recommendation.applyStatus);
  const [actionError, setActionError] = useState<string | null>(null);

  async function handleFeedback(nextValue: "helpful" | "not_useful" | "wrong_direction") {
    setSubmitting(true);
    setActionError(null);
    try {
      await submitInterventionPolicyRecommendationFeedback({
        recommendationId: recommendation.id,
        feedbackValue: nextValue,
        comment,
      });
      setFeedbackValue(nextValue);
      await onRefresh();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Failed to save recommendation feedback");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleApply() {
    if (!recommendation.proposedChange) return;
    setApplying(true);
    setActionError(null);
    try {
      const result = await applyInterventionPolicyRecommendation({
        recommendationId: recommendation.id,
        snapshotId: recommendation.snapshotId,
        recommendationIdempotencyKey: `${recommendation.id}:${Date.now()}`,
      });
      setLocalApplyStatus({
        status: result.status,
        appliedAt: result.appliedAt,
        appliedBy: result.appliedBy,
        reason: result.reason,
      });
      setShowApplyPreview(false);
      await onRefresh();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Failed to apply recommendation");
    } finally {
      setApplying(false);
    }
  }

  async function handleRevert() {
    setApplying(true);
    setActionError(null);
    try {
      const result = await revertInterventionPolicyRecommendation({
        recommendationId: recommendation.id,
        snapshotId: recommendation.snapshotId,
        recommendationIdempotencyKey: `${recommendation.id}:revert:${Date.now()}`,
      });
      setLocalApplyStatus({
        status:
          result.status === "reverted" || result.status === "revert_noop"
            ? "not_applied"
            : result.status,
        appliedAt: result.appliedAt,
        appliedBy: result.appliedBy,
        reason: result.reason,
      });
      await onRefresh();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Failed to undo recommendation");
    } finally {
      setApplying(false);
    }
  }

  function renderPolicyValue(value: Record<string, unknown>) {
    return Object.entries(value)
      .map(([key, current]) => `${key}: ${String(current)}`)
      .join(" · ");
  }

  const applyStatus = localApplyStatus;
  const diffRows = buildPolicyDiffRows(recommendation.proposedChange);
  const canApply =
    recommendation.applyEligibility.eligible &&
    recommendation.proposedChange &&
    applyStatus.status !== "applied" &&
    applyStatus.status !== "applied_noop";
  const canRevert =
    recommendation.applyEligibility.eligible &&
    (applyStatus.status === "applied" || applyStatus.status === "applied_noop");

  return (
    <article className="rounded-xl border border-border/80 bg-white px-4 py-4 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-[11px] uppercase tracking-widest text-muted-foreground">{recommendation.taxonomy}</div>
          <h3 className="mt-2 text-base font-semibold text-gray-900">{recommendation.title}</h3>
        </div>
        <div className="rounded-full border border-border bg-white px-2 py-1 text-[10px] font-semibold uppercase tracking-widest text-gray-700">
          {recommendation.confidence}
        </div>
      </div>

      <p className="mt-3 text-sm leading-6 text-gray-900">{recommendation.statement}</p>
      <p className="mt-2 text-sm leading-6 text-muted-foreground">{recommendation.whyNow}</p>

      <div className="mt-4 grid gap-3 xl:grid-cols-2">
        <div className="rounded-lg border border-border/70 bg-muted/20 px-3 py-3">
          <div className="text-[11px] uppercase tracking-widest text-muted-foreground">Expected impact</div>
          <div className="mt-2 text-sm leading-6 text-gray-900">{recommendation.expectedImpact}</div>
        </div>
        <div className="rounded-lg border border-border/70 bg-muted/20 px-3 py-3">
          <div className="text-[11px] uppercase tracking-widest text-muted-foreground">Suggested action</div>
          <div className="mt-2 text-sm leading-6 text-gray-900">{recommendation.suggestedAction}</div>
        </div>
      </div>

      <div className="mt-4 space-y-2">
        <div className="text-[11px] uppercase tracking-widest text-muted-foreground">Evidence</div>
        <ul className="space-y-2 text-sm leading-6 text-muted-foreground">
          {recommendation.evidence.map((item) => (
            <li key={`${recommendation.id}:${item.metricKey}`}>
              <span className="font-medium text-gray-900">{item.label}</span>
              <span>
                {" "}
                {item.currentValue ?? "n/a"}
                {item.baselineValue == null ? "" : ` vs ${item.baselineValue}`}
                {item.delta == null ? "" : ` (${item.delta})`}
              </span>
            </li>
          ))}
        </ul>
      </div>

      {recommendation.counterSignal && (
        <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-3 text-sm leading-6 text-amber-900">
          {recommendation.counterSignal}
        </div>
      )}

      <div className="mt-4 flex flex-wrap gap-2">
        <Button variant="outline" onClick={() => setShowReviewDetails((value) => !value)}>
          Why this qualified
        </Button>
        {canApply ? (
          <Button onClick={() => setShowApplyPreview((value) => !value)} disabled={applying}>
            Apply change
          </Button>
        ) : canRevert ? (
          <Button variant="outline" onClick={() => void handleRevert()} disabled={applying}>
            Undo change
          </Button>
        ) : (
          <div className="rounded-lg border border-border/70 bg-muted/20 px-3 py-2 text-sm text-muted-foreground">
            {recommendation.applyEligibility.message}
          </div>
        )}
      </div>
      {diffRows.length ? (
        <div className="mt-3 text-sm text-muted-foreground">
          {diffRows.length} policy value{diffRows.length === 1 ? "" : "s"} would change.
        </div>
      ) : null}

      {showReviewDetails && (
        <div className="mt-4 rounded-lg border border-border/70 bg-muted/20 px-3 py-3 text-sm leading-6 text-gray-900">
          <div className="font-medium text-gray-900">{recommendation.reviewDetails.primaryTrigger}</div>
          <div className="mt-2 text-muted-foreground">{recommendation.reviewDetails.thresholdSummary}</div>
          <div className="mt-2 text-muted-foreground">{recommendation.reviewDetails.rankingSummary}</div>
          <div className="mt-2 text-muted-foreground">
            Score {recommendation.reviewDetails.score} · Impact {recommendation.reviewDetails.impactScore} · Volume{" "}
            {recommendation.reviewDetails.volumeScore} · Persistence {recommendation.reviewDetails.persistenceScore} ·
            Actionability {recommendation.reviewDetails.actionabilityScore}
          </div>
        </div>
      )}

      {showApplyPreview && recommendation.proposedChange && (
        <div className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-3 text-sm leading-6 text-emerald-950">
          <div className="font-medium">Apply preview</div>
          <div className="mt-2">Target policy surface: {recommendation.proposedChange.policyLabel}</div>
          <div className="mt-3 rounded-lg border border-emerald-200/80 bg-white/70 px-3 py-3">
            <div className="text-[11px] uppercase tracking-widest text-emerald-900/70">Before / after policy diff</div>
            {diffRows.length ? (
              <div className="mt-3 space-y-2">
                {diffRows.map((row) => (
                  <div key={row.label} className="grid gap-2 rounded-md border border-emerald-200/70 px-3 py-2 md:grid-cols-[1.2fr_1fr_1fr]">
                    <div className="font-medium">{row.label}</div>
                    <div>
                      <div className="text-[10px] uppercase tracking-widest text-emerald-900/60">Before</div>
                      <div>{row.before}</div>
                    </div>
                    <div>
                      <div className="text-[10px] uppercase tracking-widest text-emerald-900/60">After</div>
                      <div>{row.after}</div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="mt-2 text-emerald-900/80">No policy value change is required.</div>
            )}
          </div>
          <div className="mt-2 text-emerald-900/80">
            Current value: {renderPolicyValue(recommendation.proposedChange.currentValue as Record<string, unknown>)}
          </div>
          <div className="mt-2 text-emerald-900/80">
            Proposed value: {renderPolicyValue(recommendation.proposedChange.proposedValue as Record<string, unknown>)}
          </div>
          <div className="mt-2 text-emerald-900/80">{recommendation.expectedImpact}</div>
          <div className="mt-3">
            <Button onClick={() => void handleApply()} disabled={applying}>
              Confirm apply
            </Button>
          </div>
        </div>
      )}

      {applyStatus.status !== "not_applied" && (
        <div className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-3 text-sm leading-6 text-emerald-900">
          {applyStatus.status === "applied" || applyStatus.status === "applied_noop"
            ? `Applied by ${applyStatus.appliedBy ?? "unknown"}${applyStatus.appliedAt ? ` at ${applyStatus.appliedAt}` : ""}.`
            : applyStatus.reason ?? "Apply attempt was rejected."}
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>{formatFreshnessLabel(recommendation.generatedAt)}</span>
        <span>
          Helpful {recommendation.feedbackSummary.helpfulCount} · Not useful {recommendation.feedbackSummary.notUsefulCount}
          {" "}· Wrong direction {recommendation.feedbackSummary.wrongDirectionCount}
        </span>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <Button variant={feedbackValue === "helpful" ? "default" : "outline"} disabled={submitting || applying} onClick={() => void handleFeedback("helpful")}>
          Helpful
        </Button>
        <Button
          variant={feedbackValue === "not_useful" ? "default" : "outline"}
          disabled={submitting || applying}
          onClick={() => void handleFeedback("not_useful")}
        >
          Not Useful
        </Button>
        <Button
          variant={feedbackValue === "wrong_direction" ? "default" : "outline"}
          disabled={submitting || applying}
          onClick={() => void handleFeedback("wrong_direction")}
        >
          Wrong Direction
        </Button>
      </div>
      {actionError && (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-3 text-sm leading-6 text-red-700">
          {actionError}
        </div>
      )}
      <label className="mt-4 block text-sm text-muted-foreground">
        <span className="sr-only">Optional comment</span>
        <input
          value={comment}
          onChange={(event) => setComment(event.target.value)}
          placeholder="Optional comment"
          className="w-full rounded-lg border border-border bg-white px-3 py-2 text-sm text-gray-900"
        />
      </label>
    </article>
  );
}

export function InterventionPolicyRecommendationsSection({
  view,
  onRefresh,
  loading,
  error,
  defaultShowReview = false,
}: {
  view: InterventionPolicyRecommendationsView | null;
  onRefresh: () => Promise<void> | void;
  loading?: boolean;
  error?: string | null;
  defaultShowReview?: boolean;
}) {
  const [regenerating, setRegenerating] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [showReview, setShowReview] = useState(defaultShowReview);
  const [reviewWindow, setReviewWindow] = useState<InterventionPolicyRecommendationReviewWindow>("last_30_days");
  const [reviewDecision, setReviewDecision] = useState<InterventionPolicyRecommendationReviewDecisionFilter>("all");
  const [reviewRefreshKey, setReviewRefreshKey] = useState(0);
  const [openSections, setOpenSections] = useState<Record<ReviewSectionKey, boolean>>({
    ...defaultReviewSections,
    overview: defaultShowReview,
  });
  const review = useInterventionPolicyRecommendationReview({
    window: reviewWindow,
    decision: reviewDecision,
    refreshKey: reviewRefreshKey,
  });

  async function handleRegenerate() {
    setRegenerating(true);
    setActionError(null);
    try {
      await regeneratePolicyRecommendationState({
        regenerate: regenerateInterventionPolicyRecommendations,
        refreshView: async () => {
          await onRefresh();
        },
        refreshReview: async () => {
          setReviewRefreshKey((value) => value + 1);
        },
      });
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Failed to refresh recommendations");
    } finally {
      setRegenerating(false);
    }
  }

  function handleReviewToggle() {
    setShowReview((value) => {
      const next = !value;
      if (next) {
        setOpenSections(defaultReviewSections);
      }
      return next;
    });
  }

  function toggleSection(section: ReviewSectionKey) {
    setOpenSections((current) => ({
      ...current,
      [section]: !current[section],
    }));
  }

  const overview = buildOverviewItems(review.data);

  function renderSection(
    key: ReviewSectionKey,
    title: string,
    content: ReactNode
  ) {
    const isOpen = openSections[key];
    return (
      <div className="rounded-lg border border-border/70 bg-white">
        <button
          type="button"
          className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
          onClick={() => toggleSection(key)}
        >
          <div className="text-sm font-semibold text-gray-900">{title}</div>
          <div className="text-[11px] uppercase tracking-widest text-muted-foreground">{isOpen ? "open" : "closed"}</div>
        </button>
        {!isOpen ? null : <div className="border-t border-border/70 px-4 py-4">{content}</div>}
      </div>
    );
  }

  const reviewControls = (
    <div className="rounded-lg border border-border/70 bg-muted/20 px-4 py-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-sm font-semibold text-gray-900">Recommendation review</div>
          <div className="mt-1 text-xs text-muted-foreground">{getAttentionSummary(review.data)}</div>
        </div>
        <Button variant="outline" onClick={handleReviewToggle}>
          Review recommendation quality
        </Button>
      </div>
      {!showReview ? null : (
        <div className="mt-4 rounded-xl border border-border/70 bg-white px-4 py-4 shadow-sm">
          {regenerating ? <div className="mb-4 text-sm text-muted-foreground">Refreshing recommendation review...</div> : null}
          <div className="space-y-4">
          {renderSection(
            "overview",
            "Overview",
            <div className="space-y-4 text-sm leading-6 text-muted-foreground">
              <div className="space-y-3">
                <div>
                  <div className="text-[11px] uppercase tracking-widest text-muted-foreground">What needs attention now</div>
                  <div className="mt-1 text-sm leading-6 text-gray-900">{overview.attention.replace(/^What needs attention now:\s*/i, "")}</div>
                </div>
                <div>
                  <div className="text-[11px] uppercase tracking-widest text-muted-foreground">Next safe action</div>
                  <div className="mt-1 text-sm leading-6 text-gray-900">{overview.nextAction.replace(/^Next safe action:\s*/i, "")}</div>
                </div>
                <div>
                  <div className="text-[11px] uppercase tracking-widest text-muted-foreground">Calibration status</div>
                  <div className="mt-1 text-sm leading-6 text-gray-900">{overview.calibration.replace(/^Calibration status:\s*/i, "")}</div>
                </div>
                <div className="text-sm text-muted-foreground">{overview.context}</div>
              </div>
              <div className="rounded-lg border border-border/70 bg-muted/20 px-3 py-3">
                <div className="text-[11px] uppercase tracking-widest text-muted-foreground">Review scope</div>
                <div className="mt-2 text-sm text-gray-900">
                  Showing {formatDecisionFilterLabel(reviewDecision).toLowerCase()} across {humanizeReviewWindow(reviewWindow)}.
                </div>
              </div>
              <div className="flex flex-wrap gap-2 pt-1">
                {([
                  ["7d", "last_7_days"],
                  ["30d", "last_30_days"],
                  ["90d", "last_90_days"],
                ] as const).map(([label, value]) => (
                  <Button key={value} variant={reviewWindow === value ? "default" : "outline"} onClick={() => setReviewWindow(value)}>
                    {label}
                  </Button>
                ))}
              </div>
              <div className="flex flex-wrap gap-2">
                {(["all", "rendered", "suppressed"] as const).map((value) => (
                  <Button key={value} variant={reviewDecision === value ? "default" : "outline"} onClick={() => setReviewDecision(value)}>
                    {formatDecisionFilterLabel(value)}
                  </Button>
                ))}
              </div>
            </div>
          )}
          {renderSection(
            "history",
            "History",
            !review.data && review.loading ? (
              <div className="text-sm text-muted-foreground">Loading recommendation history...</div>
            ) : review.error ? (
              <div className="text-sm text-red-700">{review.error}</div>
            ) : review.data?.recentHistory.length ? (
              <div className="space-y-2">
                {review.data.recentHistory.map((entry) => (
                  <div
                    key={`${entry.recommendationId}:${entry.eventType}:${entry.occurredAt}`}
                    className="rounded-md border border-border/60 px-3 py-2 text-sm"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="font-medium text-gray-900">{entry.title}</div>
                      <div className="text-xs uppercase tracking-widest text-muted-foreground">
                        {formatHistoryEventLabel(entry.eventType)}
                      </div>
                    </div>
                    <div className="mt-1 text-muted-foreground">
                      {entry.taxonomy}
                      {entry.actorName ? ` · ${entry.actorName}` : ""}
                      {entry.occurredAt ? ` · ${formatOccurredAtLabel(entry.occurredAt)}` : ""}
                    </div>
                    <div className="mt-1 text-muted-foreground">{entry.summary}</div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-sm text-muted-foreground">No recommendation decision history is available right now.</div>
            )
          )}
          {renderSection(
            "diagnostics",
            "Diagnostics",
              <div className="space-y-4">
              <div className="rounded-md border border-border/60 px-3 py-3">
                <div className="text-xs text-muted-foreground">Latest snapshot truth for the active recommendation snapshot.</div>
                <div className="mt-3 space-y-2">
                  {!review.data && review.loading ? (
                    <div className="text-sm text-muted-foreground">Loading recommendation diagnostics...</div>
                  ) : review.error ? (
                    <div className="text-sm text-red-700">{review.error}</div>
                  ) : review.data?.latestDecisionRows.length ? (
                    review.data.latestDecisionRows.map((row) => (
                      <div key={`${row.taxonomy}:${row.groupingKey}:${row.decision}`} className="rounded-md border border-border/60 px-3 py-2 text-sm">
                        <div className="font-medium text-gray-900">{row.taxonomy}</div>
                        <div className="text-muted-foreground">
                          {row.groupingKey} · {row.decision}
                          {row.score == null ? "" : ` · score ${row.score}`}
                        </div>
                      </div>
                    ))
                  ) : (
                    <div className="text-sm text-muted-foreground">No diagnostics are available yet.</div>
                  )}
                </div>
              </div>
              <div className="rounded-md border border-border/60 px-3 py-3">
                <div className="text-xs text-muted-foreground">
                  Historical diagnostics generated {formatFreshnessLabel(review.data?.diagnostics.generatedAt ?? null)}.
                </div>
                <div className="mt-2 text-sm text-gray-900">
                  Next safe action: {formatDiagnosticActionLabel(review.data?.diagnostics.systemDiagnostics.recommendedNextAction ?? "hold_current_thresholds")}
                </div>
                <div className="mt-3 space-y-2">
                  {review.data?.diagnostics.systemDiagnostics.dominantBlockers.length ? (
                    review.data.diagnostics.systemDiagnostics.dominantBlockers.map((entry) => (
                      <div key={entry.blocker} className="rounded-md border border-border/60 px-3 py-2 text-sm text-muted-foreground">
                        {formatDiagnosticBlockerLabel(entry.blocker)} · {entry.count}
                      </div>
                    ))
                  ) : (
                    <div className="text-sm text-muted-foreground">No qualification diagnostics are available right now.</div>
                  )}
                </div>
              </div>
            </div>
          )}
          {renderSection(
            "calibration",
            "Calibration",
            <div className="space-y-4">
              <div className="rounded-md border border-border/60 px-3 py-3">
                <div className="text-xs text-muted-foreground">
                  Read-only production guidance. Threshold proposals stay informational until a later code change lands.
                </div>
                <div className="mt-2 text-sm text-gray-900">
                  {review.data?.thresholdCalibrationProposals.selectionSummary ?? "No threshold changes are currently recommended."}
                </div>
              </div>
              {review.data?.tuning.guidance.length ? (
                <div className="space-y-2">
                  {review.data.tuning.guidance.map((entry) => (
                    <div key={entry.taxonomy} className="rounded-md border border-border/60 px-3 py-2 text-sm">
                      <div className="font-medium text-gray-900">{entry.taxonomy}</div>
                      <div className="text-muted-foreground">{humanizeAction(entry.recommendedAction)}</div>
                      <div className="mt-1 text-muted-foreground">{entry.summary}</div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-sm text-muted-foreground">No calibration changes are currently recommended.</div>
              )}
              <div className="space-y-3">
                {review.data?.thresholdCalibrationProposals.proposals.length ? (
                  review.data.thresholdCalibrationProposals.proposals.map((proposal) => (
                    <div key={proposal.taxonomy} className="rounded-md border border-border/60 px-3 py-3 text-sm">
                      <div className="font-medium text-gray-900">{proposal.taxonomy}</div>
                      <div className="mt-2 text-muted-foreground">{proposal.rationale}</div>
                      <div className="mt-2 text-muted-foreground">{proposal.expectedYieldEffect}</div>
                      <div className="mt-3 grid gap-3 md:grid-cols-2">
                        <div className="rounded-md border border-border/50 px-3 py-2">
                          <div className="text-[10px] uppercase tracking-widest text-muted-foreground">Current threshold</div>
                          <div className="mt-1 text-gray-900">{proposal.currentThreshold}</div>
                        </div>
                        <div className="rounded-md border border-border/50 px-3 py-2">
                          <div className="text-[10px] uppercase tracking-widest text-muted-foreground">Proposed threshold</div>
                          <div className="mt-1 text-gray-900">{proposal.proposedThreshold}</div>
                        </div>
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="text-sm text-muted-foreground">
                    {formatThresholdCalibrationNoProposalReason(review.data?.thresholdCalibrationProposals.noProposalReason)}
                  </div>
                )}
              </div>
            </div>
          )}
          {renderSection(
            "seededValidation",
            "Seeded validation",
            review.data?.diagnostics.seededValidationStatus.taxonomies.length ? (
              <div className="space-y-2">
                <div className="text-xs text-muted-foreground">
                  Non-production validation only · {review.data?.diagnostics.seededValidationStatus.scriptPath ?? "Seed script unavailable"}
                </div>
                {review.data.diagnostics.seededValidationStatus.taxonomies.map((entry) => (
                  <div key={entry.taxonomy} className="rounded-md border border-border/60 px-3 py-2 text-sm">
                    <div className="font-medium text-gray-900">{entry.taxonomy}</div>
                    <div className="text-muted-foreground">
                      {entry.seedPathAvailable
                        ? `Seed key ${entry.seedKey} · ${entry.supportsApplyUndo ? "apply/undo verification available" : "review-only verification"}`
                        : "No non-production seed recipe is configured yet."}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-sm text-muted-foreground">No seeded validation guidance is available right now.</div>
            )
          )}
          </div>
        </div>
      )}
    </div>
  );

  if (loading && !view) {
    return (
      <div className="rounded-lg border border-dashed border-border bg-muted/30 px-4 py-4 text-sm leading-6 text-muted-foreground">
        Loading policy recommendations...
      </div>
    );
  }

  if (error && !view) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-4 text-sm leading-6 text-red-700">
        {error}
      </div>
    );
  }

  if (!view || view.status === "missing_snapshot") {
    return (
      <div className="space-y-4">
        {reviewControls}
        <div className="rounded-lg border border-dashed border-border bg-muted/30 px-4 py-4 text-sm leading-6 text-muted-foreground">
          No policy recommendation snapshot is available yet.
        </div>
        <Button variant="outline" disabled={regenerating} onClick={() => void handleRegenerate()}>
          Generate Recommendations
        </Button>
      </div>
    );
  }

  if (view.recommendations.length === 0) {
    return (
      <div className="space-y-4">
        {reviewControls}
        <Button variant="outline" disabled={regenerating} onClick={() => void handleRegenerate()}>
          Refresh Recommendations
        </Button>
        <div className="rounded-lg border border-dashed border-border bg-muted/30 px-4 py-4 text-sm leading-6 text-muted-foreground">
          No policy changes are recommended right now.
        </div>
        {review.data?.emptyStateReason ? (
          <div className="rounded-lg border border-border/70 bg-white px-4 py-4 text-sm leading-6 text-muted-foreground">
            {review.data.emptyStateReason}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {error && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-4 text-sm leading-6 text-amber-900">
          {error}
        </div>
      )}
      {actionError && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-4 text-sm leading-6 text-red-700">
          {actionError}
        </div>
      )}
      {view.status === "degraded" && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-4 text-sm leading-6 text-amber-900">
          Recommendations are available, but at least one card is using fallback copy from the latest generation run.
        </div>
      )}
      {reviewControls}
      <Button variant="outline" disabled={regenerating} onClick={() => void handleRegenerate()}>
        Refresh Recommendations
      </Button>
      {view.recommendations.map((recommendation) => (
        <PolicyRecommendationCard key={recommendation.id} recommendation={recommendation} onRefresh={onRefresh} />
      ))}
    </div>
  );
}
