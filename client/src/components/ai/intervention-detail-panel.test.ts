import { describe, expect, it } from "vitest";
import { getInterventionDetailMutationOutcome } from "./intervention-detail-panel";

describe("getInterventionDetailMutationOutcome", () => {
  it("treats a successful detail update as a refresh-and-clear path", () => {
    expect(
      getInterventionDetailMutationOutcome({
        updatedCount: 1,
        skippedCount: 0,
        errors: [],
      })
    ).toEqual({
      summary: {
        tone: "success",
        message: "Updated 1 intervention case",
      },
      shouldRefreshDetail: true,
      shouldClearNotes: true,
    });
  });

  it("keeps the panel state intact when a detail action is skipped", () => {
    expect(
      getInterventionDetailMutationOutcome({
        updatedCount: 0,
        skippedCount: 1,
        errors: [{ caseId: "case-1", message: "Case already resolved" }],
      })
    ).toEqual({
      summary: {
        tone: "error",
        message: "No intervention cases were updated. 1 case skipped. Errors: case-1: Case already resolved",
      },
      shouldRefreshDetail: false,
      shouldClearNotes: false,
    });
  });

  it("marks partial updates as warnings while still refreshing the detail view", () => {
    expect(
      getInterventionDetailMutationOutcome({
        updatedCount: 1,
        skippedCount: 1,
        errors: [{ caseId: "case-2", message: "Case locked by another operator" }],
      })
    ).toEqual({
      summary: {
        tone: "warning",
        message: "Updated 1 intervention case. 1 case skipped. Errors: case-2: Case locked by another operator",
      },
      shouldRefreshDetail: true,
      shouldClearNotes: true,
    });
  });
});
