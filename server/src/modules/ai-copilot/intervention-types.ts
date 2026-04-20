export interface InterventionQueueItem {
  id: string;
  businessKey: string;
  disconnectType: string;
  clusterKey: string | null;
  severity: string;
  status: "open" | "snoozed" | "resolved";
  escalated: boolean;
  reopenCount: number;
  ageDays: number;
  assignedTo: string | null;
  assignedToName: string | null;
  generatedTask: {
    id: string;
    status: string;
    assignedTo: string | null;
    assignedToName: string | null;
    title: string;
  } | null;
  deal: { id: string; dealNumber: string; name: string } | null;
  company: { id: string; name: string } | null;
  evidenceSummary: string | null;
  lastIntervention: { actionType: string; actedAt: string } | null;
}

export type InterventionQueueView =
  | "open"
  | "all"
  | "escalated"
  | "unassigned"
  | "aging"
  | "repeat"
  | "generated-task-pending"
  | "overdue"
  | "snooze-breached";

export interface InterventionQueueFilters {
  caseId?: string | null;
  severity?: string | null;
  disconnectType?: string | null;
  assigneeId?: string | null;
  repId?: string | null;
  companyId?: string | null;
  stageKey?: string | null;
}

export interface InterventionQueueResult {
  items: InterventionQueueItem[];
  totalCount: number;
  page: number;
  pageSize: number;
}

export interface InterventionCaseDetail {
  case: {
    id: string;
    businessKey: string;
    disconnectType: string;
    clusterKey: string | null;
    severity: string;
    status: "open" | "snoozed" | "resolved";
    assignedTo: string | null;
    assignedToName: string | null;
    generatedTaskId: string | null;
    escalated: boolean;
    snoozedUntil: string | null;
    reopenCount: number;
    lastDetectedAt: string;
    lastIntervenedAt: string | null;
    resolvedAt: string | null;
    resolutionReason: string | null;
    metadataJson: Record<string, unknown> | null;
  };
  generatedTask: {
    id: string;
    title: string;
    status: string;
    assignedTo: string | null;
    assignedToName: string | null;
  } | null;
  crm: {
    deal: { id: string; dealNumber: string; name: string } | null;
    company: { id: string; name: string } | null;
  };
  history: Array<{
    id: string;
    actionType: string;
    actedBy: string;
    actedByName: string | null;
    actedAt: string;
    fromStatus: string | null;
    toStatus: string | null;
    fromAssignee: string | null;
    fromAssigneeName: string | null;
    toAssignee: string | null;
    toAssigneeName: string | null;
    fromSnoozedUntil: string | null;
    toSnoozedUntil: string | null;
    notes: string | null;
    metadataJson: Record<string, unknown> | null;
  }>;
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

export interface StructuredResolveConclusion {
  kind: "resolve";
  outcomeCategory: string;
  reasonCode: string;
  effectiveness: "confirmed" | "likely" | "unclear";
  notes?: string | null;
}

export interface StructuredSnoozeConclusion {
  kind: "snooze";
  snoozeReasonCode: string;
  expectedOwnerType: string;
  expectedNextStepCode: string;
  notes?: string | null;
}

export interface StructuredEscalateConclusion {
  kind: "escalate";
  escalationReasonCode: string;
  escalationTargetType: string;
  urgency: "high" | "normal";
  notes?: string | null;
}

export type StructuredInterventionConclusion =
  | StructuredResolveConclusion
  | StructuredSnoozeConclusion
  | StructuredEscalateConclusion;

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
  conclusionMixByDisconnectType: Array<{
    key: string;
    resolveCount: number;
    snoozeCount: number;
    escalateCount: number;
  }>;
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

export type InterventionPolicyRecommendationTaxonomy =
  | "snooze_policy_adjustment"
  | "escalation_policy_adjustment"
  | "assignee_load_balancing"
  | "disconnect_playbook_change"
  | "monitor_only";

export type InterventionPolicyRecommendationConfidence = "high" | "medium" | "low";

export type InterventionPolicyRecommendationFeedbackValue =
  | "helpful"
  | "not_useful"
  | "wrong_direction";

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

export type InterventionPolicyRecommendationApplyEligibilityReason =
  | "eligible"
  | "read_only_taxonomy"
  | "low_confidence"
  | "missing_proposed_change";

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
  taxonomy: InterventionPolicyRecommendationTaxonomy;
  title: string;
  statement: string;
  whyNow: string;
  expectedImpact: string;
  confidence: InterventionPolicyRecommendationConfidence;
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
    reason: InterventionPolicyRecommendationApplyEligibilityReason;
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

export interface InterventionPolicyRecommendationSnapshotView {
  id: string;
  officeId: string;
  status: "active" | "degraded";
  generatedAt: string;
  staleAt: string;
  supersededAt: string | null;
}

export type InterventionPolicyRecommendationsView =
  | {
      status: "missing_snapshot";
      canRegenerate: true;
    }
  | {
      status: "active" | "degraded";
      snapshot: InterventionPolicyRecommendationSnapshotView;
      recommendations: InterventionPolicyRecommendation[];
    };

export interface InterventionPolicyRecommendationEvaluationSummary {
  window: "last_7_days" | "last_30_days" | "last_90_days";
  generatedAt: string;
  filters: {
    taxonomy: InterventionPolicyRecommendationTaxonomy | null;
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
    taxonomy: InterventionPolicyRecommendationTaxonomy;
    counts: InterventionPolicyRecommendationEvaluationSummary["totals"];
  }>;
  feedback: Array<{
    taxonomy: InterventionPolicyRecommendationTaxonomy;
    helpfulCount: number;
    notUsefulCount: number;
    wrongDirectionCount: number;
  }>;
  apply: Array<{
    taxonomy: InterventionPolicyRecommendationTaxonomy;
    appliedCount: number;
    appliedNoopCount: number;
    rejectedCount: number;
  }>;
}

export type InterventionPolicyRecommendationReviewWindow =
  InterventionPolicyRecommendationEvaluationSummary["window"];

export type InterventionPolicyRecommendationReviewDecisionFilter =
  | "all"
  | "rendered"
  | "suppressed";

export type InterventionPolicyRecommendationReviewScope = "latest_snapshot";

export type InterventionPolicyRecommendationHistoryEventType =
  | "rendered"
  | InterventionPolicyRecommendationApplyEventStatus;

export interface InterventionPolicyRecommendationHistoryEntry {
  recommendationId: string;
  snapshotId: string;
  taxonomy: InterventionPolicyRecommendationTaxonomy;
  title: string;
  eventType: InterventionPolicyRecommendationHistoryEventType;
  actorName: string | null;
  summary: string;
  occurredAt: string;
}

export type InterventionPolicyRecommendationYieldNextAction =
  | "hold_thresholds"
  | "review_threshold_floor"
  | "review_ranking_cap"
  | "review_target_coverage"
  | "seed_or_wait_for_more_history";

export type InterventionPolicyRecommendationQualificationBlocker =
  | "history_limited"
  | "threshold_limited"
  | "cap_limited"
  | "target_limited"
  | "eligibility_limited"
  | "healthy_low_volume";

export type InterventionPolicyRecommendationQualificationTuningAction =
  | "seed_non_prod_validation"
  | "review_threshold_floor_in_code"
  | "review_ranking_cap_in_code"
  | "review_target_coverage"
  | "review_apply_eligibility"
  | "hold_current_thresholds";

export type InterventionPolicyRecommendationTuningAction =
  | "hold_thresholds"
  | "lower_qualification_floor"
  | "review_ranking_cap"
  | "seed_more_history";

export interface InterventionPolicyRecommendationTuningGuidanceEntry {
  taxonomy: InterventionPolicyRecommendationTaxonomy;
  recommendedAction: InterventionPolicyRecommendationTuningAction;
  summary: string;
}

export interface InterventionPolicyRecommendationReviewRow {
  taxonomy: InterventionPolicyRecommendationTaxonomy;
  groupingKey: string;
  decision: InterventionPolicyRecommendationDecisionStatus;
  suppressionReason: string | null;
  score: number | null;
  confidence: InterventionPolicyRecommendationConfidence | null;
  usedFallbackCopy: boolean;
  usedFallbackStructuredPayload: boolean;
  createdAt: string | null;
}

export interface InterventionPolicyRecommendationTopSuppressedCandidate {
  groupingKey: string;
  decision: InterventionPolicyRecommendationDecisionStatus;
  suppressionReason: string | null;
  score: number | null;
  confidence: InterventionPolicyRecommendationConfidence | null;
  createdAt: string | null;
}

export interface InterventionPolicyRecommendationTaxonomyDiagnosticEntry {
  scope: "historical_window";
  taxonomy: InterventionPolicyRecommendationTaxonomy;
  renderedCount: number;
  suppressedCounts: {
    predicateBlocked: number;
    thresholdBlocked: number;
    capBlocked: number;
    missingTarget: number;
    applyIneligible: number;
  };
  dominantBlocker: InterventionPolicyRecommendationQualificationBlocker;
  topSuppressedCandidates: InterventionPolicyRecommendationTopSuppressedCandidate[];
  recommendedTuningAction: InterventionPolicyRecommendationQualificationTuningAction;
}

export type InterventionPolicyRecommendationThresholdCalibrationNoProposalReason =
  | "threshold_pressure_not_dominant"
  | "low_volume_dominates"
  | "predicate_failure_dominates"
  | "target_coverage_dominates"
  | "cap_pressure_dominates";

export interface InterventionPolicyRecommendationThresholdCalibrationBlockerEntry {
  label: string;
  count: number;
}

export interface InterventionPolicyRecommendationThresholdCalibrationProposal {
  taxonomy: InterventionPolicyRecommendationTaxonomy;
  currentThreshold: string;
  proposedThreshold: string;
  dominantBlocker: InterventionPolicyRecommendationQualificationBlocker;
  blockerBreakdown: InterventionPolicyRecommendationThresholdCalibrationBlockerEntry[];
  rationale: string;
  expectedYieldEffect: string;
  guardrails: string[];
  verificationChecklist: string[];
}

export interface InterventionPolicyRecommendationThresholdCalibrationProposalBlock {
  generatedAt: string;
  window: InterventionPolicyRecommendationReviewWindow;
  selectionSummary: string;
  noProposalReason: InterventionPolicyRecommendationThresholdCalibrationNoProposalReason | null;
  proposals: InterventionPolicyRecommendationThresholdCalibrationProposal[];
}

export interface InterventionPolicyRecommendationSeedValidationTaxonomyStatus {
  taxonomy: InterventionPolicyRecommendationTaxonomy;
  seedPathAvailable: boolean;
  seedKey: string | null;
  supportsApplyUndo: boolean;
}

export interface InterventionPolicyRecommendationSeedValidationStatus {
  scope: "non_production_only";
  validationMode: "manual_seed_script";
  scriptPath: string;
  taxonomies: InterventionPolicyRecommendationSeedValidationTaxonomyStatus[];
}

export interface InterventionPolicyRecommendationReviewModel {
  snapshot: InterventionPolicyRecommendationSnapshotView | null;
  summary: InterventionPolicyRecommendationEvaluationSummary;
  emptyStateScope: InterventionPolicyRecommendationReviewScope;
  emptyStateReason: string | null;
  latestDecisionRows: InterventionPolicyRecommendationReviewRow[];
  recentHistory: InterventionPolicyRecommendationHistoryEntry[];
  diagnostics: {
    window: InterventionPolicyRecommendationReviewWindow;
    generatedAt: string;
    systemDiagnostics: {
      scope: "historical_window";
      dominantBlockers: Array<{
        blocker: InterventionPolicyRecommendationQualificationBlocker;
        count: number;
      }>;
      recommendedNextAction: InterventionPolicyRecommendationQualificationTuningAction;
    };
    taxonomyDiagnostics: InterventionPolicyRecommendationTaxonomyDiagnosticEntry[];
    seededValidationStatus: InterventionPolicyRecommendationSeedValidationStatus;
  };
  yield: {
    renderedTotals: {
      window: InterventionPolicyRecommendationReviewWindow;
      total: number;
    };
    renderedByTaxonomy: Array<{
      taxonomy: InterventionPolicyRecommendationTaxonomy;
      renderedCount: number;
    }>;
    dominantSuppressionReasons: Array<{
      reason: string;
      count: number;
    }>;
    recommendedNextAction: InterventionPolicyRecommendationYieldNextAction;
  };
  tuning: {
    currentThresholds: {
      qualificationFloor: number;
      strongRecommendationFloor: number;
      primaryCap: number;
      secondaryCap: number;
    };
    guidance: InterventionPolicyRecommendationTuningGuidanceEntry[];
  };
  thresholdCalibrationProposals: InterventionPolicyRecommendationThresholdCalibrationProposalBlock;
}

export interface InterventionAnalyticsDashboard {
  summary: {
    openCases: number;
    overdueCases: number;
    escalatedCases: number;
    snoozeOverdueCases: number;
    repeatOpenCases: number;
    openCasesBySeverity: Record<"critical" | "high" | "medium" | "low", number>;
    overdueCasesBySeverity: Record<"critical" | "high" | "medium" | "low", number>;
  };
  outcomes: {
    clearanceRate30d: number | null;
    reopenRate30d: number | null;
    averageAgeOfOpenCases: number | null;
    medianAgeOfOpenCases: number | null;
    averageAgeToResolution: number | null;
    actionVolume30d: {
      assign: number;
      snooze: number;
      resolve: number;
      escalate: number;
    };
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
