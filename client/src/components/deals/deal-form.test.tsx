import { describe, expect, it } from "vitest";
import dealFormSource from "./deal-form.tsx?raw";

function normalize(source: string) {
  return source.replace(/\s+/g, " ").trim();
}

describe("DealForm select labels", () => {
  it("renders explicit user-facing labels for selected ids", () => {
    const source = normalize(dealFormSource);

    expect(source).toContain('getSelectedOptionLabel(assigneeOptions, formData.assignedRepId');
    expect(source).toContain('getSelectedOptionLabel(activeStages, formData.stageId, "Select stage")');
    expect(source).toContain('getSelectedOptionLabel(projectTypeOptions, formData.projectTypeId, "Select type")');
    expect(source).toContain('getSelectedOptionLabel(regions, formData.regionId, "Select region")');
  });

  it("includes assignedRepId in the create payload", () => {
    const source = normalize(dealFormSource);

    expect(source).toContain('payload.assignedRepId = formData.assignedRepId;');
    expect(source).toContain('Assigned sales rep is required');
  });

  it("sends migrationMode for legacy deal edits without source lead lineage", () => {
    const source = normalize(dealFormSource);

    expect(source).toContain('if (!deal.sourceLeadId) { payload.migrationMode = true; }');
  });

  it("sends direct creation context and uses the lead source dropdown options", () => {
    const source = normalize(dealFormSource);

    expect(source).toContain('payload.creationContext = "direct";');
    expect(source).toContain('formData.source === "Other"');
    expect(source).toContain("sourceDetail");
    expect(source).toContain("LEAD_SOURCE_CATEGORIES.map");
    expect(source).not.toContain("Bid Board, Referral, Cold Call");
  });

  it("renders Office directly before Project Type and injects selected office context", () => {
    const source = normalize(dealFormSource);

    expect(source).toContain("useAccessibleOffices");
    expect(source.indexOf("Office")).toBeLessThan(source.indexOf("Project Type"));
    expect(source).toContain('setError("Cannot create deal: selected office is unavailable. Contact admin.");');
    expect(source).toContain("payload.officeCode = formData.officeCode;");
    expect(source).toContain("{ officeId: selectedOffice.officeId }");
    expect(source).toContain("payload.projectType = selectedProjectType.name;");
  });
});
