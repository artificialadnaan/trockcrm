import { describe, expect, it } from "vitest";
import {
  deals,
  leadQuestionAnswers,
  leads,
  projectTypeQuestionNodes,
  properties,
} from "@trock-crm/shared/schema";
import {
  DEAL_FIELD_OWNERSHIP,
  getResolvedDeal,
  planDealFieldWrite,
  writeResolvedDealFields,
} from "../../../src/modules/deals/lineage-resolver.js";

type FakeRow = Record<string, any>;

function getTableName(table: unknown) {
  return (table as { _: { name?: string } })?._?.name;
}

function createLineageTenantDb(initial?: {
  deal?: Partial<typeof deals.$inferSelect>;
  lead?: Partial<typeof leads.$inferSelect>;
  property?: Partial<typeof properties.$inferSelect>;
  questionAnswers?: Array<{ key: string; valueJson: unknown }>;
}) {
  const state = {
    deals: [
      {
        id: "deal-1",
        name: "Deal Name",
        sourceLeadId: "lead-1",
        propertyId: null,
        projectTypeId: "pt-1",
        companyId: "company-1",
        source: null,
        workflowRoute: "normal",
        propertyAddress: null,
        propertyCity: null,
        propertyState: null,
        propertyZip: null,
        primaryContactId: null,
        assignedRepId: "rep-1",
        description: null,
        updatedAt: new Date("2026-01-01T00:00:00.000Z"),
        ...initial?.deal,
      } as FakeRow,
    ],
    leads: [
      {
        id: "lead-1",
        name: "Lead Name",
        projectTypeId: "pt-1",
        companyId: "company-1",
        sourceCategory: "referral",
        sourceDetail: "Existing client",
        source: null,
        propertyId: "property-1",
        primaryContactId: "contact-1",
        assignedRepId: "rep-1",
        pipelineType: "normal",
        description: "Lead description",
        bidDueDate: "2026-06-01",
        updatedAt: new Date("2026-01-01T00:00:00.000Z"),
        ...initial?.lead,
      } as FakeRow,
    ],
    properties: [
      {
        id: "property-1",
        name: "Lead Property",
        address: "123 Main St",
        city: "Dallas",
        state: "TX",
        zip: "75001",
        ...initial?.property,
      } as FakeRow,
    ],
    leadQuestionAnswers: (initial?.questionAnswers ?? []).map((row, index) => ({
      id: `answer-${index + 1}`,
      leadId: "lead-1",
      questionId: `question-${index + 1}`,
      key: row.key,
      valueJson: row.valueJson,
    })),
  };

  function rowsFor(table: unknown) {
    if (table === deals || getTableName(table) === "deals") return state.deals;
    if (table === leads || getTableName(table) === "leads") return state.leads;
    if (table === properties || getTableName(table) === "properties") return state.properties;
    if (table === leadQuestionAnswers || getTableName(table) === "lead_question_answers") {
      return state.leadQuestionAnswers;
    }
    if (table === projectTypeQuestionNodes || getTableName(table) === "project_type_question_nodes") {
      return state.leadQuestionAnswers;
    }
    throw new Error(`Unexpected table in lineage fake db: ${getTableName(table) ?? String(table)}`);
  }

  function selectFrom(table: unknown) {
    const rows = rowsFor(table);
    const query = {
      innerJoin() {
        return query;
      },
      where() {
        return {
          limit(limit: number) {
            return Promise.resolve(rows.slice(0, limit));
          },
          then(onfulfilled: (value: FakeRow[]) => unknown) {
            return Promise.resolve(rows).then(onfulfilled);
          },
        };
      },
      limit(limit: number) {
        return Promise.resolve(rows.slice(0, limit));
      },
      then(onfulfilled: (value: FakeRow[]) => unknown) {
        return Promise.resolve(rows).then(onfulfilled);
      },
    };
    return query;
  }

  return {
    state,
    select() {
      return {
        from: selectFrom,
      };
    },
    update(table: unknown) {
      return {
        set(values: FakeRow) {
          return {
            where() {
              const rows = rowsFor(table);
              rows.forEach((row) => Object.assign(row, values));
              return {
                returning() {
                  return Promise.resolve(rows);
                },
              };
            },
          };
        },
      };
    },
    insert(table: unknown) {
      return {
        values(value: FakeRow) {
          const rows = rowsFor(table);
          rows.push({ id: `${getTableName(table) ?? "row"}-${rows.length + 1}`, ...value });
          return {
            returning() {
              return Promise.resolve(rows.slice(-1));
            },
          };
        },
      };
    },
  };
}

describe("deal lineage resolver field ownership", () => {
  it("routes lineage lead fields to the source lead with deal snapshot write-through", () => {
    expect(planDealFieldWrite({ field: "projectTypeId", hasSourceLead: true })).toEqual({
      field: "projectTypeId",
      ownership: "lead",
      target: "source_lead",
      compatibilityWriteThrough: true,
    });

    expect(planDealFieldWrite({ field: "propertyAddress", hasSourceLead: true })).toEqual({
      field: "propertyAddress",
      ownership: "lead",
      target: "source_lead",
      compatibilityWriteThrough: true,
    });
  });

  it("routes bid due date to the source lead column with deal snapshot write-through", () => {
    expect(planDealFieldWrite({ field: "bidDueDate", hasSourceLead: true })).toEqual({
      field: "bidDueDate",
      ownership: "lead",
      target: "source_lead",
      compatibilityWriteThrough: true,
    });
  });

  it("routes opportunity-owned fields to deal scoping", () => {
    expect(planDealFieldWrite({ field: "preBidMeetingCompleted", hasSourceLead: true })).toEqual({
      field: "preBidMeetingCompleted",
      ownership: "deal_scoping",
      target: "deal_scoping",
      compatibilityWriteThrough: false,
    });
  });

  it("falls back to deal columns for legacy deals without sourceLeadId", () => {
    expect(planDealFieldWrite({ field: "projectTypeId", hasSourceLead: false })).toEqual({
      field: "projectTypeId",
      ownership: "lead",
      target: "deal",
      compatibilityWriteThrough: false,
    });

    expect(planDealFieldWrite({ field: "bidDueDate", hasSourceLead: false })).toEqual({
      field: "bidDueDate",
      ownership: "lead",
      target: "deal",
      compatibilityWriteThrough: false,
    });
  });

  it("keeps the field ownership map explicit for every resolver-supported field", () => {
    expect(DEAL_FIELD_OWNERSHIP).toMatchObject({
      projectTypeId: "lead",
      companyId: "lead",
      sourceCategory: "lead",
      sourceDetail: "lead",
      propertyId: "lead",
      propertyName: "lead",
      propertyAddress: "lead",
      propertyCity: "lead",
      propertyState: "lead",
      propertyZip: "lead",
      primaryContactId: "lead",
      assignedRepId: "lead",
      workflowRoute: "lead",
      description: "lead",
      bidDueDate: "lead",
      preBidMeetingCompleted: "deal_scoping",
      siteVisitDecision: "deal_scoping",
      siteVisitCompleted: "deal_scoping",
      estimatorConsultationNotes: "deal_scoping",
    });
  });

  it("resolves bid due date from the lead column when the V2 answer is absent", async () => {
    const tenantDb = createLineageTenantDb({
      lead: { bidDueDate: "2026-06-01" },
      questionAnswers: [],
    });

    const resolved = await getResolvedDeal(tenantDb as never, "deal-1");

    expect(resolved.resolved.bidDueDate).toBe("2026-06-01");
    expect(resolved.answersByKey).not.toHaveProperty("bid_due_date");
  });

  it("resolves bid due date from the lead column when the V2 answer is stale", async () => {
    const tenantDb = createLineageTenantDb({
      lead: { bidDueDate: "2026-06-01" },
      questionAnswers: [{ key: "bid_due_date", valueJson: "2026-04-01" }],
    });

    const resolved = await getResolvedDeal(tenantDb as never, "deal-1");

    expect(resolved.resolved.bidDueDate).toBe("2026-06-01");
    expect(resolved.answersByKey.bid_due_date).toBe("2026-04-01");
  });

  it("resolves the updated lead column value when the V2 mirror remains stale", async () => {
    const tenantDb = createLineageTenantDb({
      lead: { bidDueDate: "2026-06-01" },
      questionAnswers: [{ key: "bid_due_date", valueJson: "2026-06-01" }],
    });

    await writeResolvedDealFields(
      tenantDb as never,
      "deal-1",
      { bidDueDate: "2026-07-15" },
      { userId: "user-1", officeId: "office-1", role: "director", now: new Date("2026-05-01T00:00:00.000Z") }
    );
    const resolved = await getResolvedDeal(tenantDb as never, "deal-1");

    expect(tenantDb.state.leads[0]?.bidDueDate).toBe("2026-07-15");
    expect(tenantDb.state.leadQuestionAnswers[0]?.valueJson).toBe("2026-06-01");
    expect(resolved.resolved.bidDueDate).toBe("2026-07-15");
  });

  it("writes bid due date through to the source lead column, not V2 answers", async () => {
    const tenantDb = createLineageTenantDb({
      lead: { bidDueDate: "2026-06-01" },
      questionAnswers: [],
    });

    await writeResolvedDealFields(
      tenantDb as never,
      "deal-1",
      { bidDueDate: "2026-08-20" },
      { userId: "user-1", officeId: "office-1", role: "director", now: new Date("2026-05-01T00:00:00.000Z") }
    );

    expect(tenantDb.state.leads[0]?.bidDueDate).toBe("2026-08-20");
    expect(tenantDb.state.leadQuestionAnswers).toEqual([]);
  });

  it("write-throughs a scoping bid due date edit to BOTH leads and deals at UTC midnight", async () => {
    const tenantDb = createLineageTenantDb({
      lead: { bidDueDate: "2026-06-01" },
      questionAnswers: [],
    });

    await writeResolvedDealFields(
      tenantDb as never,
      "deal-1",
      { bidDueDate: "2026-07-03" },
      { userId: "user-1", officeId: "office-1", role: "director", now: new Date("2026-05-01T00:00:00.000Z") }
    );

    // Lead keeps the date-only string (the lineage owner column).
    expect(tenantDb.state.leads[0]?.bidDueDate).toBe("2026-07-03");
    // Deal mirror is normalized to UTC midnight for the SAME calendar day — not the prior day.
    expect(tenantDb.state.deals[0]?.bidDueDate).toEqual(new Date("2026-07-03T00:00:00.000Z"));
    expect((tenantDb.state.deals[0]?.bidDueDate as Date).toISOString()).toBe(
      "2026-07-03T00:00:00.000Z"
    );
  });

  it("writes bid due date to the deal column at UTC midnight for a deal with no source lead", async () => {
    // Regression: a manually-created deal (sourceLeadId null) owns bidDueDate directly via the
    // target:"deal" path. The edit must land on the authoritative deals.bid_due_date column at UTC
    // midnight — not silently no-op the way it did before this fix.
    const tenantDb = createLineageTenantDb({
      deal: { sourceLeadId: null, bidDueDate: null } as never,
    });

    const resolved = await writeResolvedDealFields(
      tenantDb as never,
      "deal-1",
      { bidDueDate: "2026-07-03" },
      { userId: "user-1", officeId: "office-1", role: "director", now: new Date("2026-05-01T00:00:00.000Z") }
    );

    expect(tenantDb.state.deals[0]?.bidDueDate).toEqual(new Date("2026-07-03T00:00:00.000Z"));
    expect((tenantDb.state.deals[0]?.bidDueDate as Date).toISOString()).toBe(
      "2026-07-03T00:00:00.000Z"
    );
    // The resolver now reflects the deal-owned value as a date-only string (symmetric with the write),
    // so the PATCH /resolved-fields response + scoping/readiness reads don't see it as "missing".
    expect(resolved.resolved.bidDueDate).toBe("2026-07-03");
    // No source lead, so the orphaned lead row is never written by this path.
    expect(tenantDb.state.leads[0]?.bidDueDate).toBe("2026-06-01");
  });

  it("writes company fill-in through the resolved-fields lineage path", async () => {
    const tenantDb = createLineageTenantDb({
      deal: { companyId: null },
      lead: { companyId: null },
    });

    await writeResolvedDealFields(
      tenantDb as never,
      "deal-1",
      { companyId: "company-2" },
      { userId: "user-1", officeId: "office-1", role: "director", now: new Date("2026-05-01T00:00:00.000Z") }
    );

    expect(tenantDb.state.leads[0]?.companyId).toBe("company-2");
    expect(tenantDb.state.deals[0]?.companyId).toBe("company-2");
  });
});
