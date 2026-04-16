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
  generatedTask: {
    id: string;
    status: string;
    assignedTo: string | null;
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
  } | null;
  crm: {
    deal: { id: string; dealNumber: string; name: string } | null;
    company: { id: string; name: string } | null;
  };
  history: Array<{
    id: string;
    actionType: string;
    actedBy: string;
    actedAt: string;
    fromStatus: string | null;
    toStatus: string | null;
    fromAssignee: string | null;
    toAssignee: string | null;
    fromSnoozedUntil: string | null;
    toSnoozedUntil: string | null;
    notes: string | null;
    metadataJson: Record<string, unknown> | null;
  }>;
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
}
