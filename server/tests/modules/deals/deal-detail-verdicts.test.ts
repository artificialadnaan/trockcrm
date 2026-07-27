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

/**
 * The deal DETAIL must propagate the canonical verdicts attachAtRiskResult computes.
 *
 * This is a REGRESSION test for a bug that shipped: getDealDetail built its response by copying
 * `.atRisk` out of the attached result and dropping everything else, so the LIST carried
 * effectiveOnHold / effectiveValue / displayStageSlug and DETAIL silently sent `undefined`. A stored
 * on-hold deal then displayed its full raw value beside its own "On hold" badge, on the screen most
 * likely to be looked at. Nothing caught it: the shape is structurally fine either way.
 */
describe("getDealDetail — canonical verdicts reach the response", () => {
  const dayMs = 24 * 60 * 60 * 1000;
  const isoDay = (offsetDays: number) =>
    new Date(Date.now() + offsetDays * dayMs).toISOString().slice(0, 10);

  function dealRow(overrides: Record<string, unknown> = {}) {
    return {
      id: "deal-1",
      dealNumber: "TR-2026-0001",
      name: "Palm Villas repaint",
      stageId: "stage-opportunity",
      assignedRepId: "rep-1",
      primaryContactId: null,
      companyId: "company-1",
      propertyId: "property-1",
      sourceLeadId: null,
      workflowRoute: "normal",
      isActive: true,
      onHold: false,
      awardedAmount: "250000.00",
      bidEstimate: null,
      ddEstimate: null,
      bidBoardTotalSales: null,
      expectedCloseDate: null,
      ...overrides,
    };
  }

  beforeEach(() => {
    pipelineMocks.getStageById.mockReset();
    pipelineMocks.getStageById.mockResolvedValue({
      id: "stage-opportunity",
      slug: "opportunity",
      isTerminal: false,
    });
  });

  it("returns the effective verdicts at all, not just atRisk", async () => {
    const tenantDb = createFakeTenantDb({ deals: [dealRow()] });
    const detail = await getDealDetail(tenantDb as never, "deal-1", "director", "director-1");

    // The exact failure: these were `undefined` on detail while the list had them.
    expect(detail?.effectiveOnHold).toBeDefined();
    expect(detail?.effectiveValue).toBeDefined();
    expect(detail?.effectiveOnHold).toBe(false);
    expect(detail?.effectiveValue).toBe(250000);
  });

  it("zeroes a stored on-hold deal", async () => {
    const tenantDb = createFakeTenantDb({ deals: [dealRow({ onHold: true })] });
    const detail = await getDealDetail(tenantDb as never, "deal-1", "director", "director-1");

    expect(detail?.effectiveOnHold).toBe(true);
    // The visible symptom of the original bug: a full amount beside an "On hold" badge.
    expect(detail?.effectiveValue).toBe(0);
  });

  it("auto-parks an open deal whose close target is far out", async () => {
    const tenantDb = createFakeTenantDb({
      deals: [dealRow({ expectedCloseDate: isoDay(200) })],
    });
    const detail = await getDealDetail(tenantDb as never, "deal-1", "director", "director-1");

    expect(detail?.effectiveOnHold).toBe(true);
    expect(detail?.effectiveValue).toBe(0);
  });

  it("keeps effectiveOnHold and effectiveValue consistent with each other", async () => {
    // They are computed from ONE timestamp precisely so they cannot disagree across a calendar
    // boundary — held must mean zero, and zero from this rule must mean held.
    for (const overrides of [{}, { onHold: true }, { expectedCloseDate: isoDay(200) }]) {
      const tenantDb = createFakeTenantDb({ deals: [dealRow(overrides)] });
      const detail = await getDealDetail(tenantDb as never, "deal-1", "director", "director-1");
      if (detail?.effectiveOnHold) expect(detail?.effectiveValue).toBe(0);
    }
  });

  it("reports a bid-board-aware displayStageSlug", async () => {
    const tenantDb = createFakeTenantDb({
      deals: [dealRow({ bidBoardStageSlug: "estimate_sent_to_client" })],
    });
    const detail = await getDealDetail(tenantDb as never, "deal-1", "director", "director-1");

    // The CRM stage is still "opportunity"; the deal has moved on in Bid Board.
    expect(detail?.displayStageSlug).toBe("estimate_sent_to_client");
  });
});
