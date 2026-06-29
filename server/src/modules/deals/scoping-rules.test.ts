import { describe, expect, it } from "vitest";
import { evaluateScopingReadiness } from "./scoping-rules.js";

// Once a visit is expected (siteVisitDecision = required/scheduled/reviewing) the opportunity gate
// makes "Site Visit Completed" a required field. Any non-empty value satisfies it, so a
// scheduled-but-not-yet-done visit ("scheduled") must let the RFP trigger — Pending (empty) must not.
function siteVisitCompletedMissing(siteVisitCompleted: string): boolean {
  const snapshot = evaluateScopingReadiness({
    currentStatus: "draft",
    workflowRoute: "normal",
    projectTypeId: null,
    sectionData: {
      opportunity: {
        preBidMeetingCompleted: "completed",
        siteVisitDecision: "scheduled",
        siteVisitCompleted,
      },
    },
    attachmentKeys: [],
  });
  return (snapshot.completionState.opportunity?.missingFields ?? []).includes("siteVisitCompleted");
}

describe("opportunity gate — Site Visit Completed", () => {
  it("accepts 'scheduled' as a valid answer (gate satisfied → RFP can trigger)", () => {
    expect(siteVisitCompletedMissing("scheduled")).toBe(false);
  });

  it("accepts 'completed'", () => {
    expect(siteVisitCompletedMissing("completed")).toBe(false);
  });

  it("treats Pending (empty) as missing when a visit is expected", () => {
    expect(siteVisitCompletedMissing("")).toBe(true);
  });
});
