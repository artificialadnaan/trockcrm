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
  contactId?: string | null;
  emailId?: string | null;
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
  sourceEvent: string;
  dedupeKey: string;
  reasonCode: string;
  priority: TaskPriorityBand;
  priorityScore: number;
  status?: "pending" | "scheduled" | "in_progress" | "waiting_on" | "blocked";
  dueAt?: Date | string | null;
  metadata?: Record<string, unknown>;
}

export interface TaskBusinessKey {
  originRule: string;
  dedupeKey: string;
}

export interface TaskRecord extends SystemTaskDraft {
  id: string;
  status: "pending" | "scheduled" | "in_progress" | "waiting_on" | "blocked";
}

export interface TaskRulePersistence {
  findOpenTaskByBusinessKey(key: TaskBusinessKey): Promise<TaskRecord | null>;
  insertTask(draft: SystemTaskDraft): Promise<TaskRecord>;
  updateTask(taskId: string, draft: SystemTaskDraft): Promise<TaskRecord>;
}

export interface TaskRuleDefinition {
  id: string;
  sourceEvent: string;
  reasonCode: string;
  buildDedupeKey(context: TaskRuleContext): string | null;
  buildTask(context: TaskRuleContext): Promise<SystemTaskDraft | null> | SystemTaskDraft | null;
}

export type RuleEvaluationAction = "created" | "updated" | "skipped";

export interface RuleEvaluationOutcome {
  ruleId: string;
  businessKey?: TaskBusinessKey;
  action: RuleEvaluationAction;
  taskId?: string;
  reason?: string;
}
