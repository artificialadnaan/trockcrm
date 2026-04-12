import { describe, expect, it } from "vitest";
import {
  buildValidationSummary,
  formatValidationMatchReason,
} from "./procore-validation-view-model";

describe("procore validation view model", () => {
  it("counts matched, ambiguous, and unmatched projects correctly", () => {
    expect(
      buildValidationSummary([
        { status: "matched" },
        { status: "matched" },
        { status: "unmatched" },
        { status: "ambiguous" },
      ])
    ).toEqual({
      matched: 2,
      ambiguous: 1,
      unmatched: 1,
      total: 4,
    });
  });

  it("formats match reasons into readable labels", () => {
    expect(formatValidationMatchReason("procore_project_id")).toBe("Linked by Procore project ID");
    expect(formatValidationMatchReason("duplicate_project_number")).toBe(
      "Ambiguous project number match"
    );
    expect(formatValidationMatchReason("none")).toBe("No CRM match");
  });
});
