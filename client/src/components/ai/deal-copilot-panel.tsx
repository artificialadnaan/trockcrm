import { toast } from "sonner";
import {
  AlertTriangle,
  CheckSquare2,
  RefreshCcw,
  Sparkles,
  ThumbsDown,
  ThumbsUp,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { BlindSpotCard } from "@/components/ai/blind-spot-card";
import { SuggestedTaskCard } from "@/components/ai/suggested-task-card";
import { useDealCopilot } from "@/hooks/use-ai-copilot";

interface DealCopilotPanelProps {
  dealId: string;
}

function formatConfidence(value: string | null) {
  if (!value) return null;
  const parsed = Number(value);
  if (Number.isNaN(parsed)) return null;
  return `${Math.round(parsed * 100)}% confidence`;
}

function formatGeneratedAt(value: string | null) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString();
}

export function DealCopilotPanel({ dealId }: DealCopilotPanelProps) {
  const {
    data,
    loading,
    error,
    regenerating,
    submittingFeedback,
    workingSuggestionId,
    refetch,
    regenerate,
    acceptSuggestion,
    dismissSuggestion,
    submitFeedback,
  } = useDealCopilot(dealId);

  const openSuggestions = (data?.suggestedTasks ?? []).filter(
    (suggestion) => suggestion.status === "suggested"
  );
  const openBlindSpots = (data?.blindSpotFlags ?? []).filter(
    (flag) => flag.status === "open"
  );
  const confidenceLabel = formatConfidence(data?.packet?.confidence ?? null);
  const generatedAtLabel = formatGeneratedAt(data?.packet?.generatedAt ?? null);
  const nextStep = openSuggestions[0] ?? null;

  const handleRegenerate = async () => {
    try {
      await regenerate();
      toast.success("Deal copilot refreshed");
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to regenerate deal copilot");
    }
  };

  const handleAccept = async (suggestionId: string) => {
    try {
      await acceptSuggestion(suggestionId);
      toast.success("Task created from AI suggestion");
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to accept task suggestion");
    }
  };

  const handleDismiss = async (suggestionId: string) => {
    try {
      await dismissSuggestion(suggestionId);
      toast.success("Task suggestion dismissed");
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to dismiss task suggestion");
    }
  };

  const handleFeedback = async (feedbackValue: string) => {
    if (!data?.packet) return;

    try {
      await submitFeedback({
        targetType: "packet",
        targetId: data.packet.id,
        feedbackType: "deal_copilot_panel",
        feedbackValue,
      });
      toast.success("Feedback saved");
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to save AI feedback");
    }
  };

  if (loading) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
            <Sparkles className="h-4 w-4" />
            AI Copilot
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="h-4 rounded bg-muted animate-pulse" />
          <div className="h-4 w-5/6 rounded bg-muted animate-pulse" />
          <div className="h-20 rounded bg-muted animate-pulse" />
        </CardContent>
      </Card>
    );
  }

  if (error && !data?.packet) {
    return (
      <Card className="border-red-200">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium text-red-700 flex items-center gap-2">
            <AlertTriangle className="h-4 w-4" />
            AI Copilot
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-red-700">{error}</p>
          <Button size="sm" variant="outline" onClick={() => void refetch()}>
            Retry
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="border-border/80">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <Sparkles className="h-4 w-4" />
              AI Copilot
            </CardTitle>
            <div className="flex flex-wrap items-center gap-2">
              {confidenceLabel && (
                <Badge variant="outline" className="bg-brand-red/5 text-brand-red border-brand-red/20">
                  {confidenceLabel}
                </Badge>
              )}
              {generatedAtLabel && (
                <span className="text-xs text-muted-foreground">Updated {generatedAtLabel}</span>
              )}
            </div>
          </div>
          <Button size="sm" variant="outline" disabled={regenerating} onClick={() => void handleRegenerate()}>
            <RefreshCcw className="h-3.5 w-3.5 mr-2" />
            {data?.packet ? "Refresh" : "Generate"}
          </Button>
        </div>
      </CardHeader>

      <CardContent className="space-y-5">
        {data?.packet?.summaryText ? (
          <div className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
              Deal Brief
            </p>
            <p className="text-sm leading-6">{data.packet.summaryText}</p>
          </div>
        ) : (
          <div className="rounded-lg border border-dashed border-border px-3 py-4 text-sm text-muted-foreground">
            No AI packet has been generated for this deal yet.
          </div>
        )}

        <div className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
            Immediate Next Step
          </p>
          {nextStep ? (
            <div className="rounded-lg bg-brand-red/[0.04] border border-brand-red/10 px-3 py-3">
              <div className="flex items-start gap-3">
                <CheckSquare2 className="mt-0.5 h-4 w-4 text-brand-red" />
                <div className="space-y-1">
                  <p className="text-sm font-medium">{nextStep.title}</p>
                  {nextStep.description && (
                    <p className="text-sm text-muted-foreground leading-5">{nextStep.description}</p>
                  )}
                </div>
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              No immediate next step is available yet.
            </p>
          )}
        </div>

        <div className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
              Suggested Tasks
            </p>
            <Badge variant="secondary">{openSuggestions.length}</Badge>
          </div>
          {openSuggestions.length > 0 ? (
            <div className="space-y-3">
              {openSuggestions.map((suggestion) => (
                <SuggestedTaskCard
                  key={suggestion.id}
                  suggestion={suggestion}
                  busy={workingSuggestionId === suggestion.id}
                  onAccept={() => handleAccept(suggestion.id)}
                  onDismiss={() => handleDismiss(suggestion.id)}
                />
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              No active task suggestions right now.
            </p>
          )}
        </div>

        <div className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
              Blind Spots
            </p>
            <Badge variant="secondary">{openBlindSpots.length}</Badge>
          </div>
          {openBlindSpots.length > 0 ? (
            <div className="space-y-3">
              {openBlindSpots.map((flag) => (
                <BlindSpotCard key={flag.id} flag={flag} />
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              No open blind spots on this deal right now.
            </p>
          )}
        </div>

        {data?.packet && (
          <div className="flex items-center gap-2 border-t pt-4">
            <span className="text-xs text-muted-foreground mr-2">Was this useful?</span>
            <Button
              size="sm"
              variant="outline"
              disabled={submittingFeedback}
              onClick={() => void handleFeedback("useful")}
            >
              <ThumbsUp className="h-3.5 w-3.5 mr-2" />
              Useful
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={submittingFeedback}
              onClick={() => void handleFeedback("not_useful")}
            >
              <ThumbsDown className="h-3.5 w-3.5 mr-2" />
              Needs work
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
