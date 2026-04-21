import { describe, expect, it } from "vitest";
import dealFormSource from "./deal-form.tsx?raw";

function normalize(source: string) {
  return source.replace(/\s+/g, " ").trim();
}

describe("DealForm select labels", () => {
  it("renders explicit user-facing labels for selected ids", () => {
    const source = normalize(dealFormSource);

    expect(source).toContain('getSelectedOptionLabel(activeStages, formData.stageId, "Select stage")');
    expect(source).toContain('getSelectedOptionLabel(projectTypeOptions, formData.projectTypeId, "Select type")');
    expect(source).toContain('getSelectedOptionLabel(regions, formData.regionId, "Select region")');
  });
});
