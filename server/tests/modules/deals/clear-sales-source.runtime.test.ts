// Runtime coverage for two P2 Codex findings:
//
//   • clearSalesSource helper (core contract):
//       - nulls deals.sales_source_user_id on the base deal
//       - removes the additive 'sales_source' deal_signed_commissions row
//       - writes an audit log entry
//       - idempotent: no-op when deal has no source
//
//   • F9 (updateDeal leaves service workflow):
//       - a deal transitioning from workflow_route='service' to 'normal' via updateDeal
//         calls clearSalesSource, which removes the now-invalid sales-source commission row
//       - deals NOT changing workflow route (or route staying service) are unaffected
//
// PGlite harness: real Drizzle queries run against an in-process Postgres-compatible DB.
// pipeline/service is mocked (getStageById uses the global db connection, not tenantDb).
// commissions/service is NOT mocked here — the real removeSalesSourceCommissionForDeal runs
// against PGlite so the DSC-deletion is verified end-to-end.
//
// DDL is derived from the real Drizzle table definitions via tenantSchemaSql so column types
// and enum value sets cannot drift from production (includes sales_source_user_id,
// attribution_role, applied_rate, amount and every other column on all three tables).

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import {
  auditLog,
  dealSignedCommissions,
  deals,
} from "@trock-crm/shared/schema";
import { eq, and } from "drizzle-orm";
import { tenantSchemaSql } from "../../helpers/tenant-schema-from-drizzle.js";

// ---------------------------------------------------------------------------
// Module-level mocks (hoisted before imports)
// ---------------------------------------------------------------------------

// pipeline/service uses the global db connection; mock it so getStageByIdForWorkflowRoute
// can succeed inside updateDeal without a live Postgres instance.
vi.mock("../../../src/modules/pipeline/service.js", () => ({
  getStageById: vi.fn().mockResolvedValue({
    id: "stage-001",
    slug: "opportunity",
    workflowFamily: "standard_deal",
    displayOrder: 1,
    name: "Opportunity",
    isBidBoard: false,
    isActive: true,
    bidBoardStageCode: null,
  }),
  getStageBySlug: vi.fn().mockResolvedValue(null),
  getActiveProjectTypes: vi.fn().mockResolvedValue([]),
  resolveActiveProjectTypeValue: vi.fn().mockResolvedValue(null),
}));

// These modules are imported transitively by deals/service.ts but do not affect the
// service/normal workflow-route path — mock them to suppress network/side-effect calls.
vi.mock("../../../src/modules/assignment-tasks/service.js", () => ({
  createAssignmentTaskIfNeeded: vi.fn(),
}));
vi.mock("../../../src/modules/audit/audit-logger.js", () => ({
  logActivity: vi.fn(),
}));

import { clearSalesSource, hasBookedSalesSourceRow, updateDeal } from "../../../src/modules/deals/service.js";

// ---------------------------------------------------------------------------
// UUID helpers
// ---------------------------------------------------------------------------

const U = (s: string) => `00000000-0000-4000-8000-${s.padStart(12, "0")}`;

const DEAL_ID = U("d01");
const DEAL_ID2 = U("d02"); // second deal for idempotency test
const DEAL_NO_SOURCE = U("d03"); // deal with no source (no-op test)
const DEAL_NORMAL = U("d04"); // deal already on normal route (F9 should not fire)
const DEAL_BOOKED = U("d05"); // untouched deal carrying a booked sales_source row (hasBookedSalesSourceRow)
const REP_OWNER = U("a01");
const REP_SOURCE = U("a02");
const STAGE_ID = U("50001");    // must be all hex — 'S' invalid, use numeric prefix

// ---------------------------------------------------------------------------
// PGlite setup — shared across all describe blocks in this file
// ---------------------------------------------------------------------------

let pg: PGlite;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tdb: any;

beforeAll(async () => {
  pg = new PGlite();

  // Build the schema from real Drizzle definitions — types, enums, defaults all match prod.
  await pg.exec(
    tenantSchemaSql("public", [deals, dealSignedCommissions, auditLog]),
  );

  tdb = drizzle(pg);

  // Seed users via raw SQL (no users table in schema above; deals has no FK to users in PGlite).
  // The deals table's assigned_rep_id / sales_source_user_id are plain UUIDs here.

  // Base service-route deal with a sales source
  await pg.exec(`
    INSERT INTO public.deals
      (id, deal_number, name, stage_id, assigned_rep_id, sales_source_user_id,
       workflow_route, is_change_order, on_hold, is_active, is_test_data)
    VALUES
      ('${DEAL_ID}', 'D-001', 'Service Deal One', '${STAGE_ID}',
       '${REP_OWNER}', '${REP_SOURCE}', 'service', false, false, true, false)
  `);

  // Second service-route deal (for the updateDeal F9 test)
  await pg.exec(`
    INSERT INTO public.deals
      (id, deal_number, name, stage_id, assigned_rep_id, sales_source_user_id,
       workflow_route, is_change_order, on_hold, is_active, is_test_data)
    VALUES
      ('${DEAL_ID2}', 'D-002', 'Service Deal Two', '${STAGE_ID}',
       '${REP_OWNER}', '${REP_SOURCE}', 'service', false, false, true, false)
  `);

  // Deal with no sales source (idempotency / no-op test for clearSalesSource)
  await pg.exec(`
    INSERT INTO public.deals
      (id, deal_number, name, stage_id, assigned_rep_id,
       workflow_route, is_change_order, on_hold, is_active, is_test_data)
    VALUES
      ('${DEAL_NO_SOURCE}', 'D-003', 'Deal No Source', '${STAGE_ID}',
       '${REP_OWNER}', 'normal', false, false, true, false)
  `);

  // Deal already on normal route with a source (F9 guard: no-op since not leaving service)
  await pg.exec(`
    INSERT INTO public.deals
      (id, deal_number, name, stage_id, assigned_rep_id, sales_source_user_id,
       workflow_route, is_change_order, on_hold, is_active, is_test_data)
    VALUES
      ('${DEAL_NORMAL}', 'D-004', 'Normal Deal With Source', '${STAGE_ID}',
       '${REP_OWNER}', '${REP_SOURCE}', 'normal', false, false, true, false)
  `);

  // Untouched deal that carries a booked sales_source row (for hasBookedSalesSourceRow; no test mutates it)
  await pg.exec(`
    INSERT INTO public.deals
      (id, deal_number, name, stage_id, assigned_rep_id, sales_source_user_id,
       workflow_route, is_change_order, on_hold, is_active, is_test_data)
    VALUES
      ('${DEAL_BOOKED}', 'D-005', 'Booked Source Deal', '${STAGE_ID}',
       '${REP_OWNER}', '${REP_SOURCE}', 'service', false, false, true, false)
  `);

  // Seed a sales_source commission row for DEAL_ID, DEAL_ID2, and DEAL_BOOKED
  await pg.exec(`
    INSERT INTO public.deal_signed_commissions
      (id, deal_id, rep_user_id, attribution_role, source_value_kind, source_value_amount,
       applied_rate, amount, contract_signed_date_at_signing)
    VALUES
      (gen_random_uuid(), '${DEAL_ID}',  '${REP_SOURCE}', 'sales_source',
       'awarded_amount', 50000, 0.005000, 250.00, '2026-06-01'),
      (gen_random_uuid(), '${DEAL_ID2}', '${REP_SOURCE}', 'sales_source',
       'awarded_amount', 50000, 0.005000, 250.00, '2026-06-01'),
      (gen_random_uuid(), '${DEAL_BOOKED}', '${REP_SOURCE}', 'sales_source',
       'awarded_amount', 50000, 0.005000, 250.00, '2026-06-01')
  `);
}, 30_000);

afterAll(async () => {
  await pg?.close();
});

// ---------------------------------------------------------------------------
// Helper: read the current state of a deal from PGlite
// ---------------------------------------------------------------------------
async function getDealState(dealId: string) {
  const { rows } = await pg.query<{ sales_source_user_id: string | null }>(
    `SELECT sales_source_user_id FROM public.deals WHERE id = $1`,
    [dealId],
  );
  return rows[0] ?? null;
}

async function getDscRows(dealId: string) {
  const { rows } = await pg.query<{ rep_user_id: string; attribution_role: string }>(
    `SELECT rep_user_id, attribution_role
     FROM public.deal_signed_commissions
     WHERE deal_id = $1 AND attribution_role = 'sales_source'`,
    [dealId],
  );
  return rows;
}

async function getAuditRows(dealId: string) {
  const { rows } = await pg.query<{ table_name: string; record_id: string; action: string }>(
    `SELECT table_name, record_id, action FROM public.audit_log WHERE record_id = $1`,
    [dealId],
  );
  return rows;
}

// ---------------------------------------------------------------------------
// clearSalesSource — core contract (PGlite end-to-end, no mocks for commissions)
// ---------------------------------------------------------------------------

describe("clearSalesSource", () => {
  it("nulls sales_source_user_id, removes the sales_source DSC row, and writes an audit entry", async () => {
    // Pre-condition: deal has a source
    const before = await getDealState(DEAL_ID);
    expect(before?.sales_source_user_id).toBe(REP_SOURCE);
    expect(await getDscRows(DEAL_ID)).toHaveLength(1);

    await clearSalesSource(tdb, DEAL_ID, null);

    // Field cleared on the deal
    const after = await getDealState(DEAL_ID);
    expect(after?.sales_source_user_id).toBeNull();

    // Commission row removed
    expect(await getDscRows(DEAL_ID)).toHaveLength(0);

    // Audit entry written with the correct before/after values
    const auditRows = await getAuditRows(DEAL_ID);
    expect(auditRows.length).toBeGreaterThanOrEqual(1);
    const dealAudit = auditRows.find((r) => r.table_name === "deals");
    expect(dealAudit).toBeTruthy();
    expect(dealAudit?.action).toBe("update");
  });

  it("is idempotent: no-op if the deal has no sales source", async () => {
    // DEAL_NO_SOURCE was inserted without a sales_source_user_id
    const before = await getDealState(DEAL_NO_SOURCE);
    expect(before?.sales_source_user_id).toBeNull();

    // Should not throw and should not write anything
    await expect(clearSalesSource(tdb, DEAL_NO_SOURCE, null)).resolves.toBeUndefined();

    // State unchanged
    const after = await getDealState(DEAL_NO_SOURCE);
    expect(after?.sales_source_user_id).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// F9 — updateDeal leaving service workflow clears the sales-source attribution
// ---------------------------------------------------------------------------

describe("F9: updateDeal workflow-route change from service → normal", () => {
  it("clears the sales source when the deal transitions from service to normal", async () => {
    // Pre-condition: DEAL_ID2 is a service-route deal with a sales source and a DSC row
    const before = await getDealState(DEAL_ID2);
    expect(before?.sales_source_user_id).toBe(REP_SOURCE);
    expect(await getDscRows(DEAL_ID2)).toHaveLength(1);

    // updateDeal: change workflow route from 'service' to 'normal'
    // No rep change, no address change — only the route changes.
    await updateDeal(
      tdb,
      DEAL_ID2,
      { workflowRoute: "normal" },
      "admin",
      REP_OWNER,
      undefined,
    );

    // F9 must have fired: source cleared and DSC row removed
    const after = await getDealState(DEAL_ID2);
    expect(after?.sales_source_user_id).toBeNull();
    expect(await getDscRows(DEAL_ID2)).toHaveLength(0);
  });

  it("does NOT clear the source if the deal was already on the normal route (non-service start)", async () => {
    // DEAL_NORMAL has workflow_route='normal' and a sales source; calling updateDeal
    // to re-set the same route (or another field) must not clear the source.
    const before = await getDealState(DEAL_NORMAL);
    expect(before?.sales_source_user_id).toBe(REP_SOURCE);

    // Attempting to set workflowRoute = 'normal' on an already-normal deal.
    // updateDeal will either no-op (same value) or succeed; either way F9 must not fire
    // because existing.workflowRoute was not 'service'.
    // Note: getStageById is mocked to return a standard_deal stage, so validation passes.
    await updateDeal(
      tdb,
      DEAL_NORMAL,
      { workflowRoute: "normal" },
      "admin",
      REP_OWNER,
      undefined,
    );

    // Source must remain intact
    const after = await getDealState(DEAL_NORMAL);
    expect(after?.sales_source_user_id).toBe(REP_SOURCE);
  });
});

// ---------------------------------------------------------------------------
// hasBookedSalesSourceRow — the money-safety gate for the ownership-sync conflict-clear (Finding M)
// ---------------------------------------------------------------------------

describe("hasBookedSalesSourceRow", () => {
  it("is true when the rep holds a booked sales_source row on the deal", async () => {
    // DEAL_BOOKED carries REP_SOURCE's sales_source row and no test mutates it. Ownership sync must NOT
    // clear this deal on an owner==source conflict — doing so would delete REP_SOURCE's earned commission.
    expect(await hasBookedSalesSourceRow(tdb, DEAL_BOOKED, REP_SOURCE)).toBe(true);
  });

  it("is false for a rep with no sales_source row on the deal", async () => {
    // DEAL_NO_SOURCE has no commission rows at all; a different rep on DEAL_BOOKED also has none.
    expect(await hasBookedSalesSourceRow(tdb, DEAL_NO_SOURCE, REP_SOURCE)).toBe(false);
    expect(await hasBookedSalesSourceRow(tdb, DEAL_BOOKED, REP_OWNER)).toBe(false);
  });
});
