import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getTableColumns } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import {
  LEAD_STATUSES,
  deals,
  leadStageHistory,
  leads,
  properties,
} from "../../helpers/worktree-shared-contracts.js";
import { describe, expect, it } from "vitest";

const migrationPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../migrations/0019_properties_and_leads.sql"
);
const migrationSql = readFileSync(migrationPath, "utf8");

function expectSqlToMatch(pattern: RegExp): void {
  expect(migrationSql).toMatch(pattern);
}

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
