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
  outcomeEffectiveness: InterventionOutcomeEffectiveness;
}
