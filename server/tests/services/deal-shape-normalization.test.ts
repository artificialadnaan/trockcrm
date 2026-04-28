import { describe, expect, it } from "vitest";
import {
  CANONICAL_DEAL_SHAPE_FIELDS,
  dealShapeKeys,
  diffDealShapeFields,
  normalizeDealShape,
} from "../../src/services/dealShapeNormalization.js";

describe("deal shape normalization", () => {
  it("normalizes imported deal rows to the same JSON field set as new CRM deals", () => {
    const newDeal = normalizeDealShape({
      id: "new-1",
      dealNumber: "TR-2026-0001",
      name: "New CRM Deal",
      stageId: "stage-1",
      assignedRepId: "rep-1",
      sourceLeadId: "lead-1",
      companyId: "company-1",
      propertyId: "property-1",
      workflowRoute: "normal",
      pipelineDisposition: "deals",
      stageEnteredAt: new Date("2026-04-28T00:00:00Z"),
      createdAt: new Date("2026-04-28T00:00:00Z"),
      updatedAt: new Date("2026-04-28T00:00:00Z"),
    });

    const importedDeal = normalizeDealShape({
      id: "imported-1",
      dealNumber: "TR-2026-0002",
      name: "Imported Deal",
      stageId: "stage-1",
      assignedRepId: "rep-1",
      bidEstimate: "5000",
      hubspotDealId: "hs-1",
      stageEnteredAt: new Date("2026-04-28T00:00:00Z"),
      createdAt: new Date("2026-04-28T00:00:00Z"),
      updatedAt: new Date("2026-04-28T00:00:00Z"),
    });

    expect(dealShapeKeys(newDeal)).toEqual(dealShapeKeys(importedDeal));
    expect(dealShapeKeys(importedDeal)).toEqual([...CANONICAL_DEAL_SHAPE_FIELDS].sort());
  });

  it("prints field-level presence and type differences for sampled deals", () => {
    const diff = diffDealShapeFields(
      { id: "new-1", dealNumber: "TR-1", name: "New", stageId: "stage-1", assignedRepId: "rep-1" },
      { id: "imported-1", dealNumber: "TR-2", name: "Imported", stageId: "stage-1", assignedRepId: "rep-1", hubspotDealId: "hs-1" }
    );

    expect(diff).toContainEqual(expect.objectContaining({
      field: "hubspotDealId",
      newPresent: false,
      importedPresent: true,
    }));
  });
});
