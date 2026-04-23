export type ResolveConclusionPayload = {
  kind: "resolve";
  outcomeCategory: string;
  reasonCode: string;
  effectiveness: "confirmed" | "likely" | "unclear" | "";
  notes: string | null;
};

export type SnoozeConclusionPayload = {
  kind: "snooze";
  snoozeReasonCode: string;
  expectedOwnerType: string;
  expectedNextStepCode: string;
  snoozedUntil: string;
  notes: string | null;
};

export type EscalateConclusionPayload = {
  kind: "escalate";
  escalationReasonCode: string;
  escalationTargetType: string;
  urgency: "high" | "normal" | "";
  notes: string | null;
};

export const RESOLVE_OUTCOME_CATEGORY_TO_REASON_CODES = {
  issue_fixed: ["customer_replied_and_owner_followed_up", "work_advanced_after_follow_up"],
  owner_aligned: ["owner_assigned_and_confirmed"],
  task_completed: ["missing_task_created_and_completed"],
  duplicate_or_merged: ["duplicate_case_consolidated"],
  false_positive: ["signal_was_not_actionable"],
  no_longer_relevant: ["business_context_changed"],
} as const;

export const SNOOZE_REASON_TO_EXPECTED_OPTIONS = {
  waiting_on_customer: { ownerTypes: ["customer"], nextStepCodes: ["customer_reply_expected"] },
  waiting_on_rep: { ownerTypes: ["rep"], nextStepCodes: ["rep_follow_up_expected"] },
  waiting_on_estimating: { ownerTypes: ["estimating"], nextStepCodes: ["estimating_update_expected"] },
  waiting_on_manager_review: { ownerTypes: ["director"], nextStepCodes: ["manager_review_expected"] },
  waiting_on_external: { ownerTypes: ["external"], nextStepCodes: ["external_dependency_expected"] },
  timing_not_actionable_yet: { ownerTypes: ["admin", "director"], nextStepCodes: ["timing_window_reached"] },
  temporary_false_positive: { ownerTypes: ["admin", "director"], nextStepCodes: ["manager_review_expected"] },
} as const;

export const ESCALATION_TARGET_TYPES = ["director", "admin", "estimating_lead", "office_manager", "other"] as const;

export function mapStructuredResolveReasonToLegacyResolutionReason(reasonCode: string) {
  switch (reasonCode) {
    case "customer_replied_and_owner_followed_up":
    case "work_advanced_after_follow_up":
      return "follow_up_completed";
    case "owner_assigned_and_confirmed":
      return "owner_aligned";
    case "missing_task_created_and_completed":
      return "task_completed";
    case "duplicate_case_consolidated":
      return "duplicate_case";
    case "signal_was_not_actionable":
      return "false_positive";
    case "business_context_changed":
      return "issue_no_longer_relevant";
    default:
      return null;
  }
}
