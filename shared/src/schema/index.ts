// Public schema tables
export { offices } from "./public/offices.js";
export { users, userRoleEnum } from "./public/users.js";
export { userOfficeAccess } from "./public/user-office-access.js";
export { pipelineStageConfig } from "./public/pipeline-stage-config.js";
export { lostDealReasons } from "./public/lost-deal-reasons.js";
export { projectTypeConfig } from "./public/project-type-config.js";
export { regionConfig } from "./public/region-config.js";
export { savedReports, reportVisibilityEnum, reportEntityEnum } from "./public/saved-reports.js";
export { procoreSyncControls, procoreSyncModeEnum } from "./public/procore-sync-controls.js";
export { procoreReconciliationState, procoreReconciliationStatusEnum } from "./public/procore-reconciliation-state.js";
export { procoreSyncState, procoreEntityTypeEnum, syncDirectionEnum, syncStatusEnum } from "./public/procore-sync-state.js";
export { procoreWebhookLog } from "./public/procore-webhook-log.js";
export { userGraphTokens, graphTokenStatusEnum } from "./public/user-graph-tokens.js";
export { jobQueue, jobStatusEnum } from "./public/job-queue.js";

// Tenant schema tables (used for Drizzle type resolution when querying via tenantDb)
export { deals } from "./tenant/deals.js";
export { dealStageHistory } from "./tenant/deal-stage-history.js";
export { changeOrders, changeOrderStatusEnum } from "./tenant/change-orders.js";
export { dealApprovals, approvalStatusEnum } from "./tenant/deal-approvals.js";
export { companies } from "./tenant/companies.js";
export { contacts, contactCategoryEnum } from "./tenant/contacts.js";
export { contactDealAssociations } from "./tenant/contact-deal-associations.js";
export { duplicateQueue, duplicateMatchTypeEnum, duplicateStatusEnum } from "./tenant/duplicate-queue.js";
export { emails, emailDirectionEnum } from "./tenant/emails.js";
export { activities, activityTypeEnum } from "./tenant/activities.js";
export { files, fileCategoryEnum } from "./tenant/files.js";
export { tasks, taskTypeEnum, taskPriorityEnum, taskStatusEnum } from "./tenant/tasks.js";
export { taskResolutionState, taskResolutionStatusEnum } from "./tenant/task-resolution-state.js";
export { notifications, notificationTypeEnum } from "./tenant/notifications.js";
export { auditLog, auditActionEnum } from "./tenant/audit-log.js";

// Migration schema tables (staging area for HubSpot data migration)
export { stagedDeals } from "./migration/staged-deals.js";
export { stagedContacts } from "./migration/staged-contacts.js";
export { stagedActivities } from "./migration/staged-activities.js";
export { importRuns } from "./migration/import-runs.js";
