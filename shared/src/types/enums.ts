export const USER_ROLES = ["admin", "director", "rep"] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const DEAL_STAGES = [
  "dd",
  "opportunity",
  "estimate_in_progress",
  "service_estimating",
  "estimate_under_review",
  "estimate_sent_to_client",
  "service_estimate_under_review",
  "service_estimate_sent_to_client",
  "sent_to_production",
  "service_sent_to_production",
  "production_lost",
  "service_lost",
] as const;
export type DealStage = (typeof DEAL_STAGES)[number];

export const DEAL_ROUTE_VALUE_SOURCES = [
  "sales_estimated_opportunity_value",
  "procore_bidboard_estimate",
  "manual_override",
] as const;
export type DealRouteValueSource = (typeof DEAL_ROUTE_VALUE_SOURCES)[number];
export {
  SALES_WORKFLOW_ROUTES,
  WORKFLOW_FAMILIES,
  WORKFLOW_OUTCOME_CATEGORIES,
  WORKFLOW_ROUTES,
  WORKFLOW_SYSTEMS_OF_RECORD,
  type SalesWorkflowRoute,
  type WorkflowFamily,
  type WorkflowOutcomeCategory,
  type WorkflowRoute,
  type WorkflowSystemOfRecord,
} from "./workflow.js";

export const LEAD_STAGE_SLUGS = [
  "lead_new",
  "company_pre_qualified",
  "scoping_in_progress",
  "pre_qual_value_assigned",
  "lead_go_no_go",
  "qualified_for_opportunity",
  "lead_disqualified",
] as const;
export type LeadStageSlug = (typeof LEAD_STAGE_SLUGS)[number];

export const DEAL_PIPELINE_DISPOSITIONS = ["opportunity", "deals", "service"] as const;
export type DealPipelineDisposition = (typeof DEAL_PIPELINE_DISPOSITIONS)[number];

export const DEAL_SCOPING_INTAKE_STATUSES = ["draft", "ready", "activated"] as const;
export type DealScopingIntakeStatus = (typeof DEAL_SCOPING_INTAKE_STATUSES)[number];

export const LEAD_SCOPING_INTAKE_STATUSES = ["draft", "ready", "completed"] as const;
export type LeadScopingIntakeStatus = (typeof LEAD_SCOPING_INTAKE_STATUSES)[number];

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

export const LEAD_STATUSES = ["open", "converted", "disqualified"] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

export const LEAD_SOURCE_CATEGORIES = [
  "Data Mine",
  "Referral",
  "Existing",
  "Campaign",
  "Trade Show",
  "Sales Prospecting",
  "Other",
] as const;
export type LeadSourceCategory = (typeof LEAD_SOURCE_CATEGORIES)[number];

export const COMPANY_VERIFICATION_STATUSES = ["pending", "verified", "rejected", "not_required"] as const;
export type CompanyVerificationStatus = (typeof COMPANY_VERIFICATION_STATUSES)[number];

export const LEAD_VERIFICATION_STATUSES = [
  "not_required",
  "pending",
  "approved",
  "rejected",
] as const;
export type LeadVerificationStatus = (typeof LEAD_VERIFICATION_STATUSES)[number];

export const LEAD_VERIFICATION_REQUIRED_REASONS = [
  "new_company",
  "dormant_company",
  "active_company",
] as const;
export type LeadVerificationRequiredReason = (typeof LEAD_VERIFICATION_REQUIRED_REASONS)[number];

export const FORECAST_WINDOWS = [
  "30_days",
  "60_days",
  "90_days",
  "beyond_90",
  "uncommitted",
] as const;
export type ForecastWindow = (typeof FORECAST_WINDOWS)[number];

export const FORECAST_CATEGORIES = ["commit", "best_case", "pipeline"] as const;
export type ForecastCategory = (typeof FORECAST_CATEGORIES)[number];

export const SUPPORT_NEEDED_TYPES = [
  "leadership",
  "estimating",
  "operations",
  "executive_team",
] as const;
export type SupportNeededType = (typeof SUPPORT_NEEDED_TYPES)[number];

export const ACTIVITY_TYPES = [
  "call",
  "note",
  "meeting",
  "email",
  "task_completed",
  "voicemail",
  "lunch",
  "site_visit",
  "proposal_sent",
  "redline_review",
  "go_no_go",
  "follow_up",
  "support_request",
] as const;
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
  "manager_alert_summary",
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
  "client_services",
  "operations",
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
