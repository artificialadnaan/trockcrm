import { useCallback, useEffect, useRef, useState } from "react";
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

export interface SalesProcessDisconnectAutomationStatus {
  digestNotifications7d: number;
  escalationNotifications7d: number;
  adminTasksCreated7d: number;
  adminTasksOpen: number;
  latestDigestAt: string | null;
  latestEscalationAt: string | null;
  latestAdminTaskCreatedAt: string | null;
}

export interface SalesProcessDisconnectNarrative {
  headline: string;
  summary: string;
  whatChanged: string;
  adminFocus: string;
  recommendedActions: string[];
}

export interface SalesProcessDisconnectDashboard {
  summary: SalesProcessDisconnectSummary;
  automation: SalesProcessDisconnectAutomationStatus;
  narrative: SalesProcessDisconnectNarrative;
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

export interface InterventionAnalyticsHotspotRow {
  key: string;
  entityType: "assignee" | "disconnect_type" | "rep" | "company" | "stage";
  filterValue: string | null;
  label: string;
  openCases: number;
  overdueCases: number;
  repeatOpenCases: number;
  clearanceRate30d: number | null;
  queueLink: string | null;
}

export interface InterventionAnalyticsBreachRow {
  caseId: string;
  severity: string;
  disconnectType: string;
  dealId: string | null;
  dealLabel: string | null;
  companyId: string | null;
  companyLabel: string | null;
  ageDays: number;
  assignedTo: string | null;
  escalated: boolean;
  breachReasons: Array<"overdue" | "escalated_open" | "snooze_breached" | "repeat_open">;
  detailLink: string;
  queueLink: string;
}

export interface InterventionOutcomeEffectiveness {
  summaryByConclusionFamily: Array<{
    key: "resolve" | "snooze" | "escalate";
    label: string;
    volume: number;
    reopenRate: number | null;
    durableCloseRate: number | null;
    medianDaysToReopen: number | null;
    averageDaysToDurableClose: number | null;
    queueLink: string;
  }>;
  resolveReasonPerformance: Array<{
    key: string;
    label: string;
    volume: number;
    reopenRate: number | null;
    durableCloseRate: number | null;
    medianDaysToReopen: number | null;
    averageDaysToDurableClose: number | null;
    queueLink: string;
  }>;
  snoozeReasonPerformance: Array<{
    key: string;
    label: string;
    volume: number;
    reopenRate: number | null;
    durableCloseRate: number | null;
    medianDaysToReopen: number | null;
    averageDaysToDurableClose: number | null;
    queueLink: string;
  }>;
  escalationReasonPerformance: Array<{
    key: string;
    label: string;
    volume: number;
    reopenRate: number | null;
    durableCloseRate: number | null;
    medianDaysToReopen: number | null;
    averageDaysToDurableClose: number | null;
    queueLink: string;
  }>;
  escalationTargetPerformance: Array<{
    key: string;
    label: string;
    volume: number;
    reopenRate: number | null;
    durableCloseRate: number | null;
    medianDaysToReopen: number | null;
    averageDaysToDurableClose: number | null;
    queueLink: string;
  }>;
  disconnectTypeInteractions: Array<{
    disconnectType: string;
    conclusionFamily: "resolve" | "snooze" | "escalate";
    volume: number;
    reopenRate: number | null;
    durableCloseRate: number | null;
    queueLink: string;
  }>;
  assigneeEffectiveness: Array<{
    assigneeId: string | null;
    assigneeName: string | null;
    volume: number;
    resolveCount: number;
    snoozeCount: number;
    escalateCount: number;
    reopenRate: number | null;
    durableCloseRate: number | null;
    queueLink: string | null;
  }>;
  warnings: Array<{
    kind:
      | "snooze_reopen_risk"
      | "escalation_reason_weak_close_through"
      | "escalation_target_weak_close_through"
      | "administrative_close_pattern";
    key: string;
    label: string;
    volume: number;
    rate: number | null;
    queueLink: string;
  }>;
  reopenRateByConclusionFamily: Record<"resolve" | "snooze" | "escalate", number | null>;
  reopenRateByResolveCategory: Array<{ key: string; rate: number | null; count: number }>;
  reopenRateBySnoozeReason: Array<{ key: string; rate: number | null; count: number }>;
  reopenRateByEscalationReason: Array<{ key: string; rate: number | null; count: number }>;
  conclusionMixByDisconnectType: Array<{ key: string; resolveCount: number; snoozeCount: number; escalateCount: number }>;
  conclusionMixByActingUser: Array<{
    actorUserId: string;
    actorName: string | null;
    resolveCount: number;
    snoozeCount: number;
    escalateCount: number;
  }>;
  conclusionMixByAssigneeAtConclusion: Array<{
    assigneeId: string | null;
    assigneeName: string | null;
    resolveCount: number;
    snoozeCount: number;
    escalateCount: number;
  }>;
  medianDaysToReopenByConclusionFamily: Array<{ key: string; medianDays: number | null }>;
}

export interface InterventionManagerBriefItem {
  key: string;
  text: string;
  queueLink: string | null;
}

export interface InterventionManagerBrief {
  headline: string;
  summaryWindowLabel: string;
  whatChanged: Array<InterventionManagerBriefItem & { tone: "improved" | "worsened" | "watch" }>;
  focusNow: Array<InterventionManagerBriefItem & { priority: "high" | "medium" }>;
  emergingPatterns: Array<{
    key: string;
    title: string;
    summary: string;
    confidence: "high" | "medium";
    queueLink: string | null;
  }>;
  groundingNote: string;
  error: string | null;
}

export interface InterventionAnalyticsDashboard {
  summary: {
    openCases: number;
    overdueCases: number;
    escalatedCases: number;
    snoozeOverdueCases: number;
    repeatOpenCases: number;
    openCasesBySeverity: Record<string, number>;
    overdueCasesBySeverity: Record<string, number>;
  };
  outcomes: {
    clearanceRate30d: number | null;
    reopenRate30d: number | null;
    averageAgeOfOpenCases: number | null;
    medianAgeOfOpenCases: number | null;
    averageAgeToResolution: number | null;
    actionVolume30d: Record<string, number>;
  };
  hotspots: {
    assignees: InterventionAnalyticsHotspotRow[];
    disconnectTypes: InterventionAnalyticsHotspotRow[];
    reps: InterventionAnalyticsHotspotRow[];
    companies: InterventionAnalyticsHotspotRow[];
    stages: InterventionAnalyticsHotspotRow[];
  };
  breachQueue: {
    items: InterventionAnalyticsBreachRow[];
    totalCount: number;
    pageSize: number;
  };
  slaRules: {
    criticalDays: number;
    highDays: number;
    mediumDays: number;
    lowDays: number;
    timingBasis: "business_days";
  };
  managerBrief: InterventionManagerBrief;
  outcomeEffectiveness: InterventionOutcomeEffectiveness;
}

export interface ManagerAlertSnapshot {
  id: string;
  officeId: string;
  snapshotKind: "manager_alert_summary";
  snapshotMode: "preview" | "sent";
  snapshotJson: ManagerAlertSnapshotJson;
  scannedAt: string;
  sentAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ManagerAlertSnapshotJson {
  version: 1;
  officeId: string;
  timezone: string;
  officeLocalDate: string;
  generatedAt: string;
  link: string;
  families: {
    overdueHighCritical: {
      count: number;
      queueLink: string;
      caseIds: string[];
    };
    snoozeBreached: {
      count: number;
      queueLink: string;
      caseIds: string[];
    };
    escalatedOpen: {
      count: number;
      queueLink: string;
      caseIds: string[];
    };
    assigneeOverload: {
      count: number;
      threshold: number;
      queueLink: string | null;
      items: Array<{
        assigneeId: string;
        assigneeLabel: string;
        totalWeight: number;
        caseCount: number;
        queueLink: string;
      }>;
    };
  };
}

export interface ManagerAlertSendResult {
  snapshot: ManagerAlertSnapshot;
  deliveries: Array<{
    recipientUserId: string;
    claimed: boolean;
    notification: {
      id: string;
    } | null;
  }>;
}

export type InterventionPolicyRecommendationFeedbackValue = "helpful" | "not_useful" | "wrong_direction";
export type InterventionPolicyRecommendationDecisionStatus =
  | "qualified_rendered"
  | "qualified_suppressed_by_cap"
  | "suppressed_by_threshold"
  | "suppressed_by_predicate"
  | "suppressed_by_missing_target"
  | "suppressed_by_apply_ineligible";

export type InterventionPolicyRecommendationApplyEventStatus =
  | "applied"
  | "applied_noop"
  | "rejected_validation"
  | "rejected_stale"
  | "rejected_conflict"
  | "reverted"
  | "revert_noop"
  | "revert_rejected_conflict";

export interface InterventionPolicyRecommendationEvidenceItem {
  metricKey: string;
  label: string;
  currentValue: number | string | null;
  baselineValue: number | string | null;
  delta: number | string | null;
  window: "last_7_days_vs_prior_7_days" | "last_30_days" | "last_30_days_vs_prior_30_days";
  direction: "up" | "down" | "flat" | "not_applicable";
}

export type InterventionPolicyRecommendationProposedChange =
  | {
      kind: "snooze_policy_adjustment";
      targetKey: string;
      policyLabel: string;
      currentValue: {
        maxSnoozeDays: number;
        breachReviewThresholdPercent: number | null;
      };
      proposedValue: {
        maxSnoozeDays: number;
        breachReviewThresholdPercent: number | null;
      };
    }
  | {
      kind: "escalation_policy_adjustment";
      targetKey: string;
      policyLabel: string;
      currentValue: {
        routingMode: string;
        escalationThresholdPercent: number;
      };
      proposedValue: {
        routingMode: string;
        escalationThresholdPercent: number;
      };
    }
  | {
      kind: "assignee_load_balancing";
      targetKey: string;
      policyLabel: string;
      currentValue: {
        balancingMode: string;
        overloadSharePercent: number;
        minHighRiskCases: number;
      };
      proposedValue: {
        balancingMode: string;
        overloadSharePercent: number;
        minHighRiskCases: number;
      };
    };

export interface InterventionPolicyRecommendationReviewDetails {
  decision: InterventionPolicyRecommendationDecisionStatus;
  primaryTrigger: string;
  thresholdSummary: string;
  rankingSummary: string;
  score: number;
  impactScore: number;
  volumeScore: number;
  persistenceScore: number;
  actionabilityScore: number;
  usedFallbackCopy: boolean;
  usedFallbackStructuredPayload: boolean;
}

export interface InterventionPolicyRecommendation {
  id: string;
  officeId: string;
  snapshotId: string;
  taxonomy:
    | "snooze_policy_adjustment"
    | "escalation_policy_adjustment"
    | "assignee_load_balancing"
    | "disconnect_playbook_change"
    | "monitor_only";
  title: string;
  statement: string;
  whyNow: string;
  expectedImpact: string;
  confidence: "high" | "medium" | "low";
  priority: number;
  suggestedAction: string;
  counterSignal: string | null;
  evidence: InterventionPolicyRecommendationEvidenceItem[];
  generatedAt: string;
  staleAt: string;
  renderStatus: "active" | "degraded";
  proposedChange: InterventionPolicyRecommendationProposedChange | null;
  reviewDetails: InterventionPolicyRecommendationReviewDetails;
  applyEligibility: {
    eligible: boolean;
    reason: "eligible" | "read_only_taxonomy" | "low_confidence" | "missing_proposed_change";
    message: string;
  };
  applyStatus: {
    status: "not_applied" | InterventionPolicyRecommendationApplyEventStatus;
    appliedAt: string | null;
    appliedBy: string | null;
    reason: string | null;
  };
  feedbackSummary: {
    helpfulCount: number;
    notUsefulCount: number;
    wrongDirectionCount: number;
    commentCount: number;
  };
  feedbackStateForViewer: InterventionPolicyRecommendationFeedbackValue | null;
}

export type InterventionPolicyRecommendationsView =
  | {
      status: "missing_snapshot";
      canRegenerate: true;
    }
  | {
      status: "active" | "degraded";
      snapshot: {
        id: string;
        officeId: string;
        status: "active" | "degraded";
        generatedAt: string;
        staleAt: string;
        supersededAt: string | null;
      };
      recommendations: InterventionPolicyRecommendation[];
    };

export interface InterventionPolicyRecommendationEvaluationSummary {
  window: "last_7_days" | "last_30_days" | "last_90_days";
  generatedAt: string;
  filters: {
    taxonomy: InterventionPolicyRecommendation["taxonomy"] | null;
    decision: InterventionPolicyRecommendationDecisionStatus | null;
  };
  totals: {
    qualifiedRendered: number;
    qualifiedSuppressedByCap: number;
    suppressedByThreshold: number;
    suppressedByPredicate: number;
    suppressedByMissingTarget: number;
    suppressedByApplyIneligible: number;
  };
  byTaxonomy: Array<{
    taxonomy: InterventionPolicyRecommendation["taxonomy"];
    counts: InterventionPolicyRecommendationEvaluationSummary["totals"];
  }>;
  feedback: Array<{
    taxonomy: InterventionPolicyRecommendation["taxonomy"];
    helpfulCount: number;
    notUsefulCount: number;
    wrongDirectionCount: number;
  }>;
  apply: Array<{
    taxonomy: InterventionPolicyRecommendation["taxonomy"];
    appliedCount: number;
    appliedNoopCount: number;
    rejectedCount: number;
  }>;
}

export type InterventionPolicyRecommendationReviewWindow =
  InterventionPolicyRecommendationEvaluationSummary["window"];

export type InterventionPolicyRecommendationReviewDecisionFilter = "all" | "rendered" | "suppressed";

export type InterventionPolicyRecommendationHistoryEventType =
  | "rendered"
  | InterventionPolicyRecommendationApplyEventStatus;

export interface InterventionPolicyRecommendationHistoryEntry {
  recommendationId: string;
  snapshotId: string;
  taxonomy: InterventionPolicyRecommendation["taxonomy"];
  title: string;
  eventType: InterventionPolicyRecommendationHistoryEventType;
  actorName: string | null;
  summary: string;
  occurredAt: string;
}

export type InterventionPolicyRecommendationTuningAction =
  | "hold_thresholds"
  | "lower_qualification_floor"
  | "review_ranking_cap"
  | "seed_more_history";

export interface InterventionPolicyRecommendationTuningGuidanceEntry {
  taxonomy: InterventionPolicyRecommendation["taxonomy"];
  recommendedAction: InterventionPolicyRecommendationTuningAction;
  summary: string;
}

export interface InterventionPolicyRecommendationReviewRow {
  taxonomy: InterventionPolicyRecommendation["taxonomy"];
  groupingKey: string;
  decision: InterventionPolicyRecommendationDecisionStatus;
  suppressionReason: string | null;
  score: number | null;
  confidence: InterventionPolicyRecommendation["confidence"] | null;
  usedFallbackCopy: boolean;
  usedFallbackStructuredPayload: boolean;
  createdAt: string | null;
}

export interface InterventionPolicyRecommendationReviewModel {
  snapshot: {
    id: string;
    officeId: string;
    status: "active" | "degraded";
    generatedAt: string;
    staleAt: string;
    supersededAt: string | null;
  } | null;
  summary: InterventionPolicyRecommendationEvaluationSummary;
  emptyStateScope: "latest_snapshot";
  emptyStateReason: string | null;
  latestDecisionRows: InterventionPolicyRecommendationReviewRow[];
  recentHistory: InterventionPolicyRecommendationHistoryEntry[];
  tuning: {
    currentThresholds: {
      qualificationFloor: number;
      strongRecommendationFloor: number;
      primaryCap: number;
      secondaryCap: number;
    };
    guidance: InterventionPolicyRecommendationTuningGuidanceEntry[];
  };
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

export function useAiOpsQuery<T>(path: string, errorMessage = "Failed to load AI ops data") {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await api<T>(path);
      setData(response);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : errorMessage);
    } finally {
      setLoading(false);
    }
  }, [errorMessage, path]);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  return {
    data,
    loading,
    error,
    refetch: fetchData,
  };
}

export function useInterventionAnalytics() {
  return useAiOpsQuery<InterventionAnalyticsDashboard>(
    "/ai/ops/intervention-analytics",
    "Failed to load intervention analytics"
  );
}

export function useInterventionPolicyRecommendations() {
  const [data, setData] = useState<InterventionPolicyRecommendationsView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestVersionRef = useRef(0);

  const fetchData = useCallback(async () => {
    const requestVersion = ++requestVersionRef.current;
    setLoading(true);
    setError(null);
    try {
      const response = await api<InterventionPolicyRecommendationsView>("/ai/ops/intervention-policy-recommendations");
      if (requestVersion !== requestVersionRef.current) return;
      setData(response);
    } catch (err: unknown) {
      if (requestVersion !== requestVersionRef.current) return;
      setError(err instanceof Error ? err.message : "Failed to load policy recommendations");
    } finally {
      if (requestVersion === requestVersionRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  return {
    data,
    loading,
    error,
    refetch: fetchData,
  };
}

export function useInterventionPolicyRecommendationReview(input?: {
  window?: InterventionPolicyRecommendationReviewWindow;
  decision?: InterventionPolicyRecommendationReviewDecisionFilter;
}) {
  const window = input?.window ?? "last_30_days";
  const decision = input?.decision ?? "all";
  return useAiOpsQuery<InterventionPolicyRecommendationReviewModel>(
    `/ai/ops/intervention-policy-recommendations/review?window=${window}&decision=${decision}`,
    "Failed to load recommendation review"
  );
}

function isMissingManagerAlertSnapshotError(error: unknown) {
  return error instanceof Error && error.message === "Manager alert snapshot not found";
}

export function useManagerAlertSnapshot() {
  const [data, setData] = useState<ManagerAlertSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestVersionRef = useRef(0);

  const fetchData = useCallback(async () => {
    const requestVersion = ++requestVersionRef.current;
    setLoading(true);
    setError(null);
    try {
      const response = await api<ManagerAlertSnapshot>("/ai/ops/intervention-manager-alerts");
      if (requestVersion !== requestVersionRef.current) return;
      setData(response);
    } catch (err: unknown) {
      if (requestVersion !== requestVersionRef.current) return;
      if (isMissingManagerAlertSnapshotError(err)) {
        setData(null);
        setError(null);
      } else {
        setError(err instanceof Error ? err.message : "Failed to load manager alert snapshot");
      }
    } finally {
      if (requestVersion === requestVersionRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  return {
    data,
    loading,
    error,
    refetch: fetchData,
  };
}

export async function runManagerAlertScan() {
  return api<ManagerAlertSnapshot>("/ai/ops/intervention-manager-alerts/scan", {
    method: "POST",
    json: {},
  });
}

export async function sendManagerAlertSummary() {
  return api<ManagerAlertSendResult>("/ai/ops/intervention-manager-alerts/send", {
    method: "POST",
    json: {},
  });
}

export async function regenerateInterventionPolicyRecommendations() {
  return api<{ queued: true; snapshotId: string; status: string }>(
    "/ai/ops/intervention-policy-recommendations/regenerate",
    {
      method: "POST",
      json: {},
    }
  );
}

export async function submitInterventionPolicyRecommendationFeedback(input: {
  recommendationId: string;
  feedbackValue: InterventionPolicyRecommendationFeedbackValue;
  comment?: string | null;
}) {
  return api<{
    recommendationId: string;
    feedbackValue: InterventionPolicyRecommendationFeedbackValue;
    comment: string | null;
  }>(`/ai/ops/intervention-policy-recommendations/${input.recommendationId}/feedback`, {
    method: "POST",
    json: {
      feedbackValue: input.feedbackValue,
      comment: input.comment ?? null,
    },
  });
}

export async function applyInterventionPolicyRecommendation(input: {
  recommendationId: string;
  snapshotId: string;
  recommendationIdempotencyKey: string;
}) {
  return api<{
    status: InterventionPolicyRecommendationApplyEventStatus;
    applyEventId: string;
    recommendationId: string;
    snapshotId: string;
    applyStatus: InterventionPolicyRecommendationApplyEventStatus;
    appliedAt: string | null;
    appliedBy: string | null;
    reason: string | null;
    beforeState: Record<string, unknown>;
    proposedState: Record<string, unknown>;
    appliedState: Record<string, unknown>;
  }>(`/ai/ops/intervention-policy-recommendations/${input.recommendationId}/apply`, {
    method: "POST",
    json: {
      snapshotId: input.snapshotId,
      recommendationIdempotencyKey: input.recommendationIdempotencyKey,
    },
  });
}

export async function revertInterventionPolicyRecommendation(input: {
  recommendationId: string;
  snapshotId: string;
  recommendationIdempotencyKey: string;
}) {
  return api<{
    status: InterventionPolicyRecommendationApplyEventStatus;
    applyEventId: string;
    recommendationId: string;
    snapshotId: string;
    applyStatus: InterventionPolicyRecommendationApplyEventStatus;
    appliedAt: string | null;
    appliedBy: string | null;
    reason: string | null;
    beforeState: Record<string, unknown>;
    proposedState: Record<string, unknown>;
    appliedState: Record<string, unknown>;
  }>(`/ai/ops/intervention-policy-recommendations/${input.recommendationId}/revert`, {
    method: "POST",
    json: {
      snapshotId: input.snapshotId,
      recommendationIdempotencyKey: input.recommendationIdempotencyKey,
    },
  });
}

export async function getInterventionPolicyRecommendationEvaluationSummary(input?: {
  window?: "last_7_days" | "last_30_days" | "last_90_days";
  taxonomy?: InterventionPolicyRecommendation["taxonomy"] | null;
  decision?: InterventionPolicyRecommendationDecisionStatus | null;
}) {
  const params = new URLSearchParams();
  if (input?.window) params.set("window", input.window);
  if (input?.taxonomy) params.set("taxonomy", input.taxonomy);
  if (input?.decision) params.set("decision", input.decision);
  const query = params.toString();
  return api<InterventionPolicyRecommendationEvaluationSummary>(
    `/ai/ops/intervention-policy-recommendations/evaluation${query ? `?${query}` : ""}`
  );
}

export async function getInterventionPolicyRecommendationReview(input?: {
  window?: InterventionPolicyRecommendationReviewWindow;
  decision?: InterventionPolicyRecommendationReviewDecisionFilter;
}) {
  const params = new URLSearchParams();
  if (input?.window) params.set("window", input.window);
  if (input?.decision) params.set("decision", input.decision);
  const query = params.toString();
  return api<InterventionPolicyRecommendationReviewModel>(
    `/ai/ops/intervention-policy-recommendations/review${query ? `?${query}` : ""}`
  );
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

export async function queueAiDisconnectAdminTasks(mode = "manual") {
  return api<QueueAiDisconnectDigestResult>("/ai/ops/disconnect-admin-tasks", {
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
  const salesProcessDisconnectDashboardTargetId = "42e5f8ee-a758-4cf5-9f3f-c8ec4fef3d86";

  return api("/ai/feedback", {
    method: "POST",
    json: {
      targetType: "ops_dashboard",
      targetId: salesProcessDisconnectDashboardTargetId,
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
