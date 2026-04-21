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
export { procoreOauthTokens } from "./public/procore-oauth-tokens.js";
export { procoreWebhookLog } from "./public/procore-webhook-log.js";
export { userGraphTokens, graphTokenStatusEnum } from "./public/user-graph-tokens.js";
export { jobQueue, jobStatusEnum } from "./public/job-queue.js";
export {
  costCatalogSources,
  costCatalogSnapshotVersions,
  costCatalogSyncRuns,
} from "./public/cost-catalog-sources.js";
export {
  costCatalogCodes,
  costCatalogItemCodes,
  costCatalogItems,
  costCatalogPrices,
} from "./public/cost-catalog-items.js";

// Tenant schema tables (used for Drizzle type resolution when querying via tenantDb)
export { deals, workflowRouteEnum, proposalStatusEnum, estimatingSubstageEnum } from "./tenant/deals.js";
export { dealScopingIntake, dealScopingIntakeStatusEnum } from "./tenant/deal-scoping-intake.js";
export { dealStageHistory } from "./tenant/deal-stage-history.js";
export { changeOrders, changeOrderStatusEnum } from "./tenant/change-orders.js";
export { dealApprovals, approvalStatusEnum } from "./tenant/deal-approvals.js";
export { companies } from "./tenant/companies.js";
export { properties } from "./tenant/properties.js";
export { contacts, contactCategoryEnum } from "./tenant/contacts.js";
export { contactDealAssociations } from "./tenant/contact-deal-associations.js";
export { leads, leadStatusEnum } from "./tenant/leads.js";
export { leadStageHistory } from "./tenant/lead-stage-history.js";
export { duplicateQueue, duplicateMatchTypeEnum, duplicateStatusEnum } from "./tenant/duplicate-queue.js";
export { emails, emailDirectionEnum } from "./tenant/emails.js";
export { activities, activityTypeEnum } from "./tenant/activities.js";
export { files, fileCategoryEnum } from "./tenant/files.js";
export {
  estimateSourceDocuments,
  estimateDocumentParseRuns,
  estimateDocumentPages,
} from "./tenant/estimate-source-documents.js";
export {
  estimateExtractions,
  estimateExtractionMatches,
  estimateGenerationRuns,
  estimateReviewEvents,
} from "./tenant/estimate-extractions.js";
export { estimatePricingRecommendations } from "./tenant/estimate-pricing-recommendations.js";
export {
  estimatePricingRecommendationOptions,
} from "./tenant/estimate-pricing-recommendation-options.js";
export { tasks, taskTypeEnum, taskPriorityEnum, taskStatusEnum } from "./tenant/tasks.js";
export { taskResolutionState, taskResolutionStatusEnum } from "./tenant/task-resolution-state.js";
export { notifications, notificationTypeEnum } from "./tenant/notifications.js";
export { auditLog, auditActionEnum } from "./tenant/audit-log.js";
export { dealTeamMembers, dealTeamRoleEnum } from "./tenant/deal-team-members.js";
export { estimateSections } from "./tenant/estimate-sections.js";
export { estimateLineItems } from "./tenant/estimate-line-items.js";
export { punchListItems, punchListTypeEnum, punchListStatusEnum } from "./tenant/punch-list-items.js";
export { workflowTimers, workflowTimerTypeEnum, workflowTimerStatusEnum } from "./tenant/workflow-timers.js";
export { closeoutChecklistItems } from "./tenant/closeout-checklist-items.js";
export { aiDocumentIndex } from "./tenant/ai-document-index.js";
export { aiEmbeddingChunks } from "./tenant/ai-embedding-chunks.js";
export { aiCopilotPackets } from "./tenant/ai-copilot-packets.js";
export { aiTaskSuggestions } from "./tenant/ai-task-suggestions.js";
export { aiRiskFlags } from "./tenant/ai-risk-flags.js";
export { aiFeedback } from "./tenant/ai-feedback.js";
export { aiDisconnectCases } from "./tenant/ai-disconnect-cases.js";
export { aiDisconnectCaseHistory } from "./tenant/ai-disconnect-case-history.js";

// Migration schema tables (staging area for HubSpot data migration)
export { stagedDeals } from "./migration/staged-deals.js";
export { stagedContacts } from "./migration/staged-contacts.js";
export { stagedActivities } from "./migration/staged-activities.js";
export { stagedCompanies } from "./migration/staged-companies.js";
export { stagedProperties } from "./migration/staged-properties.js";
export { stagedLeads } from "./migration/staged-leads.js";
export { importRuns } from "./migration/import-runs.js";
