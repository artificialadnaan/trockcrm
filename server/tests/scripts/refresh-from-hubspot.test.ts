import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyDealChanges,
  buildDealUpdatePlan,
  findCompanyByHubSpotName,
  normalizePropertyState,
  parseHubSpotCloseDate,
  resolveHubSpotStage,
  shouldRefreshBidEstimate,
  STAGE_MAPPING,
} from "../../../scripts/refresh-from-hubspot";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("HubSpot refresh stage mapping", () => {
  const hubSpotStages = new Map([
    ["1108001578", "Pipe Line"],
    ["appointmentscheduled", "RFP"],
    ["qualifiedtobuy", "Estimating"],
    ["2465177306", "Internal Review"],
    ["presentationscheduled", "Proposal Sent"],
    ["decisionmakerboughtin", "Follow-Up"],
    ["contractsent", "Approval 30 Days"],
    ["1127149873", "Approval 60-90 days"],
    ["closedwon", "Closed Won"],
    ["closedlost", "Closed Lost"],
    ["1127022623", "On Hold"],
    ["1127022624", "Deal Canceled"],
    ["2205834970", "Service - Estimating"],
    ["2205834971", "Service - Production"],
    ["2255953625", "Service - Won"],
    ["2255953626", "Service - Lost"],
  ]);

  it("maps every configured non-skip HubSpot stage to a CRM slug", () => {
    for (const entry of STAGE_MAPPING) {
      const result = resolveHubSpotStage(entry.hubSpotStage, hubSpotStages);
      expect(result.action).toBe(entry.action);
      if (entry.action === "update") {
        expect(result.targetSlug).toBe(entry.crmStageSlug);
        expect(result.workflowFamily).toBe(entry.workflowFamily);
      }
    }
  });

  it("skips On Hold and unmapped stages without guessing", () => {
    expect(resolveHubSpotStage("1127022623", hubSpotStages)).toMatchObject({
      action: "skip",
      reason: "on_hold",
    });
    expect(resolveHubSpotStage("new-stage-id", hubSpotStages)).toMatchObject({
      action: "skip",
      reason: "unmapped_stage",
    });
  });
});

describe("HubSpot refresh field policies", () => {
  it("defensively parses close dates and rejects out-of-range years", () => {
    expect(parseHubSpotCloseDate("2026-04-30T00:00:00Z")).toEqual({
      value: "2026-04-30",
      warning: null,
    });
    expect(parseHubSpotCloseDate("2019-12-31")).toEqual({
      value: null,
      warning: "out_of_range_year",
    });
    expect(parseHubSpotCloseDate("2051-01-01")).toEqual({
      value: null,
      warning: "out_of_range_year",
    });
    expect(parseHubSpotCloseDate("not a date")).toEqual({
      value: null,
      warning: "invalid_date",
    });
  });

  it("matches company names case-insensitively with whitespace normalization", () => {
    const companies = [
      { id: "company-1", name: "Birchstone Residential" },
      { id: "company-2", name: "UDR, Inc. Apartments for Rent" },
    ];

    expect(findCompanyByHubSpotName("  birchstone   residential ", companies)).toBe("company-1");
    expect(findCompanyByHubSpotName("Missing Company", companies)).toBeNull();
  });

  it("normalizes full HubSpot state names to CRM two-letter abbreviations", () => {
    expect(normalizePropertyState("Texas")).toBe("TX");
    expect(normalizePropertyState("texas")).toBe("TX");
    expect(normalizePropertyState("Georgia")).toBe("GA");
    expect(normalizePropertyState(" tx ")).toBe("TX");
    expect(normalizePropertyState("Unknown Province")).toBeNull();
  });

  it("refreshes bid_estimate only for null/zero or meaningful drift", () => {
    expect(shouldRefreshBidEstimate(null, "100")).toEqual({
      shouldRefresh: true,
      reason: "crm_missing_or_zero_hubspot_nonzero",
    });
    expect(shouldRefreshBidEstimate("0", "100")).toEqual({
      shouldRefresh: true,
      reason: "crm_missing_or_zero_hubspot_nonzero",
    });
    expect(shouldRefreshBidEstimate("100", "104")).toEqual({
      shouldRefresh: false,
      reason: "within_5_percent_threshold",
    });
    expect(shouldRefreshBidEstimate("100", "106")).toEqual({
      shouldRefresh: true,
      reason: "gt_5_percent_drift",
    });
  });

  it("never proposes changes for CRM-canonical fields", () => {
    const plan = buildDealUpdatePlan({
      crmDeal: {
        id: "deal-1",
        name: "CRM Name",
        stageId: "stage-old",
        stageSlug: "estimate_in_progress",
        expectedCloseDate: null,
        propertyCity: null,
        propertyState: null,
        bidEstimate: "100.00",
        description: "Keep CRM text",
        companyId: null,
        assignedRepId: "rep-1",
        awardedAmount: "999.00",
        bidBoardProjectNumber: "DFW-1-10000-aa",
      },
      hubSpotDeal: {
        dealname: "HubSpot Name",
        dealstage: "closedwon",
        closedate: "2026-05-01",
        city: "Dallas",
        state: "Texas",
        amount: "106",
        description: "HubSpot text",
        companyName: null,
      },
      hubSpotStages: new Map([["closedwon", "Closed Won"]]),
      stageByKey: new Map([["standard_deal:sent_to_production", "stage-new"]]),
      companies: [],
    });

    const fields = plan.changes.map((change) => change.fieldName);
    expect(fields).toContain("stage_id");
    expect(fields).toContain("expected_close_date");
    expect(fields).toContain("property_city");
    expect(fields).toContain("property_state");
    expect(fields).toContain("bid_estimate");
    expect(fields).not.toContain("assigned_rep_id");
    expect(fields).not.toContain("awarded_amount");
    expect(fields).not.toContain("name");
    expect(fields).not.toContain("hubspot_deal_id");
    expect(fields).not.toContain("bid_board_project_number");
    expect(fields).not.toContain("description");
  });

  it("leaves company_id alone by default while reporting suppressed matches", () => {
    const plan = buildDealUpdatePlan({
      crmDeal: {
        id: "deal-1",
        name: "CRM Name",
        stageId: "stage-old",
        stageSlug: "estimate_in_progress",
        expectedCloseDate: "2026-05-01",
        propertyCity: "Dallas",
        propertyState: "TX",
        bidEstimate: "100.00",
        description: "Keep CRM text",
        companyId: null,
      },
      hubSpotDeal: {
        dealstage: "qualifiedtobuy",
        closedate: "2026-05-01",
        city: "Dallas",
        state: "TX",
        amount: "100",
        companyName: "Birchstone Residential",
      },
      hubSpotStages: new Map([["qualifiedtobuy", "Estimating"]]),
      stageByKey: new Map([["standard_deal:estimate_in_progress", "stage-old"]]),
      companies: [{ id: "company-1", name: "birchstone   residential" }],
    });

    expect(plan.changes.map((change) => change.fieldName)).not.toContain("company_id");
    expect(plan.companyRefreshSuppressed).toBe(true);
    expect(plan.matchedCompanyName).toBe("Birchstone Residential");
  });

  it("proposes company_id changes only when REFRESH_COMPANY_ID behavior is enabled", () => {
    const plan = buildDealUpdatePlan({
      crmDeal: {
        id: "deal-1",
        name: "CRM Name",
        stageId: "stage-old",
        stageSlug: "estimate_in_progress",
        expectedCloseDate: "2026-05-01",
        propertyCity: "Dallas",
        propertyState: "TX",
        bidEstimate: "100.00",
        description: "Keep CRM text",
        companyId: null,
      },
      hubSpotDeal: {
        dealstage: "qualifiedtobuy",
        closedate: "2026-05-01",
        city: "Dallas",
        state: "TX",
        amount: "100",
        companyName: "Birchstone Residential",
      },
      hubSpotStages: new Map([["qualifiedtobuy", "Estimating"]]),
      stageByKey: new Map([["standard_deal:estimate_in_progress", "stage-old"]]),
      companies: [{ id: "company-1", name: "birchstone   residential" }],
      refreshCompanyId: true,
    });

    expect(plan.changes).toContainEqual(
      expect.objectContaining({
        fieldName: "company_id",
        oldValue: null,
        newValue: "company-1",
      })
    );
    expect(plan.companyRefreshSuppressed).toBe(false);
  });

  it("writes a rich HubSpot Refresh audit row when applying deal changes", async () => {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const client = {
      query: async (sql: string, params: unknown[] = []) => {
        queries.push({ sql, params });
        if (sql.includes("UPDATE office_dallas.deals")) {
          return {
            rows: [{
              id: "deal-1",
              name: "Refresh Deal",
              deal_number: "DFW-1-11126-aa",
              project_number: null,
            }],
            rowCount: 1,
          };
        }
        if (sql.includes("INSERT INTO public.hubspot_refresh_log")) {
          return { rows: [], rowCount: 1 };
        }
        if (sql.includes('INSERT INTO "office_dallas".audit_log')) {
          return { rows: [], rowCount: 1 };
        }
        throw new Error(`Unexpected SQL: ${sql}`);
      },
    };

    await applyDealChanges(client as never, "run-1", "deal-1", [
      {
        dealId: "deal-1",
        fieldName: "bid_estimate",
        oldValue: "1000",
        newValue: "1500",
        reason: "gt_5_percent_drift",
      },
    ]);

    const auditInsert = queries.find((query) => query.sql.includes('INSERT INTO "office_dallas".audit_log'));
    expect(auditInsert?.params).toEqual(expect.arrayContaining([
      "deals",
      "deal-1",
      "update",
      "HubSpot Refresh",
      "Refresh Deal",
      "DFW-1-11126-aa",
    ]));
    expect(JSON.stringify(auditInsert?.params)).toContain("bidEstimate");
  });

  it("skips refresh log and audit log when the UPDATE matches zero rows", async () => {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const client = {
      query: async (sql: string, params: unknown[] = []) => {
        queries.push({ sql, params });
        if (sql.includes("UPDATE office_dallas.deals")) {
          return {
            rows: [],
            rowCount: 0,
          };
        }
        if (sql.includes("INSERT INTO public.hubspot_refresh_log")) {
          return { rows: [], rowCount: 1 };
        }
        if (sql.includes('INSERT INTO "office_dallas".audit_log')) {
          return { rows: [], rowCount: 1 };
        }
        throw new Error(`Unexpected SQL: ${sql}`);
      },
    };
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await applyDealChanges(client as never, "run-1", "deal-missing", [
      {
        dealId: "deal-missing",
        fieldName: "bid_estimate",
        oldValue: "1000",
        newValue: "1500",
        reason: "gt_5_percent_drift",
      },
    ]);

    expect(warnSpy).toHaveBeenCalledWith(
      "HubSpot Refresh: deal deal-missing not updated (row not found). Skipping audit log entry."
    );
    expect(queries.some((query) => query.sql.includes("INSERT INTO public.hubspot_refresh_log"))).toBe(false);
    expect(queries.some((query) => query.sql.includes('INSERT INTO "office_dallas".audit_log'))).toBe(false);
  });
});
