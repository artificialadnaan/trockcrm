import { describe, expect, it, vi, beforeEach } from "vitest";
import { deals } from "../../../../shared/src/schema/tenant/deals.js";
import { leads } from "../../../../shared/src/schema/tenant/leads.js";
import { dealApprovals } from "../../../../shared/src/schema/tenant/deal-approvals.js";
import { changeOrders } from "../../../../shared/src/schema/tenant/change-orders.js";
import { dealStageHistory } from "../../../../shared/src/schema/tenant/deal-stage-history.js";
import { projectTypeConfig } from "../../../../shared/src/schema/public/project-type-config.js";

const pipelineMocks = vi.hoisted(() => ({
  getStageById: vi.fn(),
}));

vi.mock("../../../src/modules/pipeline/service.js", () => ({
  getStageById: pipelineMocks.getStageById,
}));

vi.mock("@trock-crm/shared/schema", async () => {
  const [dealsModule, approvalsModule, changeOrdersModule, dealChangeOrdersModule, historyModule, pipelineStageModule, usersModule, companiesModule, contactsModule, projectTypeConfigModule, leadsModule] =
    await Promise.all([
      import("../../../../shared/src/schema/tenant/deals.js"),
      import("../../../../shared/src/schema/tenant/deal-approvals.js"),
      import("../../../../shared/src/schema/tenant/change-orders.js"),
      import("../../../../shared/src/schema/tenant/deal-change-orders.js"),
      import("../../../../shared/src/schema/tenant/deal-stage-history.js"),
      import("../../../../shared/src/schema/public/pipeline-stage-config.js"),
      import("../../../../shared/src/schema/public/users.js"),
      import("../../../../shared/src/schema/tenant/companies.js"),
      import("../../../../shared/src/schema/tenant/contacts.js"),
      import("../../../../shared/src/schema/public/project-type-config.js"),
      import("../../../../shared/src/schema/tenant/leads.js"),
    ]);

  return {
    ...dealsModule,
    ...approvalsModule,
    ...changeOrdersModule,
    ...dealChangeOrdersModule,
    ...historyModule,
    ...pipelineStageModule,
    ...usersModule,
    ...companiesModule,
    ...contactsModule,
    ...projectTypeConfigModule,
    ...leadsModule,
  };
});

import { getDealDetail } from "../../../src/modules/deals/service.js";
import { evaluatePostConversionEnrichment } from "../../../src/modules/deals/post-conversion-enrichment.js";

function createFakeTenantDb(state: {
  deals: Array<Record<string, unknown>>;
  leads?: Array<Record<string, unknown>>;
  projectTypes?: Array<Record<string, unknown>>;
  dealStageHistory?: Array<Record<string, unknown>>;
  dealApprovals?: Array<Record<string, unknown>>;
  changeOrders?: Array<Record<string, unknown>>;
}) {
  const tableRows = new Map<unknown, Array<Record<string, unknown>>>([
    [deals, state.deals],
    [leads, state.leads ?? []],
    [dealStageHistory, state.dealStageHistory ?? []],
    [dealApprovals, state.dealApprovals ?? []],
    [changeOrders, state.changeOrders ?? []],
    [projectTypeConfig, state.projectTypes ?? []],
  ]);

  return {
    select() {
      const queryFor = (table: unknown) => {
        const rows = tableRows.get(table) ?? [];
        const joinedTables: unknown[] = [];
        return {
          leftJoin(joinedTable: unknown) {
            joinedTables.push(joinedTable);
            return this;
          },
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
            const selectedRows = rows.map((row) => {
              if (table === deals && joinedTables.includes(projectTypeConfig)) {
                const projectType = (state.projectTypes ?? []).find(
                  (type) => type.id === row.projectTypeId
                );
                return {
                  ...row,
                  projectType: projectType?.name ?? row.projectType,
                };
              }

              return { ...row };
            });
            return Promise.resolve(selectedRows).then(onfulfilled);
          },
        };
      };
      return {
        from(table: unknown) {
          return queryFor(table);
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
          workflowRoute: "normal",
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

  it("returns assigned rep and company names for the detail header", async () => {
    const tenantDb = createFakeTenantDb({
      deals: [
        {
          id: "deal-1",
          dealNumber: "TR-2026-0001",
          name: "Palm Villas repaint",
          stageId: "stage-opportunity",
          assignedRepId: "rep-1",
          assignedRepName: "Brett Jones",
          companyId: "company-1",
          companyName: "Palm Villas",
          propertyId: "property-1",
          sourceLeadId: "lead-1",
          workflowRoute: "normal",
          isActive: true,
        },
      ],
    });

    const detail = await getDealDetail(tenantDb as never, "deal-1", "director", "director-1");

    expect(detail?.assignedRepName).toBe("Brett Jones");
    expect(detail?.companyName).toBe("Palm Villas");
  });

  it("returns the proper-cased project type config name on deal detail", async () => {
    const tenantDb = createFakeTenantDb({
      projectTypes: [
        {
          id: "project-type-1",
          name: "Exterior Renovation",
        },
      ],
      deals: [
        {
          id: "deal-1",
          dealNumber: "TR-2026-0001",
          name: "Palm Villas repaint",
          stageId: "stage-opportunity",
          assignedRepId: "rep-1",
          companyId: "company-1",
          propertyId: "property-1",
          sourceLeadId: "lead-1",
          workflowRoute: "normal",
          isActive: true,
          projectTypeId: "project-type-1",
          projectType: "exterior renovation",
        },
      ],
    });

    const detail = await getDealDetail(tenantDb as never, "deal-1", "director", "director-1");

    expect(detail?.projectType).toBe("Exterior Renovation");
  });

  it("resolves the bid due date from the source lead, not the stale deal snapshot", async () => {
    const tenantDb = createFakeTenantDb({
      leads: [{ id: "lead-1", bidDueDate: "2026-07-03" }],
      deals: [
        {
          id: "deal-1",
          dealNumber: "TR-2026-0001",
          name: "Palm Villas repaint",
          stageId: "stage-opportunity",
          assignedRepId: "rep-1",
          companyId: "company-1",
          propertyId: "property-1",
          sourceLeadId: "lead-1",
          workflowRoute: "normal",
          isActive: true,
          // Stale snapshot from before the write-through; must NOT win over the lead's current value.
          bidDueDate: new Date("2026-01-01T00:00:00.000Z"),
        },
      ],
    });

    const detail = await getDealDetail(tenantDb as never, "deal-1", "director", "director-1");

    expect(detail?.bidDueDate).toBe("2026-07-03");
  });

  it("reports a cleared lead bid due date as null on the detail, never the stale snapshot", async () => {
    const tenantDb = createFakeTenantDb({
      leads: [{ id: "lead-1", bidDueDate: null }],
      deals: [
        {
          id: "deal-1",
          dealNumber: "TR-2026-0001",
          name: "Palm Villas repaint",
          stageId: "stage-opportunity",
          assignedRepId: "rep-1",
          companyId: "company-1",
          propertyId: "property-1",
          sourceLeadId: "lead-1",
          workflowRoute: "normal",
          isActive: true,
          bidDueDate: new Date("2026-01-01T00:00:00.000Z"),
        },
      ],
    });

    const detail = await getDealDetail(tenantDb as never, "deal-1", "director", "director-1");

    expect(detail?.bidDueDate).toBeNull();
  });

  it("uses the deal column for a manual deal with no source lead", async () => {
    const dealBid = new Date("2026-08-20T00:00:00.000Z");
    const tenantDb = createFakeTenantDb({
      deals: [
        {
          id: "deal-1",
          dealNumber: "TR-2026-0001",
          name: "Manual Deal",
          stageId: "stage-opportunity",
          assignedRepId: "rep-1",
          companyId: "company-1",
          propertyId: "property-1",
          sourceLeadId: null,
          workflowRoute: "normal",
          isActive: true,
          bidDueDate: dealBid,
        },
      ],
    });

    const detail = await getDealDetail(tenantDb as never, "deal-1", "director", "director-1");

    expect(detail?.bidDueDate).toEqual(dealBid);
  });

  // The detail response publishes the RESOLVED (lead-owned) bid due date, and since 2026-07-27 that date is
  // the auto-park horizon in the estimating stage. The hold/value/at-risk verdicts stamped on the SAME
  // object must therefore be computed from it too — otherwise one payload shows the lead's bid date beside
  // an On-hold badge and a $0 that were derived from a different (stale snapshot) date. Both directions are
  // covered so neither "always park" nor "never park" can pass. (Codex P2.)
  describe("estimating hold verdicts use the resolved bid due date", () => {
    const ymd = (offsetDays: number) =>
      new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

    function estimatingDeal(overrides: Record<string, unknown>) {
      return {
        id: "deal-1",
        dealNumber: "TR-2026-0001",
        name: "Estimating deal",
        stageId: "stage-estimating",
        stageSlug: "estimating",
        assignedRepId: "rep-1",
        companyId: "company-1",
        propertyId: "property-1",
        sourceLeadId: "lead-1",
        workflowRoute: "normal",
        isActive: true,
        onHold: false,
        bidEstimate: "125000",
        // Near close target in BOTH cases: only the bid due date may move the verdict here.
        expectedCloseDate: ymd(10),
        ...overrides,
      };
    }

    beforeEach(() => {
      pipelineMocks.getStageById.mockResolvedValue({
        id: "stage-estimating",
        slug: "estimating",
        isTerminal: false,
      });
    });

    it("parks the deal when the LEAD's bid date is far out and the deal snapshot is stale-near", async () => {
      const tenantDb = createFakeTenantDb({
        leads: [{ id: "lead-1", bidDueDate: ymd(200) }],
        deals: [estimatingDeal({ bidDueDate: new Date(`${ymd(5)}T00:00:00.000Z`) })],
      });

      const detail = await getDealDetail(tenantDb as never, "deal-1", "director", "director-1");

      expect(detail?.bidDueDate).toBe(ymd(200));
      expect(detail?.effectiveOnHold).toBe(true);
      expect(detail?.effectiveValue).toBe(0);
    });

    it("keeps the deal active when the LEAD's bid date is near and the deal snapshot is stale-far", async () => {
      const tenantDb = createFakeTenantDb({
        leads: [{ id: "lead-1", bidDueDate: ymd(5) }],
        deals: [estimatingDeal({ bidDueDate: new Date(`${ymd(200)}T00:00:00.000Z`) })],
      });

      const detail = await getDealDetail(tenantDb as never, "deal-1", "director", "director-1");

      expect(detail?.bidDueDate).toBe(ymd(5));
      expect(detail?.effectiveOnHold).toBe(false);
      expect(detail?.effectiveValue).toBe(125000);
    });
  });
});
