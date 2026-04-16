import { Link, useParams } from "react-router-dom";
import { AlertTriangle, ArrowLeft, Brain, CheckCircle2, Clock3, MessageSquareWarning, RefreshCcw } from "lucide-react";
import { useAiReviewPacketDetail } from "@/hooks/use-ai-ops";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

function formatDate(value: string | null) {
  if (!value) return "Pending";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Pending";
  return date.toLocaleString();
}

function formatPercent(value: number | null) {
  if (value == null || Number.isNaN(value)) return "N/A";
  return `${Math.round(value * 100)}%`;
}

function stringifyEvidence(value: unknown) {
  if (value == null) return "No evidence attached.";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function AiPacketReviewPage() {
  const { packetId } = useParams();
  const { detail, loading, error, refetch } = useAiReviewPacketDetail(packetId);

  const packet = detail?.packet ?? null;

  return (
    <div className="p-6 space-y-6 bg-gray-50 min-h-screen">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-2">
          <Link to="/admin/ai-ops" className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground">
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to AI Ops
          </Link>
          <div>
            <h1 className="text-3xl font-black tracking-tighter uppercase text-gray-900">Packet Review</h1>
            <p className="text-[11px] uppercase tracking-widest text-gray-400 mt-1">
              Packet quality, suggested actions, blind spots, and reviewer feedback
            </p>
          </div>
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

      {!packet && !loading ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            No packet detail found for this review row.
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <Card className="lg:col-span-2">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Brain className="h-4 w-4" />
                  Packet Summary
                </CardTitle>
                <CardDescription>
                  {packet?.dealId ? (
                    <Link to={`/deals/${packet.dealId}`} className="text-brand-red hover:underline">
                      {packet.dealNumber ? `${packet.dealNumber} ` : ""}{packet.dealName ?? "Unnamed deal"}
                    </Link>
                  ) : (
                    <span>{packet?.dealName ?? "No deal attached"}</span>
                  )}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="rounded-xl border bg-white p-4 text-sm leading-6 text-gray-700">
                  {packet?.summaryText ?? "No summary generated yet."}
                </div>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                  <div className="rounded-lg border bg-white p-3">
                    <div className="text-muted-foreground">Status</div>
                    <div className="mt-1 font-semibold">{packet?.status ?? "unknown"}</div>
                  </div>
                  <div className="rounded-lg border bg-white p-3">
                    <div className="text-muted-foreground">Confidence</div>
                    <div className="mt-1 font-semibold">{formatPercent(packet?.confidence ?? null)}</div>
                  </div>
                  <div className="rounded-lg border bg-white p-3">
                    <div className="text-muted-foreground">Generated</div>
                    <div className="mt-1 font-semibold">{formatDate(packet?.generatedAt ?? null)}</div>
                  </div>
                  <div className="rounded-lg border bg-white p-3">
                    <div className="text-muted-foreground">Expires</div>
                    <div className="mt-1 font-semibold">{formatDate(packet?.expiresAt ?? null)}</div>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Model Context</CardTitle>
                <CardDescription>Provider and packet metadata</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-muted-foreground">Provider</span>
                  <span className="font-medium">{packet?.providerName ?? "heuristic"}</span>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-muted-foreground">Model</span>
                  <span className="font-medium">{packet?.modelName ?? "fallback"}</span>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-muted-foreground">Scope</span>
                  <span className="font-medium">{packet?.scopeType ?? "deal"}</span>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-muted-foreground">Kind</span>
                  <span className="font-medium">{packet?.packetKind ?? "deal"}</span>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-muted-foreground">Packet Id</span>
                  <span className="font-mono text-xs">{packet?.id ?? "missing"}</span>
                </div>
              </CardContent>
            </Card>
          </div>

          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <CheckCircle2 className="h-4 w-4" />
                  Suggested Tasks
                </CardTitle>
                <CardDescription>What the packet asked the team to do next</CardDescription>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Task</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Priority</TableHead>
                      <TableHead>Due</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(detail?.suggestedTasks ?? []).length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={4} className="py-6 text-center text-muted-foreground">
                          No task suggestions for this packet.
                        </TableCell>
                      </TableRow>
                    ) : (
                      (detail?.suggestedTasks ?? []).map((task) => (
                        <TableRow key={task.id}>
                          <TableCell className="max-w-[300px]">
                            <div className="space-y-1">
                              <div className="font-medium">{task.title}</div>
                              {task.description && (
                                <div className="text-xs text-muted-foreground">{task.description}</div>
                              )}
                            </div>
                          </TableCell>
                          <TableCell><Badge variant="outline">{task.status}</Badge></TableCell>
                          <TableCell>{task.priority}</TableCell>
                          <TableCell>{formatDate(task.dueAt)}</TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <AlertTriangle className="h-4 w-4" />
                  Blind Spots
                </CardTitle>
                <CardDescription>Operational risks inferred from this packet</CardDescription>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Flag</TableHead>
                      <TableHead>Severity</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(detail?.blindSpotFlags ?? []).length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={3} className="py-6 text-center text-muted-foreground">
                          No blind spots recorded for this packet.
                        </TableCell>
                      </TableRow>
                    ) : (
                      (detail?.blindSpotFlags ?? []).map((flag) => (
                        <TableRow key={flag.id}>
                          <TableCell className="max-w-[320px]">
                            <div className="space-y-1">
                              <div className="font-medium">{flag.flagKey}</div>
                              <div className="text-xs text-muted-foreground">{flag.summaryText}</div>
                            </div>
                          </TableCell>
                          <TableCell>{flag.severity}</TableCell>
                          <TableCell><Badge variant={flag.status === "open" ? "default" : "secondary"}>{flag.status}</Badge></TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </div>

          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <MessageSquareWarning className="h-4 w-4" />
                  Reviewer Feedback
                </CardTitle>
                <CardDescription>Human feedback attached to this packet</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {(detail?.feedback ?? []).length === 0 ? (
                  <div className="py-6 text-center text-sm text-muted-foreground">
                    No reviewer feedback yet.
                  </div>
                ) : (
                  (detail?.feedback ?? []).map((item) => (
                    <div key={item.id} className="rounded-xl border bg-white p-4 space-y-2">
                      <div className="flex items-center justify-between gap-3">
                        <div className="font-medium">{item.feedbackValue}</div>
                        <div className="text-xs text-muted-foreground">{formatDate(item.createdAt)}</div>
                      </div>
                      <div className="text-xs uppercase tracking-wide text-muted-foreground">{item.feedbackType}</div>
                      {item.commentText && <div className="text-sm text-gray-700">{item.commentText}</div>}
                    </div>
                  ))
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Clock3 className="h-4 w-4" />
                  Evidence Snapshot
                </CardTitle>
                <CardDescription>Raw evidence payloads from suggestions and blind spots</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Suggested Task Evidence
                  </div>
                  <pre className="max-h-64 overflow-auto rounded-xl border bg-white p-3 text-xs text-gray-700">
                    {stringifyEvidence(detail?.suggestedTasks?.map((task) => ({
                      id: task.id,
                      title: task.title,
                      evidenceJson: task.evidenceJson,
                    })) ?? [])}
                  </pre>
                </div>
                <div>
                  <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Blind Spot Evidence
                  </div>
                  <pre className="max-h-64 overflow-auto rounded-xl border bg-white p-3 text-xs text-gray-700">
                    {stringifyEvidence(detail?.blindSpotFlags?.map((flag) => ({
                      id: flag.id,
                      flagKey: flag.flagKey,
                      evidenceJson: flag.evidenceJson,
                    })) ?? [])}
                  </pre>
                </div>
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
