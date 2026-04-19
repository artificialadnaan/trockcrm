import { Link } from "react-router-dom";
import { AlertTriangle, RefreshCcw, Sparkles, ThumbsDown, ThumbsUp } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useInterventionCopilot } from "@/hooks/use-ai-copilot";

function formatConfidence(value: number | null) {
  if (value === null) return null;
  if (Number.isNaN(value)) return null;
  return `${Math.round(value * 100)}% confidence`;
}

function formatDate(value: string | null) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString();
}

function formatActionLabel(value: string) {
  return value.replace(/_/g, " ").replace(/\b\w/g, (match) => match.toUpperCase());
}

function severityClassName(severity: string) {
  if (severity === "critical") return "border-red-200 bg-red-50 text-red-700";
  if (severity === "high") return "border-orange-200 bg-orange-50 text-orange-700";
  if (severity === "medium") return "border-amber-200 bg-amber-50 text-amber-700";
  return "border-slate-200 bg-slate-50 text-slate-700";
}

export function InterventionCaseCopilotPanel(props: { caseId: string | null }) {
  const { data, loading, error, regenerating, refreshQueuedAt, submittingFeedback, refetch, regenerate, submitFeedback } =
    useInterventionCopilot(props.caseId);

  const confidenceLabel = formatConfidence(data?.packet?.confidence ?? null);
  const generatedAtLabel = formatDate(data?.packetGeneratedAt ?? null);
  const isRefreshPending = Boolean(refreshQueuedAt || data?.isRefreshPending);

  async function handleRegenerate() {
    try {
      await regenerate();
      toast.success("Case copilot refreshed");
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to regenerate case copilot");
    }
  }

  async function handleFeedback(feedbackValue: "positive" | "negative") {
    if (!data?.packet?.id) return;
    try {
      await submitFeedback({
        targetType: "packet",
        targetId: data.packet.id,
        feedbackType: "intervention_case_copilot",
        feedbackValue,
      });
      toast.success("Feedback saved");
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to save copilot feedback");
    }
  }

  if (!props.caseId) return null;

  if (loading) {
    return (
      <div className="rounded-lg border border-border/80 bg-white p-4 space-y-3">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <Sparkles className="h-4 w-4" />
          Case Copilot
        </div>
        <div className="h-4 rounded bg-muted animate-pulse" />
        <div className="h-4 w-4/5 rounded bg-muted animate-pulse" />
        <div className="h-20 rounded bg-muted animate-pulse" />
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 p-4 space-y-3">
        <div className="flex items-center gap-2 text-sm font-semibold text-red-700">
          <AlertTriangle className="h-4 w-4" />
          Case Copilot
        </div>
        <div className="text-sm text-red-700">{error}</div>
        <Button size="sm" variant="outline" onClick={() => void refetch()}>
          Retry
        </Button>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border/80 bg-white p-4 space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <Sparkles className="h-4 w-4" />
            Case Copilot
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {confidenceLabel && <Badge variant="outline">{confidenceLabel}</Badge>}
            {generatedAtLabel && <span className="text-xs text-muted-foreground">Updated {generatedAtLabel}</span>}
            {data?.isStale && (
              <Badge variant="outline" className="border-amber-200 bg-amber-50 text-amber-700">
                Stale context
              </Badge>
            )}
            {isRefreshPending && (
              <Badge variant="outline" className="border-amber-200 bg-amber-50 text-amber-700">
                Refresh pending
              </Badge>
            )}
          </div>
        </div>
        <Button size="sm" variant="outline" disabled={regenerating} onClick={() => void handleRegenerate()}>
          <RefreshCcw className="h-3.5 w-3.5 mr-2" />
          {regenerating ? "Refreshing..." : data?.packet?.id ? "Refresh" : "Generate"}
        </Button>
      </div>

      {isRefreshPending && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-3 text-sm text-amber-800">
          A fresh case copilot packet is being generated. You are still viewing the latest completed result.
        </div>
      )}

      {error && data && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">{error}</div>
      )}

      {data?.packet?.summaryText ? (
        <div className="space-y-2">
          <div className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">Case Brief</div>
          <div className="text-sm leading-6">{data.packet.summaryText}</div>
        </div>
      ) : (
        <div className="rounded-lg border border-dashed border-border px-3 py-4 text-sm text-muted-foreground">
          No copilot packet has been generated for this case yet.
        </div>
      )}

      {data?.recommendedAction && (
        <div className="rounded-lg border border-brand-red/10 bg-brand-red/[0.04] px-3 py-3 space-y-2">
          <div className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">Recommended Action</div>
          <div className="text-sm font-medium">{formatActionLabel(data.recommendedAction.action)}</div>
          {data.recommendedAction.rationale && <div className="text-sm text-muted-foreground">{data.recommendedAction.rationale}</div>}
          {(data.recommendedAction.suggestedOwner || data.recommendedAction.suggestedOwnerId) && (
            <div className="text-xs text-muted-foreground">
              Suggested owner: {data.recommendedAction.suggestedOwner ?? data.recommendedAction.suggestedOwnerId}
            </div>
          )}
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-lg border border-border/70 p-3 space-y-1">
          <div className="text-xs uppercase tracking-widest text-muted-foreground">Root Cause</div>
          <div className="text-sm font-medium">{data?.rootCause?.label ?? "Not available"}</div>
          {data?.rootCause?.explanation && <div className="text-xs text-muted-foreground">{data.rootCause.explanation}</div>}
        </div>
        <div className="rounded-lg border border-border/70 p-3 space-y-1">
          <div className="text-xs uppercase tracking-widest text-muted-foreground">Blocker Owner</div>
          <div className="text-sm font-medium">{data?.blockerOwner?.name ?? data?.blockerOwner?.id ?? "Not available"}</div>
        </div>
        <div className="rounded-lg border border-border/70 p-3 space-y-1">
          <div className="text-xs uppercase tracking-widest text-muted-foreground">Reopen Risk</div>
          <div className="text-sm font-medium">{data?.reopenRisk ? formatActionLabel(data.reopenRisk.level) : "Unknown"}</div>
          {data?.reopenRisk?.rationale && <div className="text-xs text-muted-foreground">{data.reopenRisk.rationale}</div>}
        </div>
      </div>

      <div className="space-y-2">
        <div className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">Risk Flags</div>
        {data?.riskFlags?.length ? (
          <div className="flex flex-wrap gap-2">
            {data.riskFlags.map((flag) => (
              <Badge key={`${flag.flagType}-${flag.title}`} variant="outline" className={severityClassName(flag.severity)}>
                {flag.title}
              </Badge>
            ))}
          </div>
        ) : (
          <div className="text-sm text-muted-foreground">No active risk flags.</div>
        )}
      </div>

      <div className="space-y-2">
        <div className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">Similar Historical Cases</div>
        {data?.similarCases?.length ? (
          <div className="space-y-2">
            {data.similarCases.slice(0, 3).map((item) => (
              <div key={item.caseId} className="rounded-lg border border-border/70 px-3 py-3 text-sm space-y-1">
                <div className="flex items-center justify-between gap-2">
                  <div className="font-medium">{item.businessKey}</div>
                  <Link to={item.queueLink} className="text-xs text-brand-red hover:underline">
                    Open similar cases
                  </Link>
                </div>
                <div className="text-muted-foreground">
                  {formatActionLabel(item.conclusionKind)}
                  {item.reasonCode ? ` · ${formatActionLabel(item.reasonCode)}` : ""}
                  {item.reopened ? " · Reopened" : item.durableClose ? " · Durable close" : ""}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="text-sm text-muted-foreground">No similar historical cases were found yet.</div>
        )}
      </div>

      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant={data?.viewerFeedbackValue === "positive" ? "default" : "outline"}
          disabled={submittingFeedback || !data?.packet?.id}
          onClick={() => void handleFeedback("positive")}
        >
          <ThumbsUp className="h-3.5 w-3.5 mr-2" />
          Helpful
        </Button>
        <Button
          size="sm"
          variant={data?.viewerFeedbackValue === "negative" ? "default" : "outline"}
          disabled={submittingFeedback || !data?.packet?.id}
          onClick={() => void handleFeedback("negative")}
        >
          <ThumbsDown className="h-3.5 w-3.5 mr-2" />
          Not helpful
        </Button>
      </div>
    </div>
  );
}
