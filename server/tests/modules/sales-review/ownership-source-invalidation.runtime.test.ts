/**
 * PGlite harness for the two sales-source invalidation bypass guards.
 *
 * H1 — F9 resolved-fields bypass (lineage-resolver.ts):
 *   PATCH /deals/:id/resolved-fields can change workflow_route without going through updateDeal.
 *   writeResolvedDealFields must clear any stale sales-source attribution when the route transitions
 *   from 'service' to non-service, exactly as updateDeal does.
 *
 * H2 — F10 sales-review ownership-sync bypass (sales-review/ownership-sync-service.ts):
 *   reassignOwnedDeal writes assigned_rep_id directly without the updateDeal guard that rejects
 *   assigning a deal to its current source. When the new owner == the current source rep, the source
 *   must be cleared to prevent a double-commission cut.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import {
  auditLog,
  dealSignedCommissions,
  deals,
  users,
} from "@trock-crm/shared/schema";
import { tenantSchemaSql } from "../../helpers/tenant-schema-from-drizzle.js";
import { writeResolvedDealFields } from "../../../src/modules/deals/lineage-resolver.js";
import { reassignOwnedDeal } from "../../../src/modules/sales-review/ownership-sync-service.js";

// UUID helpers — 12 valid hex chars padded left with zeros.
const U = (s: string) => `00000000-0000-4000-8000-${s.padStart(12, "0")}`;
const ACTOR  = U("aa0000000001"); // admin actor
const SOURCE = U("bb0000000001"); // the sales-source rep
const OWNER  = U("cc0000000001"); // the deal's current owner
const OFFICE = U("ff0000000001"); // shared office id
const STAGE  = U("ee0000000001"); // dummy stage id (no FK in PGlite test)

// One deal per scenario so tests are independent.
const DEAL_H1 = U("d0100000de01"); // service deal with source — H1
const DEAL_H2 = U("d0200000de02"); // normal deal with source — H2

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tdb: any;
let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  // All tables into public so PGlite's default search_path resolves them; FK constraints are
  // intentionally omitted by tenantSchemaSql (it only reproduces column types + NOT NULL + PK).
  await pg.exec(
    tenantSchemaSql("public", [users, deals, dealSignedCommissions, auditLog])
  );
  tdb = drizzle(pg);

  // Users — needed by reassignOwnedDeal (fetches the target user to validate is_active + office).
  // The actor is passed as a plain object so only SOURCE and OWNER need DB rows.
  await pg.exec(`
    INSERT INTO public.users (id, display_name, email, role, office_id) VALUES
      ('${SOURCE}', 'Source Rep', 'source@t.dev', 'rep',   '${OFFICE}'),
      ('${OWNER}',  'Deal Owner', 'owner@t.dev',  'rep',   '${OFFICE}')
  `);

  // H1: service deal with a sales source.
  await pg.exec(`
    INSERT INTO public.deals (id, deal_number, name, stage_id, assigned_rep_id, workflow_route, sales_source_user_id)
    VALUES ('${DEAL_H1}', 'H001', 'Service Deal H1', '${STAGE}', '${OWNER}', 'service', '${SOURCE}')
  `);

  // H2: normal deal (no route change needed) with a sales source.
  await pg.exec(`
    INSERT INTO public.deals (id, deal_number, name, stage_id, assigned_rep_id, sales_source_user_id)
    VALUES ('${DEAL_H2}', 'H002', 'Normal Deal H2', '${STAGE}', '${OWNER}', '${SOURCE}')
  `);
}, 30_000);

afterAll(async () => {
  await pg?.close();
});

type DealSnapshot = {
  sales_source_user_id: string | null;
  assigned_rep_id: string | null;
  workflow_route: string;
};

async function fetchDeal(id: string): Promise<DealSnapshot> {
  const { rows } = await pg.query<DealSnapshot>(
    `SELECT sales_source_user_id, assigned_rep_id, workflow_route
     FROM public.deals WHERE id = $1`,
    [id]
  );
  if (!rows[0]) throw new Error(`Deal ${id} not found`);
  return rows[0];
}

// ---------------------------------------------------------------------------
// H1: resolved-fields workflowRoute service → normal clears the source
// ---------------------------------------------------------------------------
describe("H1: writeResolvedDealFields service→normal clears lineage-resolved sales source", () => {
  it("clears sales_source_user_id when workflow_route transitions from service to normal", async () => {
    const before = await fetchDeal(DEAL_H1);
    expect(before.sales_source_user_id).toBe(SOURCE);
    expect(before.workflow_route).toBe("service");

    await writeResolvedDealFields(
      tdb,
      DEAL_H1,
      { workflowRoute: "normal" },
      { userId: ACTOR, officeId: OFFICE, role: "admin" }
    );

    const after = await fetchDeal(DEAL_H1);
    expect(after.workflow_route).toBe("normal");
    // Source must be cleared: the service-source commission only applies to service-route deals.
    expect(after.sales_source_user_id).toBeNull();
  });

  it("preserves sales_source_user_id when workflow_route stays service", async () => {
    // Restore the service + source state for this sub-test.
    await pg.exec(`
      UPDATE public.deals
      SET workflow_route = 'service', sales_source_user_id = '${SOURCE}'
      WHERE id = '${DEAL_H1}'
    `);

    await writeResolvedDealFields(
      tdb,
      DEAL_H1,
      { workflowRoute: "service" },
      { userId: ACTOR, officeId: OFFICE, role: "admin" }
    );

    const after = await fetchDeal(DEAL_H1);
    expect(after.workflow_route).toBe("service");
    // Guard must not fire: the route did NOT leave service, so the source stays.
    expect(after.sales_source_user_id).toBe(SOURCE);
  });
});

// ---------------------------------------------------------------------------
// H2: sales-review reassignOwnedDeal → new owner == current source clears source
// ---------------------------------------------------------------------------
describe("H2: reassignOwnedDeal assigning deal to its current source clears the source", () => {
  it("clears sales_source_user_id and sets assigned_rep_id when new owner is the current source", async () => {
    const before = await fetchDeal(DEAL_H2);
    expect(before.sales_source_user_id).toBe(SOURCE);
    expect(before.assigned_rep_id).toBe(OWNER);

    await reassignOwnedDeal({
      tenantDb: tdb,
      actor: { id: ACTOR, role: "admin", activeOfficeId: OFFICE },
      dealId: DEAL_H2,
      userId: SOURCE, // assigning to the current sales-source rep → must clear the source
    });

    const after = await fetchDeal(DEAL_H2);
    // Owner slot is updated.
    expect(after.assigned_rep_id).toBe(SOURCE);
    // Source slot is cleared to prevent a double commission cut.
    expect(after.sales_source_user_id).toBeNull();
  });

  it("preserves sales_source_user_id when reassigning to a different rep", async () => {
    // Restore source + owner state for this sub-test.
    await pg.exec(`
      UPDATE public.deals
      SET sales_source_user_id = '${SOURCE}',
          assigned_rep_id      = '${OWNER}',
          ownership_sync_status = NULL
      WHERE id = '${DEAL_H2}'
    `);

    await reassignOwnedDeal({
      tenantDb: tdb,
      actor: { id: ACTOR, role: "admin", activeOfficeId: OFFICE },
      dealId: DEAL_H2,
      userId: OWNER, // assigning to the owner (≠ source) — source must NOT be cleared
    });

    const after = await fetchDeal(DEAL_H2);
    expect(after.assigned_rep_id).toBe(OWNER);
    // Guard must not fire when the new owner differs from the source.
    expect(after.sales_source_user_id).toBe(SOURCE);
  });
});
