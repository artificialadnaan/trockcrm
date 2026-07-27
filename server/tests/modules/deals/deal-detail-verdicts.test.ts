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
    // EXPECTED values per case, not a conditional. `if (effectiveOnHold) expect(value).toBe(0)` passes
    // vacuously the moment a regression makes effectiveOnHold false — the assertion simply stops
    // running, and the test stays green while reporting nothing.
    const cases = [
      { overrides: {}, onHold: false, value: 250000 },
      { overrides: { onHold: true }, onHold: true, value: 0 },
      { overrides: { expectedCloseDate: isoDay(200) }, onHold: true, value: 0 },
    ];
    for (const { overrides, onHold, value } of cases) {
      const tenantDb = createFakeTenantDb({ deals: [dealRow(overrides)] });
      const detail = await getDealDetail(tenantDb as never, "deal-1", "director", "director-1");
      expect(detail?.effectiveOnHold).toBe(onHold);
      expect(detail?.effectiveValue).toBe(value);
    }
  });

  /**
   * The two tests below replace a claim with a check.
   *
   * The consistency test above asserted the verdicts agree, and its comment said they agree "because
   * they are computed from ONE timestamp" — but it never crossed a calendar boundary, so it passed
   * identically whether or not that was true. It described the fix instead of testing it, which is worse
   * than no coverage: it reads as protection while providing none. Both review bots caught this, and
   * they were right about something stronger than they claimed — the shared timestamp was not in the
   * code at all.
   *
   * Splitting it in two keeps each half deterministic:
   *   1. that two readings across CT midnight genuinely DO disagree — the consequence being prevented;
   *   2. that the service hands both helpers the SAME instant — the mechanism preventing it.
   * A stepping global clock would test both at once, but getDealDetail reads the clock in several
   * places, so which reading landed on which day would depend on unrelated code — a flaky test dressed
   * up as a strict one.
   */
  it("two readings across CT midnight really do disagree at the 90-day boundary", async () => {
    const { isDealValueEffectivelyOnHold, getEffectiveDealValue } = await import(
      "@trock-crm/shared/types"
    );

    // March 2026 is CDT (UTC-5), so CT midnight is 05:00:00Z: 04:59:30Z is 23:59:30 the previous CT
    // evening, and 05:00:30Z is 30 seconds into the next CT day — a boundary a real request straddles.
    const beforeMidnightCt = new Date("2026-03-11T04:59:30.000Z");
    const afterMidnightCt = new Date("2026-03-11T05:00:30.000Z");

    // Held iff days-to-target > 90, so a target 91 days from the EARLIER CT day flips as the day rolls.
    const deal = {
      onHold: false,
      stageSlug: "opportunity",
      workflowRoute: "normal",
      expectedCloseDate: "2026-06-09",
      // bidEstimate, not estimatedValue — the value resolver reads
      // awarded > bid_board > bid > dd and has no estimatedValue candidate at all.
      bidEstimate: 250000,
    };

    expect(isDealValueEffectivelyOnHold(deal as never, beforeMidnightCt)).toBe(true);
    expect(isDealValueEffectivelyOnHold(deal as never, afterMidnightCt)).toBe(false);

    // Which is exactly the contradiction: held by one clock, full value by the other.
    expect(getEffectiveDealValue(deal as never, afterMidnightCt)).toBe(250000);
  });

  it("passes ONE shared instant to both verdict helpers", async () => {
    const holdModule = await import("@trock-crm/shared/types");
    const onHoldSpy = vi.spyOn(holdModule, "isDealValueEffectivelyOnHold");
    const valueSpy = vi.spyOn(holdModule, "getEffectiveDealValue");

    try {
      const tenantDb = createFakeTenantDb({ deals: [dealRow()] });
      await getDealDetail(tenantDb as never, "deal-1", "director", "director-1");

      expect(onHoldSpy).toHaveBeenCalled();
      expect(valueSpy).toHaveBeenCalled();

      const onHoldNow = onHoldSpy.mock.calls[0][1];
      const valueNow = valueSpy.mock.calls[0][1];

      // Defined, not merely equal: calling both bare leaves each to its own `new Date()` default, which
      // arrives here as undefined and would otherwise satisfy a bare equality check.
      expect(onHoldNow).toBeInstanceOf(Date);
      // The SAME object. Two Dates a microsecond apart are not equal, but they are also not the point:
      // one instant, passed twice, is the only shape that cannot drift.
      expect(valueNow).toBe(onHoldNow);
    } finally {
      onHoldSpy.mockRestore();
      valueSpy.mockRestore();
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
