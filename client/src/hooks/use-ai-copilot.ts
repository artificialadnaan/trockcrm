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

export interface InterventionCopilotPacketView {
  id: string | null;
  scopeType: "intervention_case" | null;
  scopeId: string | null;
  packetKind: "intervention_case" | null;
  status: string | null;
  snapshotHash: string | null;
  modelName: string | null;
  summaryText: string | null;
  nextStepJson: Record<string, unknown> | null;
  blindSpotsJson: Array<Record<string, unknown>> | null;
  evidenceJson: Array<Record<string, unknown>> | null;
  confidence: number | null;
  generatedAt: string | null;
  expiresAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface InterventionCopilotOwnerContext {
  id: string | null;
  name: string | null;
  type?: string | null;
}

export interface InterventionCopilotRecommendedAction {
  action: "assign" | "resolve" | "snooze" | "escalate" | "investigate";
  rationale: string | null;
  suggestedOwnerId: string | null;
  suggestedOwner: string | null;
}

export interface InterventionCopilotRootCause {
  label: string | null;
  explanation: string | null;
}

export interface InterventionCopilotReopenRisk {
  level: "low" | "medium" | "high";
  rationale: string | null;
}

export interface InterventionCopilotEvidenceItem {
  sourceType: string;
  textSnippet: string | null;
  label: string | null;
}

export interface InterventionCopilotRiskFlag {
  flagType: string;
  title: string;
  severity: "low" | "medium" | "high" | "critical";
  details: string | null;
}

export interface InterventionCopilotSimilarCase {
  caseId: string;
  businessKey: string;
  disconnectType: string;
  clusterKey: string | null;
  assigneeAtConclusion: string | null;
  conclusionKind: "resolve" | "snooze" | "escalate";
  reasonCode: string | null;
  durableClose: boolean | null;
  reopened: boolean;
  daysToDurableClosure: number | null;
  queueLink: string;
}

export interface InterventionCopilotView {
  packet: InterventionCopilotPacketView;
  evidence: InterventionCopilotEvidenceItem[];
  riskFlags: InterventionCopilotRiskFlag[];
  similarCases: InterventionCopilotSimilarCase[];
  recommendedAction: InterventionCopilotRecommendedAction | null;
  rootCause: InterventionCopilotRootCause | null;
  blockerOwner: InterventionCopilotOwnerContext | null;
  reopenRisk: InterventionCopilotReopenRisk | null;
  currentAssignee: InterventionCopilotOwnerContext | null;
  isRefreshPending: boolean;
  isStale: boolean;
  latestCaseChangedAt: string | null;
  packetGeneratedAt: string | null;
  viewerFeedbackValue: string | null;
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

export function useInterventionCopilot(caseId: string | null) {
  const [data, setData] = useState<InterventionCopilotView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [regenerating, setRegenerating] = useState(false);
  const [refreshQueuedAt, setRefreshQueuedAt] = useState<string | null>(null);
  const [submittingFeedback, setSubmittingFeedback] = useState(false);

  const fetchCopilot = useCallback(async (options?: { silent?: boolean }) => {
    if (!caseId) {
      setData(null);
      setLoading(false);
      setError(null);
      setRefreshQueuedAt(null);
      return;
    }

    if (!options?.silent) setLoading(true);
    setError(null);
    try {
      const view = await api<InterventionCopilotView>(`/ai/ops/interventions/${caseId}/copilot`);
      setData(view);
      if (refreshQueuedAt && view.packetGeneratedAt) {
        const queuedAt = new Date(refreshQueuedAt).getTime();
        const generatedAt = new Date(view.packetGeneratedAt).getTime();
        if (!Number.isNaN(queuedAt) && !Number.isNaN(generatedAt) && generatedAt >= queuedAt && !view.isRefreshPending) {
          setRefreshQueuedAt(null);
        }
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load intervention copilot");
    } finally {
      if (!options?.silent) setLoading(false);
    }
  }, [caseId, refreshQueuedAt]);

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
    if (!caseId) return;
    setRegenerating(true);
    setError(null);
    try {
      const response = await api<{ queued: boolean; packetId: string; packetGeneratedAt: string; requestedBy: string }>(
        `/ai/ops/interventions/${caseId}/copilot/regenerate`,
        { method: "POST" }
      );
      setRefreshQueuedAt(response.packetGeneratedAt ?? new Date().toISOString());
      await fetchCopilot({ silent: true });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to regenerate intervention copilot");
      throw err;
    } finally {
      setRegenerating(false);
    }
  }, [caseId, fetchCopilot]);

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
      await fetchCopilot({ silent: true });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to save intervention copilot feedback");
      throw err;
    } finally {
      setSubmittingFeedback(false);
    }
  }, [fetchCopilot]);

  return {
    data,
    loading,
    error,
    regenerating,
    refreshQueuedAt,
    submittingFeedback,
    refetch: fetchCopilot,
    regenerate,
    submitFeedback,
  };
}
