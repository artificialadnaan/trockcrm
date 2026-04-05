import { describe, expect, it } from "vitest";
import {
  filterKnownStageGateValues,
  toggleStageGateValue,
  STAGE_GATE_APPROVAL_OPTIONS,
  STAGE_GATE_DOCUMENT_OPTIONS,
  STAGE_GATE_FIELD_OPTIONS,
} from "./stage-gate-options";

describe("stage gate option helpers", () => {
  it("keeps only known values that exist in the option list", () => {
    expect(
      filterKnownStageGateValues(["bidEstimate", "unknown", "projectTypeId"], STAGE_GATE_FIELD_OPTIONS)
    ).toEqual(["bidEstimate", "projectTypeId"]);
  });

  it("toggles values on and off without duplicating them", () => {
    expect(toggleStageGateValue(["bidEstimate"], "projectTypeId")).toEqual([
      "bidEstimate",
      "projectTypeId",
    ]);
    expect(toggleStageGateValue(["bidEstimate", "projectTypeId"], "bidEstimate")).toEqual([
      "projectTypeId",
    ]);
  });

  it("publishes the supported approval and document choices for the editor", () => {
    expect(STAGE_GATE_APPROVAL_OPTIONS.map((option) => option.value)).toEqual(["director", "admin"]);
    expect(STAGE_GATE_DOCUMENT_OPTIONS.some((option) => option.value === "contract")).toBe(true);
    expect(STAGE_GATE_FIELD_OPTIONS.some((option) => option.value === "expectedCloseDate")).toBe(true);
  });
});
