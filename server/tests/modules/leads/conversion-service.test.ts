import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getTableColumns } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import {
  LEAD_STATUSES,
  companies,
  deals,
  leadStageHistory,
  leads,
  properties,
  users,
} from "../../helpers/worktree-shared-contracts.js";
import { describe, expect, it, vi } from "vitest";
import { AppError } from "../../../src/middleware/error-handler.js";
import { createLeadConversionService } from "../../../src/modules/leads/conversion-service.js";
import { createLeadService } from "../../../src/modules/leads/service.js";

vi.mock("@trock-crm/shared/schema", async () => import("../../../../shared/src/schema/index.js"));

const migrationPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../migrations/0019_properties_and_leads.sql"
);
const migrationSql = readFileSync(migrationPath, "utf8");

function expectSqlToMatch(pattern: RegExp): void {
  expect(migrationSql).toMatch(pattern);
}

interface FakeCompanyRow {
  id: string;
  name: string;
  slug: string;
  category: "other";
  isActive: boolean;
}

interface FakePropertyRow {
  id: string;
  companyId: string;
  name: string;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  isActive: boolean;
}

interface FakeUserRow {
  id: string;
  officeId: string;
  isActive: boolean;
}

interface FakeLeadRow {
  id: string;
  companyId: string;
  propertyId: string;
  primaryContactId: string | null;
  name: string;
  stageId: string;
  assignedRepId: string;
  status: "open" | "converted" | "disqualified";
  source: string | null;
  description: string | null;
  stageEnteredAt: Date;
  convertedAt: Date | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

interface FakeDealRow {
  id: string;
  dealNumber: string;
  name: string;
  stageId: string;
  assignedRepId: string;
  primaryContactId: string | null;
  companyId: string | null;
  propertyId: string | null;
  sourceLeadId: string | null;
  source: string | null;
  workflowRoute: "estimating" | "service";
}

interface FakeTenantState {
  companies: FakeCompanyRow[];
  properties: FakePropertyRow[];
  users: FakeUserRow[];
  leads: FakeLeadRow[];
  deals: FakeDealRow[];
}

function createFakeTenantDb(initialState?: Partial<FakeTenantState>) {
  const now = new Date("2026-04-15T15:00:00.000Z");
  const state: FakeTenantState = {
    companies: [
      {
        id: "company-1",
        name: "Palm Villas",
        slug: "palm-villas",
        category: "other",
        isActive: true,
      },
    ],
    properties: [
      {
        id: "property-1",
        companyId: "company-1",
        name: "Palm Villas North",
        address: "123 Palm Way",
        city: "Miami",
        state: "FL",
        zip: "33101",
        isActive: true,
      },
    ],
    users: [
      {
        id: "rep-1",
        officeId: "office-1",
        isActive: true,
      },
    ],
    leads: [],
    deals: [],
    ...initialState,
  };

  function getRows(table: unknown) {
    const tableName = (table as { _: { name?: string } })?._?.name;
    const candidate = table as Record<string, unknown>;

    if (table === companies || tableName === "companies") return state.companies;
    if (table === properties || tableName === "properties") return state.properties;
    if (table === users || tableName === "users") return state.users;
    if (table === leads || tableName === "leads") return state.leads;
    if (table === deals || tableName === "deals") return state.deals;
    if ("slug" in candidate && "category" in candidate && "website" in candidate) return state.companies;
    if ("lat" in candidate && "lng" in candidate && "companyId" in candidate) return state.properties;
    if ("email" in candidate && "role" in candidate && "officeId" in candidate) return state.users;
    if ("convertedAt" in candidate && "stageEnteredAt" in candidate && "assignedRepId" in candidate) return state.leads;
    if ("dealNumber" in candidate && "workflowRoute" in candidate && "sourceLeadId" in candidate) return state.deals;
    throw new Error("Unexpected table in fake tenant db");
  }

  return {
    state,
    select() {
      return {
        from(table: unknown) {
          const rows = getRows(table);
          return {
            where() {
              return {
                limit(limit: number) {
                  return Promise.resolve(rows.slice(0, limit));
                },
                for() {
                  return {
                    limit(limit: number) {
                      return Promise.resolve(rows.slice(0, limit));
                    },
                  };
                },
                then(onfulfilled: (value: unknown[]) => unknown) {
                  return Promise.resolve(rows).then(onfulfilled);
                },
              };
            },
            limit(limit: number) {
              return Promise.resolve(rows.slice(0, limit));
            },
            then(onfulfilled: (value: unknown[]) => unknown) {
              return Promise.resolve(rows).then(onfulfilled);
            },
          };
        },
      };
    },
    insert(table: unknown) {
      return {
        values(value: Record<string, unknown>) {
          const rows = getRows(table) as Array<Record<string, unknown>>;
          const insertedRow = {
            id: value.id ?? `${String((table as { _: { name: string } })._?.name ?? "row")}-${rows.length + 1}`,
            ...value,
          };
          rows.push(insertedRow);
          return {
            returning() {
              return Promise.resolve([insertedRow]);
            },
          };
        },
      };
    },
    update(table: unknown) {
      return {
        set(values: Record<string, unknown>) {
          return {
            where() {
              const rows = getRows(table) as Array<Record<string, unknown>>;
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
  };
}

const leadStage = {
  id: "lead-stage-1",
  name: "Contacted",
  slug: "contacted",
  displayOrder: 1,
  workflowFamily: "lead" as const,
  isActivePipeline: true,
  isTerminal: false,
};

describe("Lead Conversion Shared Contract", () => {
  it("defines the lead lifecycle statuses used during conversion", () => {
    expect(LEAD_STATUSES).toEqual(["open", "converted", "disqualified"]);
  });

  it("anchors properties to companies", () => {
    const columns = getTableColumns(properties);
    const config = getTableConfig(properties);

    expect(columns.companyId.name).toBe("company_id");
    expect(columns.companyId.notNull).toBe(true);
    expect(columns.name.notNull).toBe(true);
    expect(columns.isActive.hasDefault).toBe(true);
    expect(columns.isActive.default).toBe(true);
    expect(config.foreignKeys.map((fk) => fk.getName())).toEqual([
      "properties_company_id_companies_id_fk",
    ]);
  });

  it("defines leads as the canonical pre-RFP record tied to company and property", () => {
    const columns = getTableColumns(leads);
    const config = getTableConfig(leads);

    expect(columns.companyId.name).toBe("company_id");
    expect(columns.companyId.notNull).toBe(true);
    expect(columns.propertyId.name).toBe("property_id");
    expect(columns.propertyId.notNull).toBe(true);
    expect(columns.assignedRepId.notNull).toBe(true);
    expect(columns.stageId.notNull).toBe(true);
    expect(columns.status.hasDefault).toBe(true);
    expect(columns.status.default).toBe("open");
    expect(columns.stageEnteredAt.hasDefault).toBe(true);
    expect(columns.isActive.default).toBe(true);
    expect(config.foreignKeys.map((fk) => fk.getName()).sort()).toEqual([
      "leads_assigned_rep_id_users_id_fk",
      "leads_company_id_companies_id_fk",
      "leads_primary_contact_id_contacts_id_fk",
      "leads_property_id_properties_id_fk",
    ]);
  });

  it("stores lead stage lineage separately from deals", () => {
    const columns = getTableColumns(leadStageHistory);
    const config = getTableConfig(leadStageHistory);

    expect(columns.leadId.name).toBe("lead_id");
    expect(columns.leadId.notNull).toBe(true);
    expect(columns.fromStageId.notNull).toBe(false);
    expect(columns.toStageId.notNull).toBe(true);
    expect(columns.changedBy.notNull).toBe(true);
    expect(config.foreignKeys.map((fk) => fk.getName()).sort()).toEqual([
      "lead_stage_history_changed_by_users_id_fk",
      "lead_stage_history_lead_id_leads_id_fk",
    ]);
  });

  it("adds nullable lineage fields to deals while enforcing one successor deal per lead", () => {
    const columns = getTableColumns(deals);
    const config = getTableConfig(deals);

    expect(columns.propertyId.name).toBe("property_id");
    expect(columns.propertyId.notNull).toBe(false);
    expect(columns.sourceLeadId.name).toBe("source_lead_id");
    expect(columns.sourceLeadId.notNull).toBe(false);
    expect(columns.sourceLeadId.isUnique).toBe(true);
    expect(config.foreignKeys.map((fk) => fk.getName())).toEqual(
      expect.arrayContaining([
        "deals_company_id_companies_id_fk",
        "deals_primary_contact_id_contacts_id_fk",
        "deals_property_id_properties_id_fk",
        "deals_source_lead_id_leads_id_fk",
      ])
    );
  });

  it("creates the properties, leads, and lineage migration contract", () => {
    expectSqlToMatch(
      /CREATE TABLE IF NOT EXISTS %I\.properties\s*\(\s*id UUID PRIMARY KEY DEFAULT gen_random_uuid\(\),\s*company_id UUID NOT NULL REFERENCES %I\.companies\(id\),\s*name VARCHAR\(500\) NOT NULL,/s
    );
    expectSqlToMatch(
      /CREATE TABLE IF NOT EXISTS %I\.leads\s*\(\s*id UUID PRIMARY KEY DEFAULT gen_random_uuid\(\),\s*company_id UUID NOT NULL REFERENCES %I\.companies\(id\),\s*property_id UUID NOT NULL REFERENCES %I\.properties\(id\),\s*primary_contact_id UUID REFERENCES %I\.contacts\(id\),[\s\S]*assigned_rep_id UUID NOT NULL REFERENCES public\.users\(id\),\s*status lead_status NOT NULL DEFAULT ''open''/s
    );
    expectSqlToMatch(
      /CREATE TABLE IF NOT EXISTS %I\.lead_stage_history\s*\(\s*id UUID PRIMARY KEY DEFAULT gen_random_uuid\(\),\s*lead_id UUID NOT NULL REFERENCES %I\.leads\(id\),[\s\S]*changed_by UUID NOT NULL REFERENCES public\.users\(id\),[\s\S]*duration_in_previous_stage INTERVAL/s
    );
    expectSqlToMatch(
      /ALTER TABLE %I\.deals\s+ADD COLUMN IF NOT EXISTS property_id UUID REFERENCES %I\.properties\(id\)/s
    );
    expectSqlToMatch(
      /ALTER TABLE %I\.deals\s+ADD COLUMN IF NOT EXISTS source_lead_id UUID REFERENCES %I\.leads\(id\)/s
    );
    expectSqlToMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS deals_source_lead_id_idx\s+ON %I\.deals \(source_lead_id\)\s+WHERE source_lead_id IS NOT NULL/s
    );
  });
});

describe("Lead Service", () => {
  it("creates a lead under a company and property", async () => {
    const tenantDb = createFakeTenantDb();
    const service = createLeadService({
      getStageById: async () => leadStage,
      now: () => new Date("2026-04-15T15:00:00.000Z"),
    });

    const lead = await service.createLead(tenantDb as never, {
      companyId: "company-1",
      propertyId: "property-1",
      stageId: "lead-stage-1",
      assignedRepId: "rep-1",
      name: "Palm Villas repaint",
      source: "Referral",
      description: "Property manager requested pre-bid walk",
    });

    expect(lead.companyId).toBe("company-1");
    expect(lead.propertyId).toBe("property-1");
    expect(lead.assignedRepId).toBe("rep-1");
    expect(lead.status).toBe("open");
    expect(lead.isActive).toBe(true);
    expect(tenantDb.state.leads).toHaveLength(1);
  });
});

describe("Lead Conversion Service", () => {
  it("converts one lead into one successor deal", async () => {
    const tenantDb = createFakeTenantDb({
      leads: [
        {
          id: "lead-1",
          companyId: "company-1",
          propertyId: "property-1",
          primaryContactId: null,
          name: "Palm Villas repaint",
          stageId: "lead-stage-1",
          assignedRepId: "rep-1",
          status: "open",
          source: "Referral",
          description: "Property manager requested pre-bid walk",
          stageEnteredAt: new Date("2026-04-12T15:00:00.000Z"),
          convertedAt: null,
          isActive: true,
          createdAt: new Date("2026-04-12T15:00:00.000Z"),
          updatedAt: new Date("2026-04-12T15:00:00.000Z"),
        },
      ],
    });
    const service = createLeadConversionService({
      now: () => new Date("2026-04-15T15:00:00.000Z"),
      createDeal: async (_tenantDb, input) => {
        const deal = {
          id: "deal-1",
          dealNumber: "TR-2026-0001",
          workflowRoute: input.workflowRoute ?? "estimating",
          primaryContactId: input.primaryContactId ?? null,
          companyId: input.companyId ?? null,
          propertyId: input.propertyId ?? null,
          sourceLeadId: input.sourceLeadId ?? null,
          source: input.source ?? null,
          assignedRepId: input.assignedRepId,
          stageId: input.stageId,
          name: input.name,
        };
        tenantDb.state.deals.push(deal);
        return deal as never;
      },
    });

    const result = await service.convertLead(tenantDb as never, {
      leadId: "lead-1",
      dealStageId: "deal-stage-1",
    });

    expect(result.deal.id).toBe("deal-1");
    expect(result.deal.sourceLeadId).toBe("lead-1");
    expect(result.lead.status).toBe("converted");
    expect(result.lead.convertedAt).toEqual(new Date("2026-04-15T15:00:00.000Z"));
    expect(tenantDb.state.deals).toHaveLength(1);
  });

  it("prevents multiple conversions from the same lead", async () => {
    const tenantDb = createFakeTenantDb({
      leads: [
        {
          id: "lead-1",
          companyId: "company-1",
          propertyId: "property-1",
          primaryContactId: null,
          name: "Palm Villas repaint",
          stageId: "lead-stage-1",
          assignedRepId: "rep-1",
          status: "open",
          source: "Referral",
          description: null,
          stageEnteredAt: new Date("2026-04-12T15:00:00.000Z"),
          convertedAt: null,
          isActive: true,
          createdAt: new Date("2026-04-12T15:00:00.000Z"),
          updatedAt: new Date("2026-04-12T15:00:00.000Z"),
        },
      ],
    });
    const service = createLeadConversionService({
      createDeal: async (_tenantDb, input) => {
        const deal = {
          id: `deal-${tenantDb.state.deals.length + 1}`,
          dealNumber: `TR-2026-000${tenantDb.state.deals.length + 1}`,
          workflowRoute: input.workflowRoute ?? "estimating",
          primaryContactId: input.primaryContactId ?? null,
          companyId: input.companyId ?? null,
          propertyId: input.propertyId ?? null,
          sourceLeadId: input.sourceLeadId ?? null,
          source: input.source ?? null,
          assignedRepId: input.assignedRepId,
          stageId: input.stageId,
          name: input.name,
        };
        tenantDb.state.deals.push(deal);
        return deal as never;
      },
    });

    await service.convertLead(tenantDb as never, {
      leadId: "lead-1",
      dealStageId: "deal-stage-1",
    });

    await expect(
      service.convertLead(tenantDb as never, {
        leadId: "lead-1",
        dealStageId: "deal-stage-1",
      })
    ).rejects.toMatchObject<AppError>({
      statusCode: 409,
      message: "Lead has already been converted",
    });
  });

  it("preserves lead ownership and lineage on conversion", async () => {
    const tenantDb = createFakeTenantDb({
      leads: [
        {
          id: "lead-1",
          companyId: "company-1",
          propertyId: "property-1",
          primaryContactId: null,
          name: "Palm Villas repaint",
          stageId: "lead-stage-1",
          assignedRepId: "rep-1",
          status: "open",
          source: "Referral",
          description: "Preserve lineage",
          stageEnteredAt: new Date("2026-04-12T15:00:00.000Z"),
          convertedAt: null,
          isActive: true,
          createdAt: new Date("2026-04-12T15:00:00.000Z"),
          updatedAt: new Date("2026-04-12T15:00:00.000Z"),
        },
      ],
    });
    const service = createLeadConversionService({
      createDeal: async (_tenantDb, input) => {
        const deal = {
          id: "deal-1",
          dealNumber: "TR-2026-0001",
          workflowRoute: input.workflowRoute ?? "estimating",
          primaryContactId: input.primaryContactId ?? null,
          companyId: input.companyId ?? null,
          propertyId: input.propertyId ?? null,
          sourceLeadId: input.sourceLeadId ?? null,
          source: input.source ?? null,
          assignedRepId: input.assignedRepId,
          stageId: input.stageId,
          name: input.name,
        };
        tenantDb.state.deals.push(deal);
        return deal as never;
      },
    });

    const result = await service.convertLead(tenantDb as never, {
      leadId: "lead-1",
      dealStageId: "deal-stage-1",
    });

    expect(result.deal.assignedRepId).toBe("rep-1");
    expect(result.deal.companyId).toBe("company-1");
    expect(result.deal.propertyId).toBe("property-1");
    expect(result.deal.sourceLeadId).toBe("lead-1");
    expect(result.deal.source).toBe("Referral");
  });
});
