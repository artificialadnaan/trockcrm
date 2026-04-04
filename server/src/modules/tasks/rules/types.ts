export type TaskPriorityBand = "low" | "normal" | "high" | "urgent";

export interface PriorityScoreInput {
  dueProximity: number;
  stageRisk: number;
  staleAge: number;
  unreadInbound: number;
  dealValue: number;
}

export interface PriorityScoreResult {
  score: number;
  band: TaskPriorityBand;
}

export interface AssignmentContext {
  entityId: string;
  manualOverrideId?: string | null;
  dealOwnerId?: string | null;
  contactLinkedRepId?: string | null;
  recentActorId?: string | null;
  officeFallbackId?: string | null;
}

export interface AssignmentReason {
  code: string;
  detail: string;
}

export interface AssignmentResult {
  assignedTo: string | null;
  machineReason: AssignmentReason;
}

export interface TaskRuleContext extends AssignmentContext {
  now: Date;
  officeId: string;
  sourceEvent: string;
  dealId?: string | null;
  dealName?: string | null;
  contactId?: string | null;
  emailId?: string | null;
  taskAssigneeId?: string | null;
  contactName?: string | null;
  emailSubject?: string | null;
  activeDealCount?: number | null;
  activeDealNames?: string[] | null;
  daysUntil?: number | null;
  noTouchDays?: number | null;
  stage?: string | null;
  dueAt?: Date | string | null;
  dealValue?: number | null;
  priority?: PriorityScoreInput | null;
  unreadInbound?: number | null;
  staleAge?: number | null;
}

export interface SystemTaskDraft {
  title: string;
  description?: string | null;
  type: string;
  assignedTo: string | null;
  officeId: string;
  originRule: string;
  sourceRule?: string | null;
  sourceEvent: string;
  dedupeKey: string;
  reasonCode: string;
  priority: TaskPriorityBand;
  priorityScore: number;
  status?: "pending" | "scheduled" | "in_progress" | "waiting_on" | "blocked";
  dueAt?: Date | string | null;
  entitySnapshot?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
  dealId?: string | null;
  contactId?: string | null;
  emailId?: string | null;
}

export interface TaskBusinessKey {
  originRule: string;
  dedupeKey: string;
}

export type TaskResolutionStatus = "completed" | "dismissed" | "suppressed";

export interface TaskResolutionStateRecord {
  originRule: string;
  dedupeKey: string;
  resolutionStatus: TaskResolutionStatus;
  resolvedAt?: Date | string | null;
  suppressedUntil?: Date | string | null;
}

export interface TaskRecord extends SystemTaskDraft {
  id: string;
  status: "pending" | "scheduled" | "in_progress" | "waiting_on" | "blocked";
}

export interface TaskRulePersistence {
  findOpenTaskByBusinessKey(key: TaskBusinessKey): Promise<TaskRecord | null>;
  findResolutionStateByBusinessKey(key: TaskBusinessKey): Promise<TaskResolutionStateRecord | null>;
  insertTask(draft: SystemTaskDraft): Promise<TaskRecord>;
  updateTask(taskId: string, draft: SystemTaskDraft): Promise<TaskRecord>;
}

export interface TaskRuleDefinition {
  id: string;
  sourceEvent: string;
  reasonCode: string;
  suppressionWindowDays: number;
  buildDedupeKey(context: TaskRuleContext): string | null;
  buildTask(context: TaskRuleContext): Promise<SystemTaskDraft | null> | SystemTaskDraft | null;
}

export type RuleEvaluationAction = "created" | "updated" | "skipped";

export interface RuleSkipReason {
  code: string;
  detail: string;
}

export interface RuleEvaluationOutcome {
  ruleId: string;
  businessKey?: TaskBusinessKey;
  action: RuleEvaluationAction;
  taskId?: string;
  reason?: RuleSkipReason;
}
