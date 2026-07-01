import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findDealsByProjectNumber } from "../../../src/modules/synchub/procore-project-relay-service.js";

/**
 * Real-SQL guard for the SyncHub project-created relay's deal lookup.
 *
 * SyncHub creates the Procore project using the deal's canonical DFW/ATL project number and relays
 * that number back. For HubSpot-imported and bid-board deals the canonical number lives in
 * office_*.deals.project_number, while deal_number holds the HubSpot id (HS-…) or a divergent number
 * — so a deal_number-only lookup orphaned them and the "T Rock Photos" link was never created.
 *
 * findDealsByProjectNumber must therefore match on EITHER project_number OR deal_number, stay
 * is_active-scoped, and still surface >1 match so the caller can orphan ambiguity (never mis-link).
 */

const OFFICE = { id: "00000000-0000-4000-8000-000000000001", slug: "main" };
const OFFICES = [OFFICE];

let db: PGlite;
const client = () =>
  ({ query: (sql: string, params?: unknown[]) => db.query(sql, params as any[]) }) as any;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE SCHEMA office_main;
    CREATE TABLE office_main.deals (
      id text PRIMARY KEY,
      name text,
      deal_number text,
      project_number text,
      procore_project_id bigint,
      is_active boolean NOT NULL DEFAULT true
    );
    INSERT INTO office_main.deals (id, name, deal_number, project_number, procore_project_id, is_active) VALUES
      -- Recent HubSpot-imported deal: canonical Procore number is in project_number, deal_number is the HS id
      ('d-hubspot',  'Tides at Park Lane', 'HS-271393431285', 'DFW-1-13126-af', NULL, true),
      -- Legacy deal: canonical Procore number is in deal_number, project_number is null
      ('d-legacy',   'jasonn ranches',     'DFW-4-16226-ai',  NULL,             NULL, true),
      -- Inactive deal that would otherwise match by project_number
      ('d-inactive', 'Archived',           'HS-999',          'DFW-9-99999-zz', NULL, false),
      -- Two active deals collide on the same incoming number across the two columns (ambiguous)
      ('d-collide-a','Collide via project','HS-1',            'DFW-2-00000-aa', NULL, true),
      ('d-collide-b','Collide via deal',   'DFW-2-00000-aa',  NULL,             NULL, true);
  `);
});

afterAll(async () => {
  await db?.close();
});

describe("findDealsByProjectNumber", () => {
  it("matches a HubSpot-imported deal by project_number when deal_number differs", async () => {
    const matches = await findDealsByProjectNumber(client(), OFFICES, "DFW-1-13126-af");
    expect(matches).toHaveLength(1);
    expect(matches[0].dealId).toBe("d-hubspot");
    expect(matches[0].officeId).toBe(OFFICE.id);
    expect(matches[0].schemaName).toBe("office_main");
  });

  it("still matches a legacy deal by deal_number (project_number null)", async () => {
    const matches = await findDealsByProjectNumber(client(), OFFICES, "DFW-4-16226-ai");
    expect(matches).toHaveLength(1);
    expect(matches[0].dealId).toBe("d-legacy");
  });

  it("excludes inactive deals that would match by project_number", async () => {
    const matches = await findDealsByProjectNumber(client(), OFFICES, "DFW-9-99999-zz");
    expect(matches).toHaveLength(0);
  });

  it("surfaces >1 match when a number collides across project_number and deal_number (ambiguous → caller orphans)", async () => {
    const matches = await findDealsByProjectNumber(client(), OFFICES, "DFW-2-00000-aa");
    expect(matches.length).toBeGreaterThan(1);
  });
});
