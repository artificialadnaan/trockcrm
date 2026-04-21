import { describe, expect, it } from "vitest";
import { AppError } from "../../../src/middleware/error-handler.js";
import {
  normalizeStageGateValues,
  STAGE_GATE_ALLOWED_APPROVALS,
  STAGE_GATE_ALLOWED_DOCUMENTS,
  STAGE_GATE_ALLOWED_FIELDS,
} from "../../../src/modules/admin/pipeline-service.js";

describe("pipeline stage gate validation", () => {
  it("trims, dedupes, and preserves first-seen order for valid values", () => {
    const result = normalizeStageGateValues(
      [" bidEstimate ", "projectTypeId", "bidEstimate", ""],
      STAGE_GATE_ALLOWED_FIELDS,
      "requiredFields"
    );

    expect(result).toEqual(["bidEstimate", "projectTypeId"]);
  });

  it("rejects unknown required field values", () => {
    expect(() =>
      normalizeStageGateValues(
        ["notARealField"],
        STAGE_GATE_ALLOWED_FIELDS,
        "requiredFields"
      )
    ).toThrowError(AppError);
  });

  it("rejects unknown document categories", () => {
    expect(() =>
      normalizeStageGateValues(
        ["invoice"],
        STAGE_GATE_ALLOWED_DOCUMENTS,
        "requiredDocuments"
      )
    ).toThrowError("Unknown requiredDocuments value: invoice");
  });

  it("rejects approval roles outside the allowed gate roles", () => {
    expect(() =>
      normalizeStageGateValues(
        ["rep"],
        STAGE_GATE_ALLOWED_APPROVALS,
        "requiredApprovals"
      )
    ).toThrowError("Unknown requiredApprovals value: rep");
  });

  it("accepts canonical lead and opportunity workflow gate fields", () => {
    const result = normalizeStageGateValues(
      [
        "estimatedOpportunityValue",
        "qualification.stakeholderRole",
        "scopingSubset.projectOverview",
        "opportunity.preBidMeetingCompleted",
      ],
      STAGE_GATE_ALLOWED_FIELDS,
      "requiredFields"
    );

    expect(result).toEqual([
      "estimatedOpportunityValue",
      "qualification.stakeholderRole",
      "scopingSubset.projectOverview",
      "opportunity.preBidMeetingCompleted",
    ]);
  });
});
