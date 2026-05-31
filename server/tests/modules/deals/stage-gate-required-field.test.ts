import { describe, expect, it } from "vitest";
import { isStageRequiredFieldSatisfied } from "../../../src/modules/deals/stage-gate.js";

// The stage gate requires a USABLE expected_close_date, not just any value: a stale PAST date must
// NOT satisfy the gate (otherwise the going-to-close projection keeps reading unusable past data --
// the exact production case this enforces). Other required fields are satisfied by any non-empty value.
describe("isStageRequiredFieldSatisfied", () => {
  const TODAY = "2026-05-31";

  it("rejects null / empty for any field", () => {
    expect(isStageRequiredFieldSatisfied("projectTypeId", null, TODAY)).toBe(false);
    expect(isStageRequiredFieldSatisfied("projectTypeId", "", TODAY)).toBe(false);
    expect(isStageRequiredFieldSatisfied("expectedCloseDate", null, TODAY)).toBe(false);
    expect(isStageRequiredFieldSatisfied("expectedCloseDate", "", TODAY)).toBe(false);
  });

  it("accepts any non-empty value for a non-date field", () => {
    expect(isStageRequiredFieldSatisfied("projectTypeId", "pt-1", TODAY)).toBe(true);
    expect(isStageRequiredFieldSatisfied("propertyAddress", "123 Main", TODAY)).toBe(true);
  });

  it("requires expectedCloseDate to be a usable (today-or-future) date", () => {
    expect(isStageRequiredFieldSatisfied("expectedCloseDate", "2026-05-30", TODAY)).toBe(false); // stale past
    expect(isStageRequiredFieldSatisfied("expectedCloseDate", "2026-05-31", TODAY)).toBe(true); // today
    expect(isStageRequiredFieldSatisfied("expectedCloseDate", "2026-12-01", TODAY)).toBe(true); // future
    expect(isStageRequiredFieldSatisfied("expectedCloseDate", new Date("2026-12-01T00:00:00.000Z"), TODAY)).toBe(true);
    expect(isStageRequiredFieldSatisfied("expectedCloseDate", "not-a-date", TODAY)).toBe(false);
  });
});
