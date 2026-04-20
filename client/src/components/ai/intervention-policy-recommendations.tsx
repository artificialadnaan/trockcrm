import { useState } from "react";
import {
  regenerateInterventionPolicyRecommendations,
  submitInterventionPolicyRecommendationFeedback,
  type InterventionPolicyRecommendation,
  type InterventionPolicyRecommendationsView,
} from "@/hooks/use-ai-ops";
import { Button } from "@/components/ui/button";

function formatFreshnessLabel(value: string | null | undefined) {
  if (!value) return "Unknown freshness";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown freshness";
  return `Generated ${date.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`;
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

      <div className="mt-4 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>{formatFreshnessLabel(recommendation.generatedAt)}</span>
        <span>
          Helpful {recommendation.feedbackSummary.helpfulCount} · Not useful {recommendation.feedbackSummary.notUsefulCount}
          {" "}· Wrong direction {recommendation.feedbackSummary.wrongDirectionCount}
        </span>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <Button variant={feedbackValue === "helpful" ? "default" : "outline"} disabled={submitting} onClick={() => void handleFeedback("helpful")}>
          Helpful
        </Button>
        <Button
          variant={feedbackValue === "not_useful" ? "default" : "outline"}
          disabled={submitting}
          onClick={() => void handleFeedback("not_useful")}
        >
          Not Useful
        </Button>
        <Button
          variant={feedbackValue === "wrong_direction" ? "default" : "outline"}
          disabled={submitting}
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
        <Button variant="outline" disabled={regenerating} onClick={() => void handleRegenerate()}>
          Refresh Recommendations
        </Button>
        <div className="rounded-lg border border-dashed border-border bg-muted/30 px-4 py-4 text-sm leading-6 text-muted-foreground">
          No policy changes are recommended right now.
        </div>
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
      <Button variant="outline" disabled={regenerating} onClick={() => void handleRegenerate()}>
        Refresh Recommendations
      </Button>
      {view.recommendations.map((recommendation) => (
        <PolicyRecommendationCard key={recommendation.id} recommendation={recommendation} onRefresh={onRefresh} />
      ))}
    </div>
  );
}
