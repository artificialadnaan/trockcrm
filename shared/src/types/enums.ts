export const USER_ROLES = ["admin", "director", "rep"] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const DEAL_STAGES = [
  "dd",
  "estimating",
  "bid_sent",
  "in_production",
  "close_out",
  "closed_won",
  "closed_lost",
] as const;
export type DealStage = (typeof DEAL_STAGES)[number];

export const CONTACT_CATEGORIES = [
  "client",
  "subcontractor",
  "architect",
  "property_manager",
  "regional_manager",
  "vendor",
  "consultant",
  "influencer",
  "other",
] as const;
export type ContactCategory = (typeof CONTACT_CATEGORIES)[number];

export const ACTIVITY_TYPES = ["call", "note", "meeting", "email", "task_completed"] as const;
export type ActivityType = (typeof ACTIVITY_TYPES)[number];

export const CALL_OUTCOMES = [
  "connected",
  "left_voicemail",
  "no_answer",
  "scheduled_meeting",
] as const;
export type CallOutcome = (typeof CALL_OUTCOMES)[number];

export const FILE_CATEGORIES = [
  "photo",
  "contract",
  "rfp",
  "estimate",
  "change_order",
  "proposal",
  "permit",
  "inspection",
  "correspondence",
  "insurance",
  "warranty",
  "closeout",
  "other",
] as const;
export type FileCategory = (typeof FILE_CATEGORIES)[number];

export const TASK_TYPES = [
  "follow_up",
  "stale_deal",
  "inbound_email",
  "approval_request",
  "touchpoint",
  "manual",
  "system",
] as const;
export type TaskType = (typeof TASK_TYPES)[number];

export const TASK_PRIORITIES = ["urgent", "high", "normal", "low"] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export const TASK_STATUSES = [
  "pending",
  "scheduled",
  "in_progress",
  "waiting_on",
  "blocked",
  "completed",
  "dismissed",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_RESOLUTION_STATUSES = [
  "completed",
  "dismissed",
  "suppressed",
] as const;
export type TaskResolutionStatus = (typeof TASK_RESOLUTION_STATUSES)[number];

export const NOTIFICATION_TYPES = [
  "stale_deal",
  "inbound_email",
  "task_assigned",
  "approval_needed",
  "activity_drop",
  "deal_won",
  "deal_lost",
  "stage_change",
  "touchpoint_alert",
  "system",
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export const PROCORE_ENTITY_TYPES = ["project", "bid", "change_order", "contact"] as const;
export type ProcoreEntityType = (typeof PROCORE_ENTITY_TYPES)[number];

export const SYNC_DIRECTIONS = ["crm_to_procore", "procore_to_crm", "bidirectional"] as const;
export type SyncDirection = (typeof SYNC_DIRECTIONS)[number];

export const SYNC_STATUSES = ["synced", "pending", "conflict", "error"] as const;
export type SyncStatus = (typeof SYNC_STATUSES)[number];

export const PROCORE_SYNC_MODES = ["active", "dry_run", "paused"] as const;
export type ProcoreSyncMode = (typeof PROCORE_SYNC_MODES)[number];

export const APPROVAL_STATUSES = ["pending", "approved", "rejected"] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export const CHANGE_ORDER_STATUSES = ["pending", "approved", "rejected"] as const;
export type ChangeOrderStatus = (typeof CHANGE_ORDER_STATUSES)[number];

export const REPORT_ENTITIES = ["deals", "contacts", "activities", "tasks"] as const;
export type ReportEntity = (typeof REPORT_ENTITIES)[number];

export const GRAPH_TOKEN_STATUSES = ["active", "expired", "revoked", "reauth_needed"] as const;
export type GraphTokenStatus = (typeof GRAPH_TOKEN_STATUSES)[number];

export const JOB_STATUSES = ["pending", "processing", "completed", "failed", "dead"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const VALIDATION_STATUSES = [
  "pending",
  "valid",
  "invalid",
  "needs_review",
  "approved",
  "rejected",
] as const;
export type ValidationStatus = (typeof VALIDATION_STATUSES)[number];

export const REPORT_VISIBILITY = ["private", "office", "company"] as const;
export type ReportVisibility = (typeof REPORT_VISIBILITY)[number];

export const DUPLICATE_MATCH_TYPES = [
  "exact_email",
  "fuzzy_name",
  "fuzzy_phone",
  "company_match",
] as const;
export type DuplicateMatchType = (typeof DUPLICATE_MATCH_TYPES)[number];

export const DUPLICATE_STATUSES = ["pending", "merged", "dismissed"] as const;
export type DuplicateStatus = (typeof DUPLICATE_STATUSES)[number];

export const EMAIL_DIRECTIONS = ["inbound", "outbound"] as const;
export type EmailDirection = (typeof EMAIL_DIRECTIONS)[number];

export const AUDIT_ACTIONS = ["insert", "update", "delete"] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export const DEAL_TEAM_ROLES = [
  "superintendent",
  "estimator",
  "project_manager",
  "foreman",
  "other",
] as const;
export type DealTeamRole = (typeof DEAL_TEAM_ROLES)[number];

export const PUNCH_LIST_TYPES = ["internal", "external"] as const;
export type PunchListType = (typeof PUNCH_LIST_TYPES)[number];

export const PUNCH_LIST_STATUSES = ["open", "in_progress", "completed"] as const;
export type PunchListStatus = (typeof PUNCH_LIST_STATUSES)[number];

export const PROPOSAL_STATUSES = [
  "not_started",
  "drafting",
  "sent",
  "under_review",
  "revision_requested",
  "accepted",
  "signed",
  "rejected",
] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

export const WORKFLOW_TIMER_TYPES = [
  "proposal_response",
  "estimate_review",
  "companycam_service",
  "final_billing",
  "custom",
] as const;
export type WorkflowTimerType = (typeof WORKFLOW_TIMER_TYPES)[number];

export const WORKFLOW_TIMER_STATUSES = ["active", "completed", "expired", "cancelled"] as const;
export type WorkflowTimerStatus = (typeof WORKFLOW_TIMER_STATUSES)[number];

export const ESTIMATING_SUBSTAGES = [
  "scope_review",
  "site_visit",
  "missing_info",
  "building_estimate",
  "under_review",
  "sent_to_client",
] as const;
export type EstimatingSubstage = (typeof ESTIMATING_SUBSTAGES)[number];
