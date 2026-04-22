import { describe, expect, it } from "vitest";

import {
  ESCALATION_TARGET_TYPES,
  REOPEN_REASONS,
  RESOLVE_OUTCOME_CATEGORY_TO_REASON_CODES,
  SNOOZE_REASON_TO_EXPECTED_OPTIONS,
  mapStructuredResolveReasonToLegacyResolutionReason,
} from "../../../src/modules/ai-copilot/intervention-outcome-taxonomy.js";

describe("intervention outcome taxonomy", () => {
  it("keeps resolve reason codes one-to-one with outcome categories", () => {
    expect(RESOLVE_OUTCOME_CATEGORY_TO_REASON_CODES.issue_fixed).toEqual([
      "customer_replied_and_owner_followed_up",
      "work_advanced_after_follow_up",
    ]);
    expect(RESOLVE_OUTCOME_CATEGORY_TO_REASON_CODES.task_completed).toEqual([
      "missing_task_created_and_completed",
    ]);
  });

  it("maps structured resolve reasons back to legacy resolution reasons during transition", () => {
    expect(mapStructuredResolveReasonToLegacyResolutionReason("owner_assigned_and_confirmed")).toBe("owner_aligned");
    expect(mapStructuredResolveReasonToLegacyResolutionReason("duplicate_case_consolidated")).toBe("duplicate_case");
  });

  it("defines valid snooze combinations and reopen reasons", () => {
    expect(SNOOZE_REASON_TO_EXPECTED_OPTIONS.waiting_on_external).toEqual({
      ownerTypes: ["external"],
      nextStepCodes: ["external_dependency_expected"],
    });
    expect(REOPEN_REASONS).toContain("resolution_did_not_hold");
    expect(ESCALATION_TARGET_TYPES).toContain("other");
  });
});
