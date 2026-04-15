import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { AlertTriangle, CheckSquare2, RefreshCcw, ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import { triageAiActionQueueEntry, useAiActionQueue } from "@/hooks/use-ai-ops";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

function formatDate(value: string | null) {
  if (!value) return "Pending";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Pending";
  return date.toLocaleString();
}

const severityClasses: Record<string, string> = {
  critical: "bg-red-100 text-red-800 border-red-200",
  high: "bg-orange-100 text-orange-800 border-orange-200",
  medium: "bg-amber-100 text-amber-800 border-amber-200",
  low: "bg-slate-100 text-slate-700 border-slate-200",
};

const priorityClasses: Record<string, string> = {
  urgent: "bg-red-100 text-red-800 border-red-200",
  high: "bg-orange-100 text-orange-800 border-orange-200",
  normal: "bg-blue-100 text-blue-800 border-blue-200",
  low: "bg-slate-100 text-slate-700 border-slate-200",
};

export function AiActionQueuePage() {
  const { queue, loading, error, refetch } = useAiActionQueue(100);
  const [workingId, setWorkingId] = useState<string | null>(null);
  const [entryFilter, setEntryFilter] = useState<"all" | "blind_spot" | "task_suggestion">("all");
  const [repeatOnly, setRepeatOnly] = useState(false);
  const [escalatedOnly, setEscalatedOnly] = useState(false);

  const grouped = useMemo(() => ({
    blindSpots: queue.filter((item) => item.entryType === "blind_spot"),
    suggestedTasks: queue.filter((item) => item.entryType === "task_suggestion"),
  }), [queue]);

  const filteredQueue = useMemo(() => {
    return queue.filter((entry) => {
      if (entryFilter !== "all" && entry.entryType !== entryFilter) return false;
      if (repeatOnly && entry.repeatCount < 2) return false;
      if (escalatedOnly && !entry.escalated) return false;
      return true;
    });
  }, [entryFilter, escalatedOnly, queue, repeatOnly]);

  async function handleAction(
    entryType: "blind_spot" | "task_suggestion",
    id: string,
    action: "mark_reviewed" | "resolve" | "dismiss" | "escalate"
  ) {
    const key = `${entryType}:${id}:${action}`;
    setWorkingId(key);
    try {
      await triageAiActionQueueEntry(entryType, id, { action });
      toast.success("AI action updated");
      await refetch();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to update AI action");
    } finally {
      setWorkingId(null);
    }
  }

  return (
    <div className="p-6 space-y-6 bg-gray-50 min-h-screen">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-black tracking-tighter uppercase text-gray-900">AI Action Queue</h1>
          <p className="text-[11px] uppercase tracking-widest text-gray-400 mt-1">
            Triage unresolved AI blind spots and suggested next steps
          </p>
        </div>
        <Button variant="outline" onClick={() => void refetch()} disabled={loading}>
          <RefreshCcw className="h-4 w-4 mr-2" />
          Refresh
        </Button>
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><ShieldAlert className="h-4 w-4" /> Queue Size</CardTitle>
            <CardDescription>Total unresolved AI actions</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-4xl font-black">{queue.length}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><AlertTriangle className="h-4 w-4" /> Blind Spots</CardTitle>
            <CardDescription>Open issues needing attention</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-4xl font-black">{grouped.blindSpots.length}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><CheckSquare2 className="h-4 w-4" /> Suggested Tasks</CardTitle>
            <CardDescription>Unresolved AI next steps</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-4xl font-black">{grouped.suggestedTasks.length}</div>
          </CardContent>
        </Card>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button variant={entryFilter === "all" ? "default" : "outline"} size="sm" onClick={() => setEntryFilter("all")}>
          All
        </Button>
        <Button variant={entryFilter === "blind_spot" ? "default" : "outline"} size="sm" onClick={() => setEntryFilter("blind_spot")}>
          Blind Spots
        </Button>
        <Button variant={entryFilter === "task_suggestion" ? "default" : "outline"} size="sm" onClick={() => setEntryFilter("task_suggestion")}>
          Suggested Tasks
        </Button>
        <Button variant={repeatOnly ? "default" : "outline"} size="sm" onClick={() => setRepeatOnly((value) => !value)}>
          Repeat Issues Only
        </Button>
        <Button variant={escalatedOnly ? "default" : "outline"} size="sm" onClick={() => setEscalatedOnly((value) => !value)}>
          Escalated Only
        </Button>
      </div>

      {filteredQueue.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            No AI actions match the current filters.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {filteredQueue.map((entry) => {
            const severityOrPriorityClass =
              entry.entryType === "blind_spot"
                ? severityClasses[entry.severity ?? "low"] ?? severityClasses.low
                : priorityClasses[entry.priority ?? "normal"] ?? priorityClasses.normal;

            return (
              <Card key={`${entry.entryType}:${entry.id}`} className="border-border/80">
                <CardContent className="p-5 space-y-4">
                  <div className="flex items-start justify-between gap-4">
                    <div className="space-y-2 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <Badge variant="outline">{entry.entryType === "blind_spot" ? "Blind Spot" : "Suggested Task"}</Badge>
                        <Badge variant="outline" className={severityOrPriorityClass}>
                          {entry.entryType === "blind_spot" ? entry.severity ?? "low" : entry.priority ?? "normal"}
                        </Badge>
                        <span className="text-xs text-muted-foreground">
                          Created {formatDate(entry.createdAt)}
                        </span>
                        {entry.repeatCount > 1 && (
                          <Badge variant="outline">Repeat x{entry.repeatCount}</Badge>
                        )}
                        {entry.escalated && (
                          <Badge variant="outline" className="border-red-200 bg-red-50 text-red-700">
                            Escalated
                          </Badge>
                        )}
                        {entry.suggestedDueAt && (
                          <span className="text-xs text-muted-foreground">
                            Due {formatDate(entry.suggestedDueAt)}
                          </span>
                        )}
                        {entry.lastTriagedAt && (
                          <span className="text-xs text-muted-foreground">
                            Last triage {entry.lastTriageAction ?? "reviewed"} on {formatDate(entry.lastTriagedAt)}
                          </span>
                        )}
                      </div>
                      <div className="space-y-1">
                        {entry.dealId ? (
                          <Link to={`/deals/${entry.dealId}`} className="text-sm font-semibold text-brand-red hover:underline">
                            {entry.dealNumber ? `${entry.dealNumber} ` : ""}{entry.dealName ?? "Unnamed deal"}
                          </Link>
                        ) : (
                          <div className="text-sm font-semibold">{entry.dealName ?? "Unlinked deal"}</div>
                        )}
                        <div className="text-base font-semibold text-foreground">{entry.title}</div>
                        {entry.details && (
                          <div className="text-sm text-muted-foreground leading-6">{entry.details}</div>
                        )}
                      </div>
                    </div>

                    <div className="flex flex-wrap gap-2 justify-end">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={workingId !== null}
                        onClick={() => void handleAction(entry.entryType, entry.id, "mark_reviewed")}
                      >
                        {workingId === `${entry.entryType}:${entry.id}:mark_reviewed` ? "Saving..." : "Mark Reviewed"}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={workingId !== null}
                        onClick={() => void handleAction(entry.entryType, entry.id, "escalate")}
                      >
                        {workingId === `${entry.entryType}:${entry.id}:escalate` ? "Saving..." : "Escalate"}
                      </Button>
                      <Button
                        size="sm"
                        disabled={workingId !== null}
                        onClick={() => void handleAction(entry.entryType, entry.id, entry.entryType === "blind_spot" ? "resolve" : "dismiss")}
                      >
                        {workingId === `${entry.entryType}:${entry.id}:${entry.entryType === "blind_spot" ? "resolve" : "dismiss"}`
                          ? "Saving..."
                          : entry.entryType === "blind_spot"
                            ? "Resolve"
                            : "Dismiss"}
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
