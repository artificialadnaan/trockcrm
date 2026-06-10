import { ACTIVITY_TYPES, type ActivityType } from "@trock-crm/shared/types";

/**
 * Single source of truth: which backing table + selector feeds each action breakdown key.
 * Verified by action-sources.test.ts against the real schema enums. Only audit_log carries
 * impersonator_id, so only creates/edits can exclude impersonated writes (spec caveat).
 */
export const USAGE_ACTION_SOURCES = {
  creates: { table: "audit_log", auditAction: "insert", impersonationExcluded: true },
  edits: { table: "audit_log", auditAction: "update", impersonationExcluded: true },
  stage_moves: { table: "deal_stage_history", impersonationExcluded: false },
  uploads: { table: "files", impersonationExcluded: false },
  activities: {
    table: "activities",
    impersonationExcluded: false,
    types: ACTIVITY_TYPES as readonly ActivityType[],
  },
} as const;
