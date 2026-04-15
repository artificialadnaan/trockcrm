import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";

export interface AiOpsMetrics {
  packetsGenerated24h: number;
  packetsPending: number;
  avgConfidence7d: number | null;
  openBlindSpots: number;
  suggestionsAccepted30d: number;
  suggestionsDismissed30d: number;
  triageActions30d: number;
  escalations30d: number;
  resolvedBlindSpots30d: number;
  recurringBlindSpotsOpen: number;
  recurringSuggestionsOpen: number;
  aiSearchInteractions30d: number;
  aiSearchQueriesWithClick30d: number;
  aiSearchWorkflowExecutions30d: number;
  aiSearchQueriesWithWorkflow30d: number;
  aiSearchQueriesServed30d: number;
  aiSearchWorkflowConversionRate30d: number | null;
  positiveFeedback30d: number;
  negativeFeedback30d: number;
  documentsIndexed: number;
  documentsPending: number;
  documentStatusBySource: Array<{
    sourceType: string;
    indexed: number;
    pending: number;
  }>;
}

export interface AiReviewQueueEntry {
  packetId: string;
  dealId: string | null;
  dealName: string | null;
  dealNumber: string | null;
  status: string;
  summaryText: string | null;
  confidence: number | null;
  generatedAt: string | null;
  createdAt: string;
  suggestedCount: number;
  acceptedCount: number;
  dismissedCount: number;
  openBlindSpotCount: number;
  positiveFeedbackCount: number;
  negativeFeedbackCount: number;
}

export interface AiActionQueueEntry {
  entryType: "blind_spot" | "task_suggestion";
  id: string;
  dealId: string | null;
  dealName: string | null;
  dealNumber: string | null;
  title: string;
  details: string | null;
  severity: string | null;
  priority: string | null;
  status: string;
  createdAt: string;
  suggestedDueAt: string | null;
  repeatCount: number;
  lastTriageAction: string | null;
  lastTriagedAt: string | null;
  escalated: boolean;
}

export interface AiReviewPacketDetail {
  packet: {
    id: string;
    dealId: string | null;
    status: string;
    scopeType: string;
    scopeId: string;
    packetKind: string;
    summaryText: string | null;
    confidence: number | null;
    providerName: string | null;
    modelName: string | null;
    generatedAt: string | null;
    expiresAt: string | null;
    dealName: string | null;
    dealNumber: string | null;
  } | null;
  suggestedTasks: Array<{
    id: string;
    title: string;
    description: string | null;
    status: string;
    priority: string;
    dueAt: string | null;
    createdTaskId: string | null;
    evidenceJson: unknown;
    createdAt: string;
  }>;
  blindSpotFlags: Array<{
    id: string;
    flagKey: string;
    status: string;
    severity: string;
    summaryText: string;
    evidenceJson: unknown;
    createdAt: string;
  }>;
  feedback: Array<{
    id: string;
    feedbackType: string;
    feedbackValue: string;
    commentText: string | null;
    createdAt: string;
  }>;
}

export interface SalesProcessDisconnectSummary {
  activeDeals: number;
  totalDisconnects: number;
  staleStageCount: number;
  missingNextTaskCount: number;
  inboundWithoutFollowupCount: number;
  revisionLoopCount: number;
  estimatingGateGapCount: number;
  procoreBidBoardDriftCount: number;
}

export interface SalesProcessDisconnectTypeSummary {
  disconnectType: string;
  label: string;
  count: number;
}

export interface SalesProcessDisconnectRow {
  id: string;
  dealNumber: string;
  dealName: string;
  companyId: string | null;
  companyName: string | null;
  stageName: string | null;
  estimatingSubstage: string | null;
  assignedRepName: string | null;
  disconnectType: string;
  disconnectLabel: string;
  disconnectSeverity: string;
  disconnectSummary: string;
  disconnectDetails: string | null;
  ageDays: number | null;
  openTaskCount: number;
  inboundWithoutFollowupCount: number;
  lastActivityAt: string | null;
  latestCustomerEmailAt: string | null;
  proposalStatus: string | null;
  procoreSyncStatus: string | null;
  procoreSyncDirection: string | null;
  procoreLastSyncedAt: string | null;
  procoreSyncUpdatedAt: string | null;
  procoreDriftReason: string | null;
}

export interface SalesProcessDisconnectTrendEntry {
  key: string;
  label: string;
  disconnectCount: number;
  dealCount: number;
  criticalCount: number;
  recentInterventionCount: number;
  clusterKeys: string[];
}

export interface SalesProcessDisconnectOutcomes {
  interventionDeals30d: number;
  clearedAfterIntervention30d: number;
  stillOpenAfterIntervention30d: number;
  unresolvedEscalationsOpen: number;
  repeatIssueDealsOpen: number;
  repeatClusterDealsOpen: number;
  interventionCoverageRate: number | null;
  clearanceRate30d: number | null;
}

export interface SalesProcessDisconnectActionSummary {
  markReviewed30d: number;
  resolve30d: number;
  dismiss30d: number;
  escalate30d: number;
  bestOverallAction: "mark_reviewed" | "resolve" | "dismiss" | "escalate" | null;
  bestOverallClearanceRate: number | null;
}

export interface SalesProcessDisconnectPlaybookAction {
  action: "mark_reviewed" | "resolve" | "dismiss" | "escalate";
  interventionDeals30d: number;
  clearedDeals30d: number;
  stillOpenDeals30d: number;
  clearanceRate30d: number | null;
}

export interface SalesProcessDisconnectPlaybook {
  clusterKey: string;
  title: string;
  bestAction: "mark_reviewed" | "resolve" | "dismiss" | "escalate" | null;
  recommendedAction: "mark_reviewed" | "resolve" | "dismiss" | "escalate" | null;
  interventionDeals30d: number;
  stillOpenDeals30d: number;
  actions: SalesProcessDisconnectPlaybookAction[];
}

export interface SalesProcessDisconnectCluster {
  clusterKey: string;
  title: string;
  summary: string;
  likelyRootCause: string;
  recommendedAction: string;
  severity: string;
  dealCount: number;
  disconnectCount: number;
  disconnectTypes: string[];
  stages: string[];
  reps: string[];
  includesProcoreBidBoard: boolean;
}

export interface SalesProcessDisconnectDashboard {
  summary: SalesProcessDisconnectSummary;
  byType: SalesProcessDisconnectTypeSummary[];
  clusters: SalesProcessDisconnectCluster[];
  trends: {
    reps: SalesProcessDisconnectTrendEntry[];
    stages: SalesProcessDisconnectTrendEntry[];
    companies: SalesProcessDisconnectTrendEntry[];
  };
  outcomes: SalesProcessDisconnectOutcomes;
  actionSummary: SalesProcessDisconnectActionSummary;
  playbooks: SalesProcessDisconnectPlaybook[];
  rows: SalesProcessDisconnectRow[];
}

export interface QueueAiBackfillResult {
  queued: boolean;
  sourceType: string | null;
  batchSize: number;
}

export interface QueueAiDisconnectDigestResult {
  queued: boolean;
  mode: string;
}

export interface TriageAiActionResult {
  entryType: "blind_spot" | "task_suggestion";
  id: string;
  action: "mark_reviewed" | "resolve" | "dismiss" | "escalate";
  feedbackId: string;
  targetStatus: string;
}

export function useAiOps(limit = 20) {
  const [metrics, setMetrics] = useState<AiOpsMetrics | null>(null);
  const [reviews, setReviews] = useState<AiReviewQueueEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [metricsRes, reviewsRes] = await Promise.all([
        api<{ metrics: AiOpsMetrics }>("/ai/ops/metrics"),
        api<{ reviews: AiReviewQueueEntry[] }>(`/ai/ops/reviews?limit=${limit}`),
      ]);
      setMetrics(metricsRes.metrics);
      setReviews(reviewsRes.reviews);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load AI ops data");
    } finally {
      setLoading(false);
    }
  }, [limit]);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  return {
    metrics,
    reviews,
    loading,
    error,
    refetch: fetchData,
  };
}

export function useAiActionQueue(limit = 50) {
  const [queue, setQueue] = useState<AiActionQueueEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await api<{ queue: AiActionQueueEntry[] }>(`/ai/ops/action-queue?limit=${limit}`);
      setQueue(response.queue);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load AI action queue");
    } finally {
      setLoading(false);
    }
  }, [limit]);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  return {
    queue,
    loading,
    error,
    refetch: fetchData,
  };
}

export function useSalesProcessDisconnectDashboard(limit = 50) {
  const [dashboard, setDashboard] = useState<SalesProcessDisconnectDashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await api<SalesProcessDisconnectDashboard>(`/ai/ops/process-disconnects?limit=${limit}`);
      setDashboard(response);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load sales process disconnects");
    } finally {
      setLoading(false);
    }
  }, [limit]);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  return {
    dashboard,
    loading,
    error,
    refetch: fetchData,
  };
}

export async function queueAiBackfill(sourceType?: string | null, batchSize = 100) {
  return api<QueueAiBackfillResult>("/ai/ops/backfill", {
    method: "POST",
    json: {
      sourceType: sourceType ?? null,
      batchSize,
    },
  });
}

export async function queueAiDisconnectDigest(mode = "manual") {
  return api<QueueAiDisconnectDigestResult>("/ai/ops/disconnect-digest", {
    method: "POST",
    json: { mode },
  });
}

export async function queueAiDisconnectEscalationScan(mode = "manual") {
  return api<QueueAiDisconnectDigestResult>("/ai/ops/disconnect-escalation-scan", {
    method: "POST",
    json: { mode },
  });
}

export async function triageAiActionQueueEntry(
  entryType: "blind_spot" | "task_suggestion",
  id: string,
  input: { action: "mark_reviewed" | "resolve" | "dismiss" | "escalate"; comment?: string | null }
) {
  return api<TriageAiActionResult>(`/ai/ops/action-queue/${entryType}/${id}`, {
    method: "POST",
    json: {
      action: input.action,
      comment: input.comment ?? null,
    },
  });
}

export async function trackSalesProcessDisconnectInteraction(input: {
  interactionType: "dashboard_view" | "deal_click" | "type_filter" | "cluster_filter" | "trend_focus" | "outcome_focus";
  targetValue: string;
  comment?: string | null;
}) {
  return api("/ai/feedback", {
    method: "POST",
    json: {
      targetType: "sales_process_disconnect_dashboard",
      targetId: "sales-process-disconnect-dashboard",
      feedbackType: "ops_dashboard_interaction",
      feedbackValue: input.interactionType,
      comment: JSON.stringify({
        targetValue: input.targetValue,
        detail: input.comment ?? null,
      }),
    },
  });
}

export function useAiReviewPacketDetail(packetId: string | undefined) {
  const [detail, setDetail] = useState<AiReviewPacketDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    if (!packetId) {
      setDetail(null);
      setLoading(false);
      setError("Missing packet id");
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const response = await api<AiReviewPacketDetail>(`/ai/ops/reviews/${packetId}`);
      setDetail(response);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load AI packet detail");
    } finally {
      setLoading(false);
    }
  }, [packetId]);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  return {
    detail,
    loading,
    error,
    refetch: fetchData,
  };
}
