import { describe, expect, it } from "vitest";
import {
  buildStaleLeadAlertSummary,
} from "./stale-lead-dashboard";

describe("stale lead dashboard helpers", () => {
  it("builds a leadership alert summary from a stale lead row", () => {
    expect(
      buildStaleLeadAlertSummary(
        {
          leadId: "lead-1",
          leadName: "Austin Medical Center",
          companyName: "Acme Facilities",
          propertyName: "Austin North",
          stageName: "Qualified",
          repName: "Jamie Fox",
          daysInStage: 19,
        },
        "No stale leads",
        "Everything is moving"
      )
    ).toEqual({
      title: "Austin Medical Center",
      detail: "19d stale - Jamie Fox - Qualified",
    });
  });

  it("returns the fallback messaging when no stale lead is available", () => {
    expect(
      buildStaleLeadAlertSummary(
        null,
        "Lead pipeline on track",
        "No current stale leads detected today"
      )
    ).toEqual({
      title: "Lead pipeline on track",
      detail: "No current stale leads detected today",
    });
  });
});
