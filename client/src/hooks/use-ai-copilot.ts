import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";

export interface AiCopilotPacket {
  id: string;
  scopeType: string;
  scopeId: string;
  dealId: string | null;
  packetKind: string;
  snapshotHash: string;
  modelName: string | null;
  status: string;
  summaryText: string | null;
  nextStepJson: Record<string, unknown> | null;
  blindSpotsJson: Record<string, unknown> | null;
  evidenceJson: Array<Record<string, unknown>> | null;
  confidence: string | null;
  generatedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AiTaskSuggestion {
  id: string;
  packetId: string;
  scopeType: string;
  scopeId: string;
  title: string;
  description: string | null;
  suggestedOwnerId: string | null;
  suggestedDueAt: string | null;
  priority: string;
  confidence: string | null;
  evidenceJson: Array<Record<string, unknown>> | null;
  status: string;
  acceptedTaskId: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

export interface AiRiskFlag {
  id: string;
  packetId: string | null;
  scopeType: string;
  scopeId: string;
  dealId: string | null;
  flagType: string;
  severity: string;
  status: string;
  title: string;
  details: string | null;
  evidenceJson: Array<Record<string, unknown>> | null;
  createdAt: string;
  resolvedAt: string | null;
}

export interface DealCopilotView {
  packet: AiCopilotPacket | null;
  suggestedTasks: AiTaskSuggestion[];
  blindSpotFlags: AiRiskFlag[];
}

export interface DirectorBlindSpot {
  id: string;
  dealId: string | null;
  title: string;
  severity: string;
  status: string;
  details: string | null;
  createdAt: string;
  dealName: string | null;
  dealNumber: string | null;
}

export interface CompanyCopilotDeal {
  id: string;
  dealNumber: string;
  name: string;
  lastActivityAt: string | null;
  updatedAt: string;
  latestPacketSummary: string | null;
  latestPacketConfidence: number | null;
}

export interface CompanyCopilotView {
  company: {
    id: string;
    name: string;
    contactCount: number;
    dealCount: number;
  };
  summaryText: string;
  relatedDeals: CompanyCopilotDeal[];
  suggestedTasks: AiTaskSuggestion[];
  blindSpotFlags: AiRiskFlag[];
}

interface FeedbackInput {
  targetType: string;
  targetId: string;
  feedbackType: string;
  feedbackValue: string;
  comment?: string | null;
}

export function useDealCopilot(dealId: string | undefined) {
  const [data, setData] = useState<DealCopilotView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [regenerating, setRegenerating] = useState(false);
  const [refreshQueuedAt, setRefreshQueuedAt] = useState<string | null>(null);
  const [workingSuggestionId, setWorkingSuggestionId] = useState<string | null>(null);
  const [submittingFeedback, setSubmittingFeedback] = useState(false);

  const fetchCopilot = useCallback(async (options?: { silent?: boolean }) => {
    if (!dealId) {
      setLoading(false);
      setData(null);
      return;
    }

    if (!options?.silent) {
      setLoading(true);
    }
    setError(null);
    try {
      const view = await api<DealCopilotView>(`/ai/deals/${dealId}/copilot`);
      setData(view);
      if (refreshQueuedAt && view.packet?.generatedAt) {
        const queuedAt = new Date(refreshQueuedAt).getTime();
        const generatedAt = new Date(view.packet.generatedAt).getTime();
        if (!Number.isNaN(queuedAt) && !Number.isNaN(generatedAt) && generatedAt >= queuedAt) {
          setRefreshQueuedAt(null);
        }
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load deal copilot");
    } finally {
      if (!options?.silent) {
        setLoading(false);
      }
    }
  }, [dealId, refreshQueuedAt]);

  useEffect(() => {
    void fetchCopilot();
  }, [fetchCopilot]);

  useEffect(() => {
    if (!refreshQueuedAt) return;

    const intervalId = window.setInterval(() => {
      void fetchCopilot({ silent: true });
    }, 5000);

    return () => window.clearInterval(intervalId);
  }, [fetchCopilot, refreshQueuedAt]);

  const regenerate = useCallback(async () => {
    if (!dealId) return;

    setRegenerating(true);
    setError(null);
    try {
      await api(`/ai/deals/${dealId}/regenerate`, { method: "POST" });
      setRefreshQueuedAt(new Date().toISOString());
      await fetchCopilot({ silent: true });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to regenerate deal copilot");
      throw err;
    } finally {
      setRegenerating(false);
    }
  }, [dealId, fetchCopilot]);

  const acceptSuggestion = useCallback(async (suggestionId: string) => {
    setWorkingSuggestionId(suggestionId);
    setError(null);
    try {
      await api(`/ai/task-suggestions/${suggestionId}/accept`, { method: "POST" });
      await fetchCopilot();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to accept task suggestion");
      throw err;
    } finally {
      setWorkingSuggestionId(null);
    }
  }, [fetchCopilot]);

  const dismissSuggestion = useCallback(async (suggestionId: string) => {
    setWorkingSuggestionId(suggestionId);
    setError(null);
    try {
      await api(`/ai/task-suggestions/${suggestionId}/dismiss`, { method: "POST" });
      await fetchCopilot();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to dismiss task suggestion");
      throw err;
    } finally {
      setWorkingSuggestionId(null);
    }
  }, [fetchCopilot]);

  const submitFeedback = useCallback(async (input: FeedbackInput) => {
    setSubmittingFeedback(true);
    setError(null);
    try {
      await api("/ai/feedback", {
        method: "POST",
        json: {
          targetType: input.targetType,
          targetId: input.targetId,
          feedbackType: input.feedbackType,
          feedbackValue: input.feedbackValue,
          comment: input.comment ?? null,
        },
      });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to save AI feedback");
      throw err;
    } finally {
      setSubmittingFeedback(false);
    }
  }, []);

  return {
    data,
    loading,
    error,
    regenerating,
    refreshQueuedAt,
    submittingFeedback,
    workingSuggestionId,
    refetch: fetchCopilot,
    regenerate,
    acceptSuggestion,
    dismissSuggestion,
    submitFeedback,
  };
}

export function useDirectorBlindSpots() {
  const [blindSpots, setBlindSpots] = useState<DirectorBlindSpot[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchBlindSpots = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api<{ blindSpots: DirectorBlindSpot[] }>("/ai/blind-spots");
      setBlindSpots(data.blindSpots);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load blind spots");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchBlindSpots();
  }, [fetchBlindSpots]);

  return {
    blindSpots,
    loading,
    error,
    refetch: fetchBlindSpots,
  };
}

export function useCompanyCopilot(companyId: string | undefined) {
  const [data, setData] = useState<CompanyCopilotView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchCopilot = useCallback(async () => {
    if (!companyId) {
      setData(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const view = await api<CompanyCopilotView>(`/ai/companies/${companyId}/copilot`);
      setData(view);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load company copilot");
    } finally {
      setLoading(false);
    }
  }, [companyId]);

  useEffect(() => {
    void fetchCopilot();
  }, [fetchCopilot]);

  return {
    data,
    loading,
    error,
    refetch: fetchCopilot,
  };
}
