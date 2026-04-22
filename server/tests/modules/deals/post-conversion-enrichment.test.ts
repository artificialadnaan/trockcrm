import { describe, expect, it, vi, beforeEach } from "vitest";
import { deals } from "../../../../shared/src/schema/tenant/deals.js";
import { dealApprovals } from "../../../../shared/src/schema/tenant/deal-approvals.js";
import { changeOrders } from "../../../../shared/src/schema/tenant/change-orders.js";
import { dealStageHistory } from "../../../../shared/src/schema/tenant/deal-stage-history.js";

const pipelineMocks = vi.hoisted(() => ({
  getStageById: vi.fn(),
}));

vi.mock("../../../src/modules/pipeline/service.js", () => ({
  getStageById: pipelineMocks.getStageById,
}));

vi.mock("@trock-crm/shared/schema", async () => {
  const [dealsModule, approvalsModule, changeOrdersModule, historyModule, pipelineStageModule] =
    await Promise.all([
      import("../../../../shared/src/schema/tenant/deals.js"),
      import("../../../../shared/src/schema/tenant/deal-approvals.js"),
      import("../../../../shared/src/schema/tenant/change-orders.js"),
      import("../../../../shared/src/schema/tenant/deal-stage-history.js"),
      import("../../../../shared/src/schema/public/pipeline-stage-config.js"),
    ]);

  return {
    ...dealsModule,
    ...approvalsModule,
    ...changeOrdersModule,
    ...historyModule,
    ...pipelineStageModule,
  };
});

import { getDealDetail } from "../../../src/modules/deals/service.js";
import { evaluatePostConversionEnrichment } from "../../../src/modules/deals/post-conversion-enrichment.js";

function createFakeTenantDb(state: {
  deals: Array<Record<string, unknown>>;
  dealStageHistory?: Array<Record<string, unknown>>;
  dealApprovals?: Array<Record<string, unknown>>;
  changeOrders?: Array<Record<string, unknown>>;
}) {
  const tableRows = new Map<unknown, Array<Record<string, unknown>>>([
    [deals, state.deals],
    [dealStageHistory, state.dealStageHistory ?? []],
    [dealApprovals, state.dealApprovals ?? []],
    [changeOrders, state.changeOrders ?? []],
  ]);

  return {
    select() {
      return {
        from(table: unknown) {
          const rows = tableRows.get(table) ?? [];
          return {
            where() {
              return this;
            },
            orderBy() {
              return this;
            },
            limit() {
              return this;
            },
            then(onfulfilled: (value: unknown[]) => unknown) {
              return Promise.resolve(rows.map((row) => ({ ...row }))).then(onfulfilled);
            },
          };
        },
      };
    },
  };
}

describe("evaluatePostConversionEnrichment", () => {
  beforeEach(() => {
    pipelineMocks.getStageById.mockReset();
  });

  it("treats trimmed next step as complete", () => {
    const result = evaluatePostConversionEnrichment(
      {
        sourceLeadId: "lead-1",
        isActive: true,
        stageId: "stage-opportunity",
        projectTypeId: "project-type-1",
        regionId: "region-1",
        expectedCloseDate: "2026-05-01",
        nextStep: "  Follow up with owner  ",
      },
      { slug: "opportunity", isTerminal: false }
    );

    expect(result.requiredFields).toEqual([
      "projectTypeId",
      "regionId",
      "expectedCloseDate",
      "nextStep",
    ]);
    expect(result.missingFields).toEqual([]);
    expect(result.isComplete).toBe(true);
    expect(result.applies).toBe(false);
  });

  it("returns missing fields for incomplete converted deals", () => {
    const result = evaluatePostConversionEnrichment(
      {
        sourceLeadId: "lead-1",
        isActive: true,
        stageId: "stage-later",
        projectTypeId: "project-type-1",
        regionId: null,
        expectedCloseDate: null,
        nextStep: "   ",
      },
      { slug: "proposal", isTerminal: false }
    );

    expect(result.applies).toBe(true);
    expect(result.isComplete).toBe(false);
    expect(result.missingFields).toEqual([
      "regionId",
      "expectedCloseDate",
      "nextStep",
    ]);
  });

  it("shows for manual opportunity deals while incomplete", () => {
    const result = evaluatePostConversionEnrichment(
      {
        sourceLeadId: null,
        isActive: true,
        stageId: "stage-opportunity",
        projectTypeId: null,
        regionId: "region-1",
        expectedCloseDate: null,
        nextStep: "Call back",
      },
      { slug: "opportunity", isTerminal: false }
    );

    expect(result.applies).toBe(true);
    expect(result.isComplete).toBe(false);
    expect(result.missingFields).toEqual(["projectTypeId", "expectedCloseDate"]);
  });

  it("hides for manual deals once they leave opportunity", () => {
    const result = evaluatePostConversionEnrichment(
      {
        sourceLeadId: null,
        isActive: true,
        stageId: "stage-qualify",
        projectTypeId: null,
        regionId: null,
        expectedCloseDate: null,
        nextStep: null,
      },
      { slug: "proposal", isTerminal: false }
    );

    expect(result.applies).toBe(false);
    expect(result.isComplete).toBe(false);
  });

  it("hides for inactive deals even if they are in a non-terminal stage", () => {
    const result = evaluatePostConversionEnrichment(
      {
        sourceLeadId: "lead-1",
        isActive: false,
        stageId: "stage-opportunity",
        projectTypeId: null,
        regionId: null,
        expectedCloseDate: null,
        nextStep: null,
      },
      { slug: "opportunity", isTerminal: false }
    );

    expect(result.applies).toBe(false);
  });

  it("hides for terminal deals", () => {
    const result = evaluatePostConversionEnrichment(
      {
        sourceLeadId: "lead-1",
        isActive: true,
        stageId: "stage-closed",
        projectTypeId: null,
        regionId: null,
        expectedCloseDate: null,
        nextStep: null,
      },
      { slug: "closed_won", isTerminal: true }
    );

    expect(result.applies).toBe(false);
  });
});

describe("getDealDetail", () => {
  beforeEach(() => {
    pipelineMocks.getStageById.mockReset();
    pipelineMocks.getStageById.mockResolvedValue({
      id: "stage-opportunity",
      slug: "opportunity",
      isTerminal: false,
    });
  });

  it("attaches post conversion enrichment state to deal detail", async () => {
    const tenantDb = createFakeTenantDb({
      deals: [
        {
          id: "deal-1",
          dealNumber: "TR-2026-0001",
          name: "Palm Villas repaint",
          stageId: "stage-opportunity",
          assignedRepId: "rep-1",
          primaryContactId: null,
          companyId: "company-1",
          propertyId: "property-1",
          sourceLeadId: "lead-1",
          source: "Referral",
          workflowRoute: "estimating",
          isActive: true,
          projectTypeId: null,
          regionId: null,
          expectedCloseDate: null,
          nextStep: "   ",
        },
      ],
    });

    const detail = await getDealDetail(tenantDb as never, "deal-1", "director", "director-1");

    expect(detail?.postConversionEnrichment).toEqual({
      applies: true,
      isComplete: false,
      requiredFields: [
        "projectTypeId",
        "regionId",
        "expectedCloseDate",
        "nextStep",
      ],
      missingFields: [
        "projectTypeId",
        "regionId",
        "expectedCloseDate",
        "nextStep",
      ],
    });
  });
});
