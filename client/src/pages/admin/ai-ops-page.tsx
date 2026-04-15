import { useState } from "react";
import { Link } from "react-router-dom";
import { AlertTriangle, CheckCircle2, Clock3, DatabaseZap, RefreshCcw, Sparkles, ThumbsDown, ThumbsUp } from "lucide-react";
import { toast } from "sonner";
import { queueAiBackfill, useAiOps } from "@/hooks/use-ai-ops";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

function formatPercent(value: number | null) {
  if (value == null || Number.isNaN(value)) return "N/A";
  return `${Math.round(value * 100)}%`;
}

function formatDate(value: string | null) {
  if (!value) return "Pending";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Pending";
  return date.toLocaleString();
}

function statusVariant(status: string): "secondary" | "outline" | "default" {
  if (status === "completed") return "secondary";
  if (status === "pending") return "outline";
  return "default";
}

export function AiOpsPage() {
  const { metrics, reviews, loading, error, refetch } = useAiOps(25);
  const [backfillState, setBackfillState] = useState<string | null>(null);

  async function handleBackfill(sourceType?: string) {
    const backfillKey = sourceType ?? "all";
    setBackfillState(backfillKey);
    try {
      const result = await queueAiBackfill(sourceType ?? null, 100);
      toast.success(
        result.sourceType
          ? `Queued ${result.sourceType} AI backfill batch`
          : "Queued historical AI backfill batch"
      );
      await refetch();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to queue AI backfill");
    } finally {
      setBackfillState(null);
    }
  }

  return (
    <div className="p-6 space-y-6 bg-gray-50 min-h-screen">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-black tracking-tighter uppercase text-gray-900">AI Ops</h1>
          <p className="text-[11px] uppercase tracking-widest text-gray-400 mt-1">
            Copilot health, evaluation, and review queue
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            onClick={() => void handleBackfill()}
            disabled={loading || backfillState !== null}
          >
            <DatabaseZap className="h-4 w-4 mr-2" />
            Queue Backfill
          </Button>
          <Button variant="outline" onClick={() => void refetch()} disabled={loading}>
            <RefreshCcw className="h-4 w-4 mr-2" />
            Refresh
          </Button>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Sparkles className="h-4 w-4" /> Packet Throughput</CardTitle>
            <CardDescription>Generation and queue health over the last day</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            <div className="text-3xl font-black">{metrics?.packetsGenerated24h ?? 0}</div>
            <div className="text-sm text-muted-foreground">Packets generated in 24h</div>
            <div className="flex items-center gap-2 text-sm">
              <Clock3 className="h-4 w-4 text-amber-600" />
              <span>{metrics?.packetsPending ?? 0} pending</span>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><CheckCircle2 className="h-4 w-4" /> Quality Signal</CardTitle>
            <CardDescription>Confidence and feedback trends</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            <div className="text-3xl font-black">{formatPercent(metrics?.avgConfidence7d ?? null)}</div>
            <div className="text-sm text-muted-foreground">Average confidence over 7d</div>
            <div className="flex items-center gap-4 text-sm">
              <span className="inline-flex items-center gap-1 text-green-700"><ThumbsUp className="h-4 w-4" /> {metrics?.positiveFeedback30d ?? 0}</span>
              <span className="inline-flex items-center gap-1 text-red-700"><ThumbsDown className="h-4 w-4" /> {metrics?.negativeFeedback30d ?? 0}</span>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><AlertTriangle className="h-4 w-4" /> Outcome Signals</CardTitle>
            <CardDescription>Blind spots and task suggestion resolution</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            <div className="text-3xl font-black">{metrics?.openBlindSpots ?? 0}</div>
            <div className="text-sm text-muted-foreground">Open blind spots</div>
            <div className="flex items-center gap-4 text-sm">
              <span>{metrics?.suggestionsAccepted30d ?? 0} accepted</span>
              <span>{metrics?.suggestionsDismissed30d ?? 0} dismissed</span>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><DatabaseZap className="h-4 w-4" /> Index Coverage</CardTitle>
            <CardDescription>Document indexing availability</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            <div className="text-3xl font-black">{metrics?.documentsIndexed ?? 0}</div>
            <div className="text-sm text-muted-foreground">Indexed documents</div>
            <div className="text-sm">{metrics?.documentsPending ?? 0} pending / failed</div>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <CardHeader>
            <CardTitle>Triage Volume</CardTitle>
            <CardDescription>Manager interventions over the last 30 days</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            <div className="text-3xl font-black">{metrics?.triageActions30d ?? 0}</div>
            <div className="text-sm text-muted-foreground">Triage actions logged</div>
            <div className="text-sm">{metrics?.escalations30d ?? 0} escalations</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Resolution Signal</CardTitle>
            <CardDescription>Blind spots resolved within 30 days</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            <div className="text-3xl font-black">{metrics?.resolvedBlindSpots30d ?? 0}</div>
            <div className="text-sm text-muted-foreground">Resolved blind spots</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Repeat Issues</CardTitle>
            <CardDescription>Problems that keep coming back</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            <div className="text-3xl font-black">{(metrics?.recurringBlindSpotsOpen ?? 0) + (metrics?.recurringSuggestionsOpen ?? 0)}</div>
            <div className="flex items-center gap-4 text-sm">
              <span>{metrics?.recurringBlindSpotsOpen ?? 0} blind spots</span>
              <span>{metrics?.recurringSuggestionsOpen ?? 0} suggestions</span>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card>
          <CardHeader>
            <CardTitle>AI Search Engagement</CardTitle>
            <CardDescription>Search follow-through activity over the last 30 days</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            <div className="text-3xl font-black">{metrics?.aiSearchInteractions30d ?? 0}</div>
            <div className="text-sm text-muted-foreground">Tracked AI search interactions</div>
            <div className="text-sm">{metrics?.aiSearchWorkflowExecutions30d ?? 0} executed workflows</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Queries With Follow-Through</CardTitle>
            <CardDescription>Distinct AI search queries that led to a click</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            <div className="text-3xl font-black">{metrics?.aiSearchQueriesWithClick30d ?? 0}</div>
            <div className="text-sm text-muted-foreground">Queries with tracked AI search follow-through</div>
            <div className="text-sm">{metrics?.aiSearchQueriesWithWorkflow30d ?? 0} queries with executed workflows</div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Index Status By Source</CardTitle>
          <CardDescription>Coverage by indexed CRM text source</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Source</TableHead>
                <TableHead className="text-right">Indexed</TableHead>
                <TableHead className="text-right">Pending</TableHead>
                <TableHead className="text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(metrics?.documentStatusBySource ?? []).length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className="text-center text-muted-foreground py-6">No indexed sources yet.</TableCell>
                </TableRow>
              ) : (
                (metrics?.documentStatusBySource ?? []).map((row) => (
                  <TableRow key={row.sourceType}>
                    <TableCell className="font-medium">{row.sourceType}</TableCell>
                    <TableCell className="text-right">{row.indexed}</TableCell>
                    <TableCell className="text-right">{row.pending}</TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void handleBackfill(row.sourceType)}
                        disabled={loading || backfillState !== null}
                      >
                        {backfillState === row.sourceType ? "Queueing..." : "Backfill"}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Packet Review Queue</CardTitle>
          <CardDescription>Recent copilot outputs and downstream outcomes</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Deal</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Confidence</TableHead>
                <TableHead>Suggestions</TableHead>
                <TableHead>Blind Spots</TableHead>
                <TableHead>Feedback</TableHead>
                <TableHead>Generated</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {reviews.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="text-center text-muted-foreground py-6">
                    No AI review rows yet.
                  </TableCell>
                </TableRow>
              ) : (
                reviews.map((row) => (
                  <TableRow key={row.packetId}>
                    <TableCell className="max-w-[320px]">
                      <div className="space-y-1">
                        <Link to={`/admin/ai-ops/reviews/${row.packetId}`} className="font-medium text-brand-red hover:underline">
                          {row.dealNumber ? `${row.dealNumber} ` : ""}{row.dealName ?? "Unnamed deal"}
                        </Link>
                        {row.summaryText && (
                          <p className="text-xs text-muted-foreground truncate">{row.summaryText}</p>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant={statusVariant(row.status)}>{row.status}</Badge>
                    </TableCell>
                    <TableCell>{formatPercent(row.confidence)}</TableCell>
                    <TableCell>{row.acceptedCount}/{row.suggestedCount} accepted</TableCell>
                    <TableCell>{row.openBlindSpotCount} open</TableCell>
                    <TableCell>
                      <span className="text-green-700">{row.positiveFeedbackCount}</span>
                      <span className="text-muted-foreground mx-1">/</span>
                      <span className="text-red-700">{row.negativeFeedbackCount}</span>
                    </TableCell>
                    <TableCell>{formatDate(row.generatedAt ?? row.createdAt)}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
