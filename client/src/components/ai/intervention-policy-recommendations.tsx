import { useState } from "react";
import {
  applyInterventionPolicyRecommendation,
  regenerateInterventionPolicyRecommendations,
  submitInterventionPolicyRecommendationFeedback,
  type InterventionPolicyRecommendation,
  type InterventionPolicyRecommendationReviewDecisionFilter,
  type InterventionPolicyRecommendationReviewWindow,
  type InterventionPolicyRecommendationsView,
  useInterventionPolicyRecommendationReview,
} from "@/hooks/use-ai-ops";
import { Button } from "@/components/ui/button";

function formatFreshnessLabel(value: string | null | undefined) {
  if (!value) return "Unknown freshness";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown freshness";
  return `Generated ${date.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`;
}

function formatHistoryEventLabel(value: string) {
  if (value === "applied_noop") return "Applied no-op";
  return value.split("_").join(" ");
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

  function renderPolicyValue(value: Record<string, unknown>) {
    return Object.entries(value)
      .map(([key, current]) => `${key}: ${String(current)}`)
      .join(" · ");
  }

  const applyStatus = localApplyStatus;
  const canApply =
    recommendation.applyEligibility.eligible &&
    recommendation.proposedChange &&
    applyStatus.status !== "applied" &&
    applyStatus.status !== "applied_noop";

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
        ) : (
          <div className="rounded-lg border border-border/70 bg-muted/20 px-3 py-2 text-sm text-muted-foreground">
            Not yet apply-eligible
          </div>
        )}
      </div>

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
          <div className="mt-2">Current value: {renderPolicyValue(recommendation.proposedChange.currentValue as Record<string, unknown>)}</div>
          <div className="mt-2">
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
}: {
  view: InterventionPolicyRecommendationsView | null;
  onRefresh: () => Promise<void> | void;
  loading?: boolean;
  error?: string | null;
}) {
  const [regenerating, setRegenerating] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [showReview, setShowReview] = useState(false);
  const [reviewWindow, setReviewWindow] = useState<InterventionPolicyRecommendationReviewWindow>("last_30_days");
  const [reviewDecision, setReviewDecision] = useState<InterventionPolicyRecommendationReviewDecisionFilter>("all");
  const review = useInterventionPolicyRecommendationReview({
    window: reviewWindow,
    decision: reviewDecision,
  });

  async function handleRegenerate() {
    setRegenerating(true);
    setActionError(null);
    try {
      await regenerateInterventionPolicyRecommendations();
      await onRefresh();
      for (const delayMs of [800, 1200, 1600, 2200, 3000, 4000, 5000]) {
        await new Promise((resolve) => window.setTimeout(resolve, delayMs));
        await onRefresh();
      }
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Failed to refresh recommendations");
    } finally {
      setRegenerating(false);
    }
  }

  const reviewControls = (
    <div className="rounded-lg border border-border/70 bg-muted/20 px-4 py-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-sm font-semibold text-gray-900">Recommendation review</div>
          <div className="mt-1 text-xs text-muted-foreground">
            Recent history: {review.data?.recentHistory.length ?? 0} events
          </div>
        </div>
        <Button variant="outline" onClick={() => setShowReview((value) => !value)}>
          Review recommendation quality
        </Button>
      </div>
      {!showReview ? null : (
        <div className="mt-4 space-y-4">
          <div className="text-sm text-muted-foreground">
            Latest snapshot: {formatFreshnessLabel(review.data?.snapshot?.generatedAt ?? null)}
          </div>
          <div className="rounded-lg border border-border/70 bg-white px-3 py-3">
            <div className="text-[11px] uppercase tracking-widest text-muted-foreground">Historical window summary</div>
            <div className="mt-3 flex flex-wrap gap-2">
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
            <div className="mt-4 grid gap-2 text-sm text-gray-900 md:grid-cols-2 xl:grid-cols-3">
              <div>Rendered: {review.data?.summary.totals.qualifiedRendered ?? 0}</div>
              <div>Suppressed by predicate: {review.data?.summary.totals.suppressedByPredicate ?? 0}</div>
              <div>Suppressed by threshold: {review.data?.summary.totals.suppressedByThreshold ?? 0}</div>
              <div>Suppressed by cap: {review.data?.summary.totals.qualifiedSuppressedByCap ?? 0}</div>
              <div>Suppressed by missing target: {review.data?.summary.totals.suppressedByMissingTarget ?? 0}</div>
              <div>Suppressed by apply ineligible: {review.data?.summary.totals.suppressedByApplyIneligible ?? 0}</div>
            </div>
          </div>
          <div className="rounded-lg border border-border/70 bg-white px-3 py-3">
            <div className="text-[11px] uppercase tracking-widest text-muted-foreground">Latest decision diagnostics</div>
            <div className="mt-3 flex flex-wrap gap-2">
              {(["all", "rendered", "suppressed"] as const).map((value) => (
                <Button key={value} variant={reviewDecision === value ? "default" : "outline"} onClick={() => setReviewDecision(value)}>
                  {value}
                </Button>
              ))}
            </div>
            <div className="mt-3 space-y-2">
              {review.loading ? (
                <div className="text-sm text-muted-foreground">Loading recommendation review...</div>
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
          <div className="rounded-lg border border-border/70 bg-white px-3 py-3">
            <div className="text-[11px] uppercase tracking-widest text-muted-foreground">Recent recommendation history</div>
            <div className="mt-3 space-y-2">
              {review.loading ? (
                <div className="text-sm text-muted-foreground">Loading recommendation history...</div>
              ) : review.error ? (
                <div className="text-sm text-red-700">{review.error}</div>
              ) : review.data?.recentHistory.length ? (
                review.data.recentHistory.map((entry) => (
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
                      {entry.occurredAt ? ` · ${formatFreshnessLabel(entry.occurredAt)}` : ""}
                    </div>
                    <div className="mt-1 text-muted-foreground">{entry.summary}</div>
                  </div>
                ))
              ) : (
                <div className="text-sm text-muted-foreground">No recommendation history is available yet.</div>
              )}
            </div>
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
