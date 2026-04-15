import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";

export interface AiOpsMetrics {
  packetsGenerated24h: number;
  packetsPending: number;
  avgConfidence7d: number | null;
  openBlindSpots: number;
  suggestionsAccepted30d: number;
  suggestionsDismissed30d: number;
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

export interface QueueAiBackfillResult {
  queued: boolean;
  sourceType: string | null;
  batchSize: number;
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

export async function queueAiBackfill(sourceType?: string | null, batchSize = 100) {
  return api<QueueAiBackfillResult>("/ai/ops/backfill", {
    method: "POST",
    json: {
      sourceType: sourceType ?? null,
      batchSize,
    },
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
