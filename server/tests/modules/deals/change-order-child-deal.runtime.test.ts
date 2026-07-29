import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import { users } from "@trock-crm/shared/schema";
import { isGenuineWonDealStageSlug } from "@trock-crm/shared/types";
import {
  addDealChangeOrder,
  createChangeOrderChildDeal,
  deleteDealChangeOrder,
  getDealChangeOrderById,
  listDealChangeOrders,
  softDeleteChangeOrderChildren,
  sumDealChangeOrders,
  updateDealChangeOrder,
} from "../../../src/modules/deals/change-order-service.js";
import { migrateLegacyChangeOrders } from "../../../src/modules/deals/change-order-migration.js";
import { getWonCloseSummary } from "../../../src/modules/dashboard/service.js";
import { WON_STAGE_SLUGS } from "../../../src/modules/shared/pipeline-terminal-stages.js";
import { tenantSchemaSql } from "../../helpers/tenant-schema-from-drizzle.js";

/**
 * REAL-SQL (PGlite) proof for Change Orders → real CHILD deals (PR1).
 *
 * A change order is created as its OWN Won deal: is_change_order=true, parent_deal_id set, stage=Won,
 * won_closed_date=the CO date, awarded_amount=the CO amount, company/property/rep inherited from the
 * parent, sharing the parent's project_number. The silent-vanish invariant (RED): a child is NEVER
 * created missing any of { Won stage, won_closed_date, awarded_amount, not-on-hold, not-test } — else
 * it would drop out of every Won total. Proven below as a hard guarantee.
 */
const U = (s: string) => `00000000-0000-0000-0000-${s.padStart(12, "0")}`;
const WON_SLUG = WON_STAGE_SLUGS[0];
const ST = { won: U("57001"), open: U("57002") };
const OFFICE = U("0f1");
const REP = U("a01");
const CO_NS = U("c0a"); // company
const PROP = U("d00f"); // property
const PARENT = U("d0001"); // Won parent
const BBO_PARENT = U("d0002"); // bid-board-owned parent NOT in a Won stage

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tdb: any;
let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`SET TimeZone='UTC';`);
  // `users` is generated from the REAL Drizzle table (tenant-schema-from-drizzle) rather than hand-rolled:
  // the commission mint paths read users.role (a pgEnum) and users.is_active to decide whether an estimator
  // / sales-source cut is payable, and a hand-rolled `role text` is exactly the enum drift that helper
  // exists to prevent (#674/#677). `deals` stays the deliberate hand-rolled island this suite is built on.
  await pg.exec(tenantSchemaSql("public", [users]));
  await pg.exec(`
    CREATE TABLE pipeline_stage_config (
      id uuid PRIMARY KEY, name text NOT NULL, slug text UNIQUE NOT NULL, display_order int NOT NULL,
      workflow_family text NOT NULL DEFAULT 'standard_deal', is_active_pipeline boolean NOT NULL DEFAULT true,
      is_terminal boolean NOT NULL DEFAULT false
    );
    CREATE TABLE deals (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), deal_number varchar(50) UNIQUE NOT NULL, name varchar(500) NOT NULL,
      stage_id uuid NOT NULL, assigned_rep_id uuid, company_id uuid, property_id uuid, source_lead_id uuid,
      awarded_amount numeric(14,2), bid_estimate numeric(14,2), dd_estimate numeric(14,2), bid_board_total_sales numeric(14,2),
      won_closed_date date, contract_signed_date date, contract_signed_at timestamptz,
      project_number text, office_code text, project_type text, project_type_id uuid, region_id uuid,
      pipeline_type_snapshot text NOT NULL DEFAULT 'normal', estimator_user_id uuid, sales_source_user_id uuid,
      source varchar(100), workflow_route text NOT NULL DEFAULT 'normal', created_by_user_id uuid,
      is_change_order boolean NOT NULL DEFAULT false, parent_deal_id uuid,
      is_bid_board_owned boolean NOT NULL DEFAULT false, on_hold boolean NOT NULL DEFAULT false,
      is_test_data boolean NOT NULL DEFAULT false, is_active boolean NOT NULL DEFAULT true,
      stage_entered_at timestamptz NOT NULL DEFAULT now(), description text,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX deals_project_number_uidx ON deals (project_number)
      WHERE project_number IS NOT NULL AND is_change_order = false;
    CREATE TABLE deal_number_daily_sequences (day_key text PRIMARY KEY, last_suffix text, updated_at timestamptz DEFAULT now());
    CREATE TABLE deal_change_orders (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), deal_id uuid NOT NULL, signed_date date NOT NULL,
      amount numeric(14,2) NOT NULL CHECK (amount > 0), description text,
      created_by uuid, updated_by uuid, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE audit_log (
      id bigserial PRIMARY KEY, table_name text NOT NULL, record_id uuid NOT NULL, action text NOT NULL,
      changed_by uuid, actor_name text, actor_role text, actor_system_process text, entity_type text,
      entity_name_snapshot text, entity_secondary_id_snapshot text, impersonator_id uuid,
      changes jsonb, field_changes_jsonb jsonb, full_row jsonb, visibility_scope text,
      ip_address text, user_agent varchar(500), created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE user_commission_settings (
      user_id uuid PRIMARY KEY, commission_rate numeric(7,6) NOT NULL DEFAULT 0, is_active boolean NOT NULL DEFAULT true,
      commission_structure text NOT NULL DEFAULT 'solo', capx_rate_solo numeric(7,6) NOT NULL DEFAULT 0,
      capx_rate_mixed numeric(7,6) NOT NULL DEFAULT 0, service_source_rate numeric(7,6) NOT NULL DEFAULT 0
    );
    CREATE TABLE deal_signed_commissions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), deal_id uuid NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
      rep_user_id uuid NOT NULL, attribution_role text NOT NULL DEFAULT 'owner', source_value_kind text NOT NULL,
      source_value_amount numeric(14,2) NOT NULL, applied_rate numeric(7,6) NOT NULL, amount numeric(14,2) NOT NULL,
      contract_signed_date_at_signing date NOT NULL, calculated_at timestamptz NOT NULL DEFAULT now(),
      created_by uuid, created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT deal_signed_commissions_dedup UNIQUE (deal_id, rep_user_id)
    );
    -- Prod-faithful stage-history backstop: migration 0143 attaches an AFTER INSERT trigger on deals that
    -- writes a deal_stage_history row, and that FK to deals(id) has NO ON DELETE CASCADE. So an app-created
    -- CO child always has a dependent history row → a hard row-delete would FK-violate. This reproduces the
    -- gap that masked P2c: deleteDealChangeOrder must SOFT-delete (is_active=false), never hard-delete.
    CREATE TABLE deal_stage_history (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), deal_id uuid NOT NULL REFERENCES deals(id),
      from_stage_id uuid, to_stage_id uuid NOT NULL, changed_by uuid NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE OR REPLACE FUNCTION record_stage_history_test() RETURNS trigger AS $$
    BEGIN
      IF TG_OP = 'INSERT' AND COALESCE(NEW.assigned_rep_id, NEW.created_by_user_id) IS NOT NULL THEN
        INSERT INTO deal_stage_history (deal_id, from_stage_id, to_stage_id, changed_by)
          VALUES (NEW.id, NULL, NEW.stage_id, COALESCE(NEW.assigned_rep_id, NEW.created_by_user_id));
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
    CREATE TRIGGER stage_history_trigger AFTER INSERT ON deals FOR EACH ROW EXECUTE FUNCTION record_stage_history_test();
    CREATE TABLE tasks (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), deal_id uuid,
      status text NOT NULL DEFAULT 'pending', is_overdue boolean NOT NULL DEFAULT false
    );
    INSERT INTO pipeline_stage_config (id, name, slug, display_order, is_terminal) VALUES
      ('${ST.won}','Won','${WON_SLUG}', 90, true), ('${ST.open}','Opportunity','opportunity', 30, false);
    INSERT INTO users (id, email, display_name, role, office_id) VALUES ('${REP}','alice@t.test','Alice','rep','${OFFICE}');
    INSERT INTO deals (id, deal_number, name, stage_id, assigned_rep_id, company_id, property_id, awarded_amount, won_closed_date, project_number, office_code, project_type, workflow_route, is_bid_board_owned) VALUES
      ('${PARENT}','DFW-9-10001-aa','Acme Tower Reroof','${ST.won}','${REP}','${CO_NS}','${PROP}', 500000, '2025-06-01', 'DFW-9-10001-aa', 'DFW', 'Roofing', 'normal', false),
      ('${BBO_PARENT}','DFW-9-10002-aa','Globex (Bid Board)','${ST.open}','${REP}','${CO_NS}','${PROP}', 250000, NULL, 'DFW-9-10002-aa', 'DFW', 'Roofing', 'normal', true);
  `);
  tdb = drizzle(pg);
});
afterAll(async () => {
  await pg?.close?.();
});

async function fetchDeal(id: string) {
  const rows = (await tdb.execute(sql`SELECT * FROM deals WHERE id = ${id}`)) as any;
  return (Array.isArray(rows) ? rows : rows.rows)[0];
}

describe("createChangeOrderChildDeal — a change order is its own Won child deal", () => {
  it("creates a Won child inheriting the parent's company/property/rep/project_number, attributed by the CO date", async () => {
    const child = await createChangeOrderChildDeal(tdb, {
      parentDealId: PARENT,
      signedDate: "2026-03-15",
      amount: "25000",
      description: "Added scope",
      createdBy: REP,
    });
    const row = await fetchDeal(child.id);
    expect(row.is_change_order).toBe(true);
    expect(row.parent_deal_id).toBe(PARENT);
    expect(row.stage_id).toBe(ST.won); // parent is Won → inherits the parent's Won stage
    expect(row.won_closed_date).toBe("2026-03-15"); // the CO's own date drives period attribution
    expect(Number(row.awarded_amount)).toBeCloseTo(25000, 2);
    expect(row.company_id).toBe(CO_NS);
    expect(row.property_id).toBe(PROP);
    expect(row.assigned_rep_id).toBe(REP);
    expect(row.project_number).toBe("DFW-9-10001-aa"); // SHARES the parent's number
    expect(row.deal_number).not.toBe("DFW-9-10001-aa"); // but has its OWN unique deal_number
    expect(String(row.name)).toContain("Change Order");
    expect(String(row.name)).toContain("Acme Tower Reroof");
  });

  it("silent-vanish invariant: the child always has Won stage + won_closed_date + awarded_amount + not on-hold/test", async () => {
    const child = await createChangeOrderChildDeal(tdb, { parentDealId: PARENT, signedDate: "2026-04-01", amount: "1000", createdBy: REP });
    const row = await fetchDeal(child.id);
    expect(row.stage_id).toBe(ST.won);
    expect(row.won_closed_date).not.toBeNull();
    expect(row.awarded_amount).not.toBeNull();
    expect(row.on_hold).toBe(false);
    expect(row.is_test_data).toBe(false);
  });

  it("shares the parent's project_number without tripping the unique index (CO exemption)", async () => {
    // Two COs on the same parent both carry DFW-9-10001-aa — allowed because is_change_order = true.
    await createChangeOrderChildDeal(tdb, { parentDealId: PARENT, signedDate: "2026-05-01", amount: "500", createdBy: REP });
    await createChangeOrderChildDeal(tdb, { parentDealId: PARENT, signedDate: "2026-05-02", amount: "600", createdBy: REP });
    const dup = (await tdb.execute(
      sql`SELECT COUNT(*)::int AS n FROM deals WHERE project_number = 'DFW-9-10001-aa' AND is_change_order = true`
    )) as any;
    expect(Number((Array.isArray(dup) ? dup : dup.rows)[0].n)).toBeGreaterThanOrEqual(2);
    // A NON-CO deal with the same project_number still violates the (exempted) unique index.
    await expect(
      tdb.execute(
        sql`INSERT INTO deals (deal_number, name, stage_id, project_number, is_change_order) VALUES ('DFW-9-99999-zz','Dup','${sql.raw(ST.won)}'::uuid,'DFW-9-10001-aa', false)`
      )
    ).rejects.toThrow();
  });

  it("a Bid-Board-Owned parent NOT in a Won stage still gets a Won child (canonical Won stage resolved)", async () => {
    const child = await createChangeOrderChildDeal(tdb, { parentDealId: BBO_PARENT, signedDate: "2026-06-01", amount: "7000", createdBy: REP });
    const row = await fetchDeal(child.id);
    // Parent is in 'opportunity' (non-Won); the child must still be Won so it never silently vanishes.
    expect(row.stage_id).toBe(ST.won);
    expect(row.is_change_order).toBe(true);
  });

  it("rejects a non-positive amount and an ineligible parent", async () => {
    await expect(createChangeOrderChildDeal(tdb, { parentDealId: PARENT, signedDate: "2026-03-15", amount: "0", createdBy: REP })).rejects.toThrow();
    await expect(createChangeOrderChildDeal(tdb, { parentDealId: U("deadbeef"), signedDate: "2026-03-15", amount: "100", createdBy: REP })).rejects.toThrow();
  });

  it("inherits the parent's service pipeline_type_snapshot + estimator attribution (report classification)", async () => {
    // A service-routed parent attributed to an estimator: the CO child must classify as 'service' (not the
    // default 'normal') and carry the same estimator, or report-builder (COALESCE(pipeline_type_snapshot,
    // workflow_route)) misclassifies the CO and estimator-filtered reports omit its revenue.
    const sp = U("e2001");
    const est = U("a02");
    await pg.exec(
      `INSERT INTO users (id, email, display_name, role, office_id) VALUES ('${est}','eve@t.test','Estimator Eve','rep','${OFFICE}')`
    );
    await pg.exec(
      `INSERT INTO deals (id, deal_number, name, stage_id, assigned_rep_id, company_id, property_id, awarded_amount, won_closed_date, project_number, office_code, project_type, workflow_route, is_bid_board_owned, pipeline_type_snapshot, estimator_user_id) VALUES ` +
        `('${sp}','DFW-9-30001-aa','Service Parent','${ST.won}','${REP}','${CO_NS}','${PROP}', 100000, '2025-07-01','DFW-9-30001-aa','DFW','Roofing','service', false, 'service', '${est}')`
    );
    const child = await createChangeOrderChildDeal(tdb, { parentDealId: sp, signedDate: "2026-04-01", amount: "5000", createdBy: REP });
    const row = await fetchDeal(child.id);
    expect(row.pipeline_type_snapshot).toBe("service");
    expect(row.estimator_user_id).toBe(est);
    expect(row.workflow_route).toBe("service"); // sanity: route inherited too
  });

  it("resolves the fallback Won stage within the parent's workflow family (service parent → service Won stage)", async () => {
    // Two Won stages with the SAME display_order — one standard (ST.won), one service. A service BBO parent
    // not in a Won stage must land its CO child on the SERVICE Won stage, not nondeterministically the standard one.
    const svcWon = U("57003");
    const svcParent = U("d0003");
    await pg.exec(
      `INSERT INTO pipeline_stage_config (id, name, slug, display_order, workflow_family, is_terminal) VALUES ('${svcWon}','Service Won','service_sent_to_production', 90, 'service_deal', true)`
    );
    await pg.exec(
      `INSERT INTO deals (id, deal_number, name, stage_id, assigned_rep_id, company_id, property_id, awarded_amount, won_closed_date, project_number, office_code, project_type, workflow_route, is_bid_board_owned) VALUES ` +
        `('${svcParent}','DFW-9-30009-aa','Service BBO Parent','${ST.open}','${REP}','${CO_NS}','${PROP}', 200000, NULL, 'DFW-9-30009-aa','DFW','Roofing','service', true)`
    );
    const child = await createChangeOrderChildDeal(tdb, { parentDealId: svcParent, signedDate: "2026-06-01", amount: "5000", createdBy: REP });
    expect((await fetchDeal(child.id)).stage_id).toBe(svcWon); // service-family Won stage, NOT the standard ST.won
  });

  it("truncates the generated CO child name to fit deals.name varchar(500) — long parent names still get COs", async () => {
    const lp = U("e1020");
    const longName = "X".repeat(498); // near the 500 limit; + suffix would overflow without truncation
    await pg.exec(
      `INSERT INTO deals (id, deal_number, name, stage_id, assigned_rep_id, company_id, property_id, awarded_amount, won_closed_date, project_number, office_code, project_type, workflow_route, is_bid_board_owned) VALUES ` +
        `('${lp}','DFW-9-30010-aa','${longName}','${ST.won}','${REP}','${CO_NS}','${PROP}', 100000, '2025-07-01','DFW-9-30010-aa','DFW','Roofing','normal', false)`
    );
    const child = await createChangeOrderChildDeal(tdb, { parentDealId: lp, signedDate: "2026-04-01", amount: "1000", createdBy: REP });
    const row = await fetchDeal(child.id);
    expect(row.name.length).toBeLessThanOrEqual(500);
    expect(String(row.name)).toContain("Change Order");
  });
});

async function seedWonParent(id: string, projectNumber: string, awarded: number) {
  await pg.exec(
    `INSERT INTO deals (id, deal_number, name, stage_id, assigned_rep_id, company_id, property_id, awarded_amount, won_closed_date, project_number, office_code, project_type, workflow_route, is_bid_board_owned) VALUES ` +
      `('${id}','${projectNumber}','Parent ${id.slice(-4)}','${ST.won}','${REP}','${CO_NS}','${PROP}', ${awarded}, '2025-07-01','${projectNumber}','DFW','Roofing','normal', false)`
  );
}

describe("CO CRUD on the child-deal model (counted exactly once across child + legacy rows)", () => {
  it("list + sum include child deals AND un-migrated legacy rows, each once; parent base never mutated", async () => {
    const p = U("e1001");
    await seedWonParent(p, "DFW-9-20001-aa", 300000);
    await createChangeOrderChildDeal(tdb, { parentDealId: p, signedDate: "2026-02-01", amount: "1000", createdBy: REP });
    await pg.exec(`INSERT INTO deal_change_orders (id, deal_id, signed_date, amount) VALUES ('${U("e1c01")}','${p}','2026-03-01', 2500)`);
    const list = await listDealChangeOrders(tdb, p);
    expect(list.length).toBe(2); // child + legacy, no overlap
    const sum = await sumDealChangeOrders(tdb, p);
    expect(Number(sum)).toBeCloseTo(3500, 2); // 1000 (child) + 2500 (legacy), counted once
    // sum === Σ(list) → CCV (= base + sum) agrees with the list by construction.
    expect(list.reduce((s, r) => s + Number(r.amount), 0)).toBeCloseTo(Number(sum), 2);
    // The parent's awarded base is untouched by COs → CCV = base + Σ COs, each dollar once.
    expect(Number((await fetchDeal(p)).awarded_amount)).toBeCloseTo(300000, 2);
  });

  it("update is dual-path: edits a child deal in place, and falls back to a legacy row", async () => {
    const p = U("e1002");
    await seedWonParent(p, "DFW-9-20002-aa", 100000);
    const child = await createChangeOrderChildDeal(tdb, { parentDealId: p, signedDate: "2026-04-01", amount: "1000", createdBy: REP });
    const updated = await updateDealChangeOrder(tdb, { id: child.id, dealId: p, amount: "1500", signedDate: "2026-05-01" });
    expect(Number(updated.amount)).toBeCloseTo(1500, 2);
    expect(updated.signedDate).toBe("2026-05-01");
    const row = await fetchDeal(child.id);
    expect(Number(row.awarded_amount)).toBeCloseTo(1500, 2);
    expect(row.won_closed_date).toBe("2026-05-01");
    await pg.exec(`INSERT INTO deal_change_orders (id, deal_id, signed_date, amount) VALUES ('${U("e1c02")}','${p}','2026-03-01', 700)`);
    const legacyUpdated = await updateDealChangeOrder(tdb, { id: U("e1c02"), dealId: p, amount: "800" });
    expect(Number(legacyUpdated.amount)).toBeCloseTo(800, 2);
  });

  it("delete is dual-path: SOFT-deletes a child deal (audit-preserving), and hard-removes a legacy row", async () => {
    const p = U("e1003");
    await seedWonParent(p, "DFW-9-20003-aa", 100000);
    const child = await createChangeOrderChildDeal(tdb, { parentDealId: p, signedDate: "2026-06-01", amount: "1000", createdBy: REP });
    await deleteDealChangeOrder(tdb, { id: child.id, dealId: p });
    const soft = await fetchDeal(child.id);
    expect(soft).toBeDefined(); // child deal row REMAINS (soft-delete, not hard-delete)
    expect(soft.is_active).toBe(false); // canonical delete marker (drives CO list/sum/search exclusion)
    expect(soft.on_hold).toBe(true); // tombstone: drops it from the on_hold-only Won rollups too
    // Legacy deal_change_orders rows are value-only (no deal triggers/FKs) → still hard-removed.
    await pg.exec(`INSERT INTO deal_change_orders (id, deal_id, signed_date, amount) VALUES ('${U("e1c03")}','${p}','2026-03-01', 700)`);
    const removed = await deleteDealChangeOrder(tdb, { id: U("e1c03"), dealId: p });
    expect(Number(removed.amount)).toBeCloseTo(700, 2);
  });

  it("getDealChangeOrderById returns a child (mapped) scoped to its parent", async () => {
    const p = U("e1004");
    await seedWonParent(p, "DFW-9-20004-aa", 100000);
    const child = await createChangeOrderChildDeal(tdb, { parentDealId: p, signedDate: "2026-04-01", amount: "1234", createdBy: REP });
    const got = await getDealChangeOrderById(tdb, child.id, p);
    expect(got?.id).toBe(child.id);
    expect(Number(got?.amount)).toBeCloseTo(1234, 2);
    expect(got?.dealId).toBe(p);
    expect(await getDealChangeOrderById(tdb, child.id, PARENT)).toBeNull(); // wrong parent
  });

  it("addDealChangeOrder creates the child even if commission calc is unavailable (resilient)", async () => {
    const p = U("e1005");
    await seedWonParent(p, "DFW-9-20005-aa", 100000);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // No commission config in this harness → calculateCommissionForDeal throws → caught; the CO is still created.
    const record = await addDealChangeOrder(tdb, { dealId: p, signedDate: "2026-07-01", amount: "2000", createdBy: REP });
    expect(record.dealId).toBe(p);
    expect(Number(record.amount)).toBeCloseTo(2000, 2);
    expect((await fetchDeal(record.id)).is_change_order).toBe(true);
    errSpy.mockRestore();
  });

  it("update/delete 404 when the change order is scoped to a different parent", async () => {
    const p = U("e1006");
    await seedWonParent(p, "DFW-9-20006-aa", 100000);
    const child = await createChangeOrderChildDeal(tdb, { parentDealId: p, signedDate: "2026-04-01", amount: "1000", createdBy: REP });
    await expect(updateDealChangeOrder(tdb, { id: child.id, dealId: PARENT, amount: "1500" })).rejects.toThrow(); // wrong parent
    await expect(deleteDealChangeOrder(tdb, { id: child.id, dealId: PARENT })).rejects.toThrow();
    expect((await getDealChangeOrderById(tdb, child.id, p))?.id).toBe(child.id); // untouched under the right parent
  });

  it("rejects a malformed signed date", async () => {
    await expect(createChangeOrderChildDeal(tdb, { parentDealId: PARENT, signedDate: "March 5", amount: "100", createdBy: REP })).rejects.toThrow();
    await expect(createChangeOrderChildDeal(tdb, { parentDealId: PARENT, signedDate: "2026-13-40", amount: "100", createdBy: REP })).rejects.toThrow();
  });

  it("sum does not overflow when the total exceeds the per-row NUMERIC(14,2) ceiling", async () => {
    const p = U("e1007");
    await seedWonParent(p, "DFW-9-20007-aa", 100000);
    // Two near-ceiling COs (each valid per-row); their sum exceeds the per-row ceiling — the wide
    // numeric(38,2) cast must absorb it rather than overflow.
    await createChangeOrderChildDeal(tdb, { parentDealId: p, signedDate: "2026-01-01", amount: "999999999999.99", createdBy: REP });
    await createChangeOrderChildDeal(tdb, { parentDealId: p, signedDate: "2026-02-01", amount: "999999999999.99", createdBy: REP });
    expect(Number(await sumDealChangeOrders(tdb, p))).toBeCloseTo(1999999999999.98, 2);
  });

  // Regression for addMoneyStrings' cross-source sign bug, split into three independently-observable cases
  // (a single it() would let case 3 hide behind case 2's failure, and case 1 doesn't discriminate at all —
  // see its own comment below). Deliberately NON-.00 amounts throughout: the old toCents added the
  // fraction's magnitude with the WRONG sign for a negative intPart, and BigInt("-0") collapsed to 0n so
  // any negative total under $1 lost its sign — both invisible on the whole-dollar (.00) amounts every
  // pre-existing sum test used.
  it("a deductive CO nets against an additive one on the SAME parent (does not discriminate the bug — Postgres nets same-source rows before addMoneyStrings ever sees them)", async () => {
    const p = U("e1030");
    await seedWonParent(p, "DFW-9-20030-aa", 300000);
    await createChangeOrderChildDeal(tdb, { parentDealId: p, signedDate: "2026-02-01", amount: "1000.50", createdBy: REP });
    await createChangeOrderChildDeal(tdb, { parentDealId: p, signedDate: "2026-03-01", amount: "-300.25", createdBy: REP });
    const sum = await sumDealChangeOrders(tdb, p);
    expect(sum).toBe("700.25");
    expect(Number(sum)).toBeCloseTo(700.25, 2);
  });

  it("a net-negative total under $1 in magnitude round-trips through sumDealChangeOrders — the '-0' sign-collapse case", async () => {
    // BigInt("-0") is 0n: the old toCents("-0.50") silently dropped the sign. Both COs are children of the
    // same parent, so Postgres nets them to -0.50 (a single, negative childSum) BEFORE addMoneyStrings
    // combines it with the (zero) legacySum — that combine step is where the old code lost the sign.
    const p2 = U("e1031");
    await seedWonParent(p2, "DFW-9-20031-aa", 300000);
    await createChangeOrderChildDeal(tdb, { parentDealId: p2, signedDate: "2026-02-01", amount: "200.00", createdBy: REP });
    await createChangeOrderChildDeal(tdb, { parentDealId: p2, signedDate: "2026-03-01", amount: "-200.50", createdBy: REP });
    const sum2 = await sumDealChangeOrders(tdb, p2);
    expect(sum2).toBe("-0.50");
    expect(Number(sum2)).toBeCloseTo(-0.5, 2);
  });

  it("a cross-source combination with a magnitude-≥-$1 negative operand round-trips — the wrong-magnitude case", async () => {
    // Cross-source (child sum + legacy sum) where the CHILD side alone is a magnitude-≥-$1 negative with a
    // nonzero fraction — the shape that trips the "wrong magnitude" defect independently of the "-0"
    // sign-collapse case above: old toCents("-300.25") computed -299.75, not -300.25 (it added the
    // fraction's magnitude with the wrong sign for a negative intPart).
    const p3 = U("e1033");
    await seedWonParent(p3, "DFW-9-20033-aa", 300000);
    await createChangeOrderChildDeal(tdb, { parentDealId: p3, signedDate: "2026-02-01", amount: "-300.25", createdBy: REP });
    await pg.exec(`INSERT INTO deal_change_orders (id, deal_id, signed_date, amount) VALUES ('${U("e1c31")}','${p3}','2026-03-01', 2500.00)`);
    const sum3 = await sumDealChangeOrders(tdb, p3);
    expect(sum3).toBe("2199.75"); // -300.25 + 2500.00; buggy code yields 2200.25 (off by exactly $0.50)
    expect(Number(sum3)).toBeCloseTo(2199.75, 2);
  });

  it("the legacy update branch rejects a negative amount fail-closed (400, not a raw DB CHECK 500)", async () => {
    // The legacy deal_change_orders.amount column still carries DB CHECK (amount > 0) (migration 0153) — it
    // is not gaining deductive support. normalizeChangeOrderAmount now permits negative for the child-deal
    // model, so this branch must reject it itself rather than let a surviving legacy row's CHECK violation
    // surface as a bare 500.
    const p = U("e1032");
    await seedWonParent(p, "DFW-9-20032-aa", 100000);
    await pg.exec(`INSERT INTO deal_change_orders (id, deal_id, signed_date, amount) VALUES ('${U("e1c30")}','${p}','2026-03-01', 700)`);
    await expect(
      updateDealChangeOrder(tdb, { id: U("e1c30"), dealId: p, amount: "-100" })
    ).rejects.toMatchObject({ statusCode: 400, code: "CHANGE_ORDER_AMOUNT_INVALID" });
    // Untouched by the rejected edit.
    const rows = (await tdb.execute(sql`SELECT amount FROM deal_change_orders WHERE id = ${U("e1c30")}`)) as any;
    const [row] = (Array.isArray(rows) ? rows : rows.rows) as Array<{ amount: string }>;
    expect(Number(row.amount)).toBeCloseTo(700, 2);
  });

  it("rejects nesting: a change order cannot be added to another change order (one level only)", async () => {
    const p = U("e1008");
    await seedWonParent(p, "DFW-9-20008-aa", 100000);
    const child = await createChangeOrderChildDeal(tdb, { parentDealId: p, signedDate: "2026-04-01", amount: "1000", createdBy: REP });
    // The child is itself a Won deal (would pass eligibility) — but COs must not nest.
    await expect(
      createChangeOrderChildDeal(tdb, { parentDealId: child.id, signedDate: "2026-05-01", amount: "500", createdBy: REP })
    ).rejects.toThrow();
  });

  it("update keeps contract_signed_date in sync with won_closed_date (matches create)", async () => {
    const p = U("e1009");
    await seedWonParent(p, "DFW-9-20009-aa", 100000);
    const child = await createChangeOrderChildDeal(tdb, { parentDealId: p, signedDate: "2026-04-01", amount: "1000", createdBy: REP });
    let row = await fetchDeal(child.id);
    expect(row.won_closed_date).toBe("2026-04-01");
    expect(row.contract_signed_date).toBe("2026-04-01"); // create sets both
    await updateDealChangeOrder(tdb, { id: child.id, dealId: p, signedDate: "2026-06-15" });
    row = await fetchDeal(child.id);
    expect(row.won_closed_date).toBe("2026-06-15");
    expect(row.contract_signed_date).toBe("2026-06-15"); // update moves both together
  });

  it("editing a CO amount recomputes the child's commission to the new value (one row, not a duplicate)", async () => {
    // A change order earns commission (decision). Commission must track the CURRENT CO value: a stale
    // commission after a CO amount edit is a real payout error. The recompute deletes + re-creates the
    // row atomically, so the edit yields exactly ONE row at the new amount — never a stale or duplicate row.
    const p = U("e1010");
    await seedWonParent(p, "DFW-9-20010-aa", 100000);
    await pg.exec(
      `INSERT INTO user_commission_settings (user_id, commission_rate, is_active) VALUES ('${REP}', 0.100000, true) ` +
        `ON CONFLICT (user_id) DO UPDATE SET commission_rate = EXCLUDED.commission_rate, is_active = true`
    );
    const child = await addDealChangeOrder(tdb, { dealId: p, signedDate: "2026-04-01", amount: "10000", createdBy: REP });
    const readCommissions = async () => {
      const r = (await tdb.execute(sql`SELECT amount FROM deal_signed_commissions WHERE deal_id = ${child.id}`)) as any;
      return (Array.isArray(r) ? r : r.rows) as Array<{ amount: string }>;
    };
    const before = await readCommissions();
    expect(before.length).toBe(1);
    expect(Number(before[0].amount)).toBeCloseTo(1000, 2); // $10,000 × 10%
    await updateDealChangeOrder(tdb, { id: child.id, dealId: p, amount: "25000", updatedBy: REP });
    const after = await readCommissions();
    expect(after.length).toBe(1); // recomputed in place — no second row
    expect(Number(after[0].amount)).toBeCloseTo(2500, 2); // $25,000 × 10%
  });

  it("a CO child carries a deal_stage_history row (trigger), so it is soft-deleted not hard-deleted (FK-safe)", async () => {
    const p = U("e1011");
    await seedWonParent(p, "DFW-9-20011-aa", 100000);
    const child = await createChangeOrderChildDeal(tdb, { parentDealId: p, signedDate: "2026-04-01", amount: "1000", createdBy: REP });
    const hist = (await tdb.execute(sql`SELECT count(*)::int AS n FROM deal_stage_history WHERE deal_id = ${child.id}`)) as any;
    expect(Number((Array.isArray(hist) ? hist : hist.rows)[0].n)).toBeGreaterThanOrEqual(1); // trigger fired on insert
    await expect(tdb.execute(sql`DELETE FROM deals WHERE id = ${child.id}`)).rejects.toThrow(); // hard delete → FK violation
    await deleteDealChangeOrder(tdb, { id: child.id, dealId: p }); // soft-delete sidesteps the FK
    expect((await fetchDeal(child.id)).is_active).toBe(false);
  });

  it("a soft-deleted CO child drops out of list/sum/getById (counted-once stays correct)", async () => {
    const p = U("e1013");
    await seedWonParent(p, "DFW-9-20013-aa", 100000);
    const child = await createChangeOrderChildDeal(tdb, { parentDealId: p, signedDate: "2026-04-01", amount: "1500", createdBy: REP });
    expect((await listDealChangeOrders(tdb, p)).length).toBe(1);
    await deleteDealChangeOrder(tdb, { id: child.id, dealId: p });
    expect((await listDealChangeOrders(tdb, p)).length).toBe(0);
    expect(Number(await sumDealChangeOrders(tdb, p))).toBeCloseTo(0, 2);
    expect(await getDealChangeOrderById(tdb, child.id, p)).toBeNull();
  });

  it("exposes childDealId on the list: real child deals carry it (deep-linkable), legacy rows are null", async () => {
    const p = U("e1012");
    await seedWonParent(p, "DFW-9-20012-aa", 100000);
    const child = await createChangeOrderChildDeal(tdb, { parentDealId: p, signedDate: "2026-04-01", amount: "1000", createdBy: REP });
    await pg.exec(`INSERT INTO deal_change_orders (id, deal_id, signed_date, amount) VALUES ('${U("e1c12")}','${p}','2026-03-01', 500)`);
    const list = await listDealChangeOrders(tdb, p);
    expect(list.find((r) => r.id === child.id)?.childDealId).toBe(child.id); // real child → /deals/{childDealId}
    expect(list.find((r) => r.id === U("e1c12"))?.childDealId).toBeNull(); // legacy row → no-op link
  });

  it("soft-deleting a parent cascades is_active=false to its CO children (no orphaned active Won; #19)", async () => {
    const p = U("e1014");
    await seedWonParent(p, "DFW-9-20014-aa", 100000);
    const c1 = await createChangeOrderChildDeal(tdb, { parentDealId: p, signedDate: "2026-04-01", amount: "1000", createdBy: REP });
    const c2 = await createChangeOrderChildDeal(tdb, { parentDealId: p, signedDate: "2026-05-01", amount: "2000", createdBy: REP });
    const ids = await softDeleteChangeOrderChildren(tdb, p);
    expect(ids.slice().sort()).toEqual([c1.id, c2.id].sort());
    const [r1, r2] = [await fetchDeal(c1.id), await fetchDeal(c2.id)];
    expect(r1.is_active).toBe(false);
    expect(r2.is_active).toBe(false);
    expect(r1.on_hold).toBe(true); // tombstone on cascade-voided children too
    expect(r2.on_hold).toBe(true);
  });

  it("rejects adding a change order to a soft-deleted (inactive) parent", async () => {
    const p = U("e1015");
    await pg.exec(
      `INSERT INTO deals (id, deal_number, name, stage_id, assigned_rep_id, awarded_amount, won_closed_date, project_number, office_code, project_type, workflow_route, is_bid_board_owned, is_active) VALUES ` +
        `('${p}','DFW-9-20015-aa','Deleted Parent','${ST.won}','${REP}', 100000, '2025-07-01','DFW-9-20015-aa','DFW','Roofing','normal', false, false)`
    );
    await expect(
      createChangeOrderChildDeal(tdb, { parentDealId: p, signedDate: "2026-04-01", amount: "1000", createdBy: REP })
    ).rejects.toThrow();
  });

  it("inherits the parent's test-data flag so a test parent's CO never leaks into real reports", async () => {
    const p = U("e1016");
    await pg.exec(
      `INSERT INTO deals (id, deal_number, name, stage_id, assigned_rep_id, awarded_amount, won_closed_date, project_number, office_code, project_type, workflow_route, is_bid_board_owned, is_test_data) VALUES ` +
        `('${p}','DFW-9-20016-aa','Test Parent','${ST.won}','${REP}', 100000, '2025-07-01','DFW-9-20016-aa','DFW','Roofing','normal', false, true)`
    );
    const child = await createChangeOrderChildDeal(tdb, { parentDealId: p, signedDate: "2026-04-01", amount: "1000", createdBy: REP });
    expect((await fetchDeal(child.id)).is_test_data).toBe(true);
  });

  it("removes the CO child's commission when it is soft-deleted, and on parent cascade (no lingering payout)", async () => {
    const countCommissions = async (id: string) => {
      const r = (await tdb.execute(sql`SELECT count(*)::int AS n FROM deal_signed_commissions WHERE deal_id = ${id}`)) as any;
      return Number((Array.isArray(r) ? r : r.rows)[0].n);
    };
    await pg.exec(
      `INSERT INTO user_commission_settings (user_id, commission_rate, is_active) VALUES ('${REP}', 0.100000, true) ` +
        `ON CONFLICT (user_id) DO UPDATE SET commission_rate = EXCLUDED.commission_rate, is_active = true`
    );
    // Direct CO delete removes its commission.
    const p1 = U("e1017");
    await seedWonParent(p1, "DFW-9-20017-aa", 100000);
    const c = await addDealChangeOrder(tdb, { dealId: p1, signedDate: "2026-04-01", amount: "10000", createdBy: REP });
    expect(await countCommissions(c.id)).toBe(1);
    await deleteDealChangeOrder(tdb, { id: c.id, dealId: p1, deletedBy: REP });
    expect(await countCommissions(c.id)).toBe(0);
    // Parent soft-delete cascade also removes the children's commissions.
    const p2 = U("e1018");
    await seedWonParent(p2, "DFW-9-20018-aa", 100000);
    const cc = await addDealChangeOrder(tdb, { dealId: p2, signedDate: "2026-04-01", amount: "5000", createdBy: REP });
    expect(await countCommissions(cc.id)).toBe(1);
    await softDeleteChangeOrderChildren(tdb, p2, REP);
    expect(await countCommissions(cc.id)).toBe(0);
  });

  it("dismisses the CO child's open tasks when it is deleted via the change-order endpoint", async () => {
    const p = U("e1019");
    await seedWonParent(p, "DFW-9-20019-aa", 100000);
    const child = await createChangeOrderChildDeal(tdb, { parentDealId: p, signedDate: "2026-04-01", amount: "1000", createdBy: REP });
    await pg.exec(
      `INSERT INTO tasks (id, deal_id, status) VALUES ('${U("70a")}','${child.id}','pending'),('${U("70b")}','${child.id}','in_progress')`
    );
    await deleteDealChangeOrder(tdb, { id: child.id, dealId: p, deletedBy: REP });
    const r = (await tdb.execute(sql`SELECT status FROM tasks WHERE deal_id = ${child.id}`)) as any;
    const statuses = (Array.isArray(r) ? r : r.rows).map((x: { status: string }) => x.status);
    expect(statuses.length).toBe(2);
    expect(statuses.every((s: string) => s === "dismissed")).toBe(true);
  });
});

describe("migrateLegacyChangeOrders — fix-forward (legacy rows → child deals, zero legacy)", () => {
  const countN = async (q: ReturnType<typeof sql>) => {
    const r = (await tdb.execute(q)) as any;
    return Number((Array.isArray(r) ? r : r.rows)[0].n);
  };

  it("dry-run classifies eligible vs blocked with NO writes; execute converts eligible + deletes their legacy rows", async () => {
    // Isolate from legacy rows left by earlier tests in this shared PGlite instance (the migration scans
    // deal_change_orders globally).
    await pg.exec("DELETE FROM deal_change_orders");
    const pa = U("f1001"); // active Won parent (eligible; fold already counted its COs)
    const pInactive = U("f1002"); // soft-deleted parent → CO is a blocker
    const pHold = U("f1003"); // active Won but ON HOLD → eligible, but the fold did NOT count its CO (newly-counted)
    await seedWonParent(pa, "DFW-9-40001-aa", 100000);
    await pg.exec(
      `INSERT INTO deals (id, deal_number, name, stage_id, assigned_rep_id, company_id, property_id, awarded_amount, won_closed_date, project_number, office_code, project_type, workflow_route, is_bid_board_owned, is_active, on_hold) VALUES ` +
        `('${pInactive}','DFW-9-40002-aa','Deleted Parent','${ST.won}','${REP}','${CO_NS}','${PROP}', 100000,'2025-07-01','DFW-9-40002-aa','DFW','Roofing','normal', false, false, false),` +
        `('${pHold}','DFW-9-40003-aa','On-Hold Parent','${ST.won}','${REP}','${CO_NS}','${PROP}', 100000,'2025-07-01','DFW-9-40003-aa','DFW','Roofing','normal', false, true, true)`
    );
    await pg.exec(
      `INSERT INTO deal_change_orders (id, deal_id, signed_date, amount) VALUES ` +
        `('${U("f1a1")}','${pa}','2026-02-01', 1000), ('${U("f1a2")}','${pa}','2026-03-01', 2500), ` +
        `('${U("f1b1")}','${pInactive}','2026-04-01', 9999), ('${U("f1c1")}','${pHold}','2026-05-01', 4000)`
    );

    // DRY-RUN: classify, no writes.
    const dry = await migrateLegacyChangeOrders(tdb, { dryRun: true });
    expect(dry.totalRows).toBe(4);
    expect(dry.eligibleCount).toBe(3); // pa's 2 + pHold's 1 (on-hold parent is still active+Won → eligible)
    expect(Number(dry.eligibleAmount)).toBeCloseTo(7500, 2); // 1000 + 2500 + 4000
    expect(dry.skippedCount).toBe(1); // inactive-parent CO = blocker (surfaced, not migrated)
    expect(Number(dry.skippedAmount)).toBeCloseTo(9999, 2);
    // The on-hold parent's CO ($4000) is "newly counted": the fold excluded it, the child counts → Won total rises by 4000.
    expect(Number(dry.newlyCountedAmount)).toBeCloseTo(4000, 2);
    expect(dry.migrated).toBe(0);
    expect(await countN(sql`SELECT count(*)::int AS n FROM deal_change_orders`)).toBe(4); // nothing written

    // EXECUTE: convert eligible → children + delete their legacy rows; the blocker remains (for resolution).
    const ex = await migrateLegacyChangeOrders(tdb, { dryRun: false });
    expect(ex.migrated).toBe(3);
    expect(ex.failedCount).toBe(0);
    expect(await countN(sql`SELECT count(*)::int AS n FROM deal_change_orders WHERE deal_id = ${pa}`)).toBe(0); // zero legacy under the active parent
    expect(await countN(sql`SELECT count(*)::int AS n FROM deals WHERE parent_deal_id = ${pa} AND is_change_order = true`)).toBe(2); // 2 child deals
    expect(await countN(sql`SELECT count(*)::int AS n FROM deal_change_orders WHERE deal_id = ${pInactive}`)).toBe(1); // blocker still surfaced
    // Migrated children carry the CO value (counted once via canonical Won; no commission fired by the migration).
    const sumRows = (await tdb.execute(sql`SELECT COALESCE(SUM(awarded_amount),0)::numeric AS s FROM deals WHERE parent_deal_id = ${pa} AND is_change_order = true`)) as any;
    expect(Number((Array.isArray(sumRows) ? sumRows : sumRows.rows)[0].s)).toBeCloseTo(3500, 2);
    expect(await countN(sql`SELECT count(*)::int AS n FROM deal_signed_commissions WHERE deal_id IN (SELECT id FROM deals WHERE parent_deal_id = ${pa})`)).toBe(0); // historical COs don't earn commission
  });
});

/**
 * DEDUCTIVE change orders, end to end — the behaviours the whole deductive-CO branch exists to produce.
 *
 * A deductive CO is a change order with a NEGATIVE amount: it REDUCES the parent's contract value instead
 * of adding to it. The write path accepts it (only 0 is meaningless), and every read path was made
 * sign-aware before that write path was opened. The two repo-owner decisions pinned here:
 *
 *   • COMMISSION CLAWS BACK. A deductive CO mints a NEGATIVE owner commission row, so a rep's earned
 *     commission always equals their rate applied to the CURRENT contract value and the drilldowns still
 *     reconcile. This needs NO change to the commissions module — resolveSourceValue picks the first
 *     NON-NULL candidate (awarded → bid → dd), not the first POSITIVE one, so a negative awarded_amount
 *     flows through as the source value. That is load-bearing, not incidental: "tidying" it into a `> 0`
 *     check would silently drop the claw-back (skipped_no_value, no row at all).
 *   • DEAL COUNTS ARE UNCHANGED. A deductive CO is +1 Won deal exactly as an additive one is, so the count
 *     predicates stay sign-agnostic while the VALUE aggregates are sign-aware.
 *
 * Dates here live in 2027 so the canonical Won window in the counting test can't pick up any CO seeded by
 * the suites above (all 2025/2026).
 */
const DED_EST = U("a03"); // estimator on the CO parent — distinct from the owner
const DED_SRC = U("a04"); // sales source on the CO parent — distinct from the owner AND the estimator

describe("deductive change orders (negative amount) — child deal, totals, commission, counts", () => {
  const DED_RATE = "0.100000"; // owner rate, so a −$50,000 CO claws back exactly −$5,000

  beforeAll(async () => {
    await pg.exec(
      `INSERT INTO users (id, email, display_name, role, office_id) VALUES ` +
        `('${DED_EST}','ded-est@t.test','Deductive Estimator','rep','${OFFICE}'),` +
        `('${DED_SRC}','ded-src@t.test','Deductive Source','director','${OFFICE}')`
    );
    // Every actor is RATED and payable, so "no estimator/sales-source row on a CO" below is provably the
    // change-order rule firing — not a missing rate quietly producing the same empty result.
    await pg.exec(
      `INSERT INTO user_commission_settings (user_id, commission_rate, is_active, commission_structure, capx_rate_solo, capx_rate_mixed, service_source_rate) VALUES ` +
        `('${REP}', ${DED_RATE}, true, 'solo', ${DED_RATE}, 0, 0),` +
        `('${DED_EST}', 0.050000, true, 'solo', 0.050000, 0, 0),` +
        `('${DED_SRC}', 0.020000, true, 'mixed', 0, 0.020000, 0.030000) ` +
        `ON CONFLICT (user_id) DO UPDATE SET commission_rate = EXCLUDED.commission_rate, is_active = true, ` +
        `commission_structure = EXCLUDED.commission_structure, capx_rate_solo = EXCLUDED.capx_rate_solo, ` +
        `capx_rate_mixed = EXCLUDED.capx_rate_mixed, service_source_rate = EXCLUDED.service_source_rate`
    );
  });

  const commissionRows = async (dealId: string) => {
    const r = (await tdb.execute(
      sql`SELECT rep_user_id, attribution_role, amount, source_value_amount, source_value_kind
          FROM deal_signed_commissions WHERE deal_id = ${dealId} ORDER BY attribution_role`
    )) as any;
    return (Array.isArray(r) ? r : r.rows) as Array<{
      rep_user_id: string;
      attribution_role: string;
      amount: string;
      source_value_amount: string;
      source_value_kind: string;
    }>;
  };

  it("creates a Won child deal carrying the NEGATIVE amount (the silent-vanish guard holds for a deduction)", async () => {
    const p = U("d0d01");
    await seedWonParent(p, "DFW-9-50001-aa", 500000);
    const co = await createChangeOrderChildDeal(tdb, {
      parentDealId: p,
      signedDate: "2027-03-15",
      amount: "-50000",
      description: "Removed scope",
      createdBy: REP,
    });
    const row = await fetchDeal(co.id);
    // The exact property set the SILENT-VANISH GUARD protects — a deduction must be a first-class Won
    // child, not a special case parked outside the Won population where its dollars would never land.
    expect(row.is_change_order).toBe(true);
    expect(row.parent_deal_id).toBe(p);
    expect(Number(row.awarded_amount)).toBeCloseTo(-50000, 2); // the deduction is stored SIGNED, not absolute
    expect(row.won_closed_date).toBe("2027-03-15"); // the CO's own date drives period attribution
    expect(row.on_hold).toBe(false); // not parked → its (negative) value is counted, never zeroed
    expect(row.is_test_data).toBe(false);
    expect(row.is_active).toBe(true);
    // A GENUINE Won stage, resolved through the same predicate the platform's Won population uses — not
    // merely "whatever stage the parent happened to sit in".
    const stageRows = (await tdb.execute(
      sql`SELECT slug FROM pipeline_stage_config WHERE id = ${row.stage_id}`
    )) as any;
    const slug = String((Array.isArray(stageRows) ? stageRows : stageRows.rows)[0].slug);
    expect(isGenuineWonDealStageSlug(slug, row.workflow_route)).toBe(true);
    // And the API record mirrors the stored sign (the Billing/Estimates cards read this shape).
    expect(Number(co.amount)).toBeCloseTo(-50000, 2);
  });

  it("nets out of the parent's change-order total: +20,000 and −50,000 sum to −30,000", async () => {
    const p = U("d0d02");
    await seedWonParent(p, "DFW-9-50002-aa", 500000);
    await createChangeOrderChildDeal(tdb, { parentDealId: p, signedDate: "2027-04-01", amount: "20000", createdBy: REP });
    await createChangeOrderChildDeal(tdb, { parentDealId: p, signedDate: "2027-04-02", amount: "-50000", createdBy: REP });
    // The deduction must SUBTRACT, not be dropped by a `> 0` candidate gate (which would report +20,000)
    // and not be absolutised (which would report +70,000).
    expect(Number(await sumDealChangeOrders(tdb, p))).toBeCloseTo(-30000, 2);
    // CCV = base + Σ COs, so the parent's contract value falls to 470,000 while its awarded base is untouched.
    expect(Number((await fetchDeal(p)).awarded_amount)).toBeCloseTo(500000, 2);
    // The list agrees with the sum by construction — both carry the sign.
    const list = await listDealChangeOrders(tdb, p);
    expect(list.length).toBe(2);
    expect(list.reduce((s, r) => s + Number(r.amount), 0)).toBeCloseTo(-30000, 2);
  });

  it("claws commission back: a deductive CO mints a NEGATIVE owner commission row (first NON-NULL source value)", async () => {
    const p = U("d0d03");
    await seedWonParent(p, "DFW-9-50003-aa", 500000);
    const co = await addDealChangeOrder(tdb, { dealId: p, signedDate: "2027-05-01", amount: "-50000", createdBy: REP });
    const rows = await commissionRows(co.id);
    expect(rows.length).toBe(1); // exactly one row — the owner's
    expect(rows[0].rep_user_id).toBe(REP); // the PARENT's assigned rep, inherited by the child
    expect(rows[0].attribution_role).toBe("owner");
    expect(Number(rows[0].amount)).toBeCloseTo(-5000, 2); // −$50,000 × 10% — the claw-back
    // THE LOAD-BEARING DETAIL: resolveSourceValue took awarded_amount because it is NON-NULL, not because
    // it is positive. Re-tightening that to "first POSITIVE candidate" makes it fall through to the (null)
    // bid/dd estimates → skipped_no_value → NO row at all, and the rep keeps commission on scope that was
    // removed. These two assertions are what would catch that "tidy-up".
    expect(rows[0].source_value_kind).toBe("awarded_amount");
    expect(Number(rows[0].source_value_amount)).toBeCloseTo(-50000, 2);
  });

  it("mints the OWNER cut only — never an estimator or sales-source row, even when both are set and rated", async () => {
    // A SERVICE parent carrying BOTH an estimator and a sales source, each distinct from the owner and each
    // holding an active, payable rate: on a normal signed deal this shape mints three rows. A change order
    // is base-deal-only (skipped_change_order), so it must mint exactly ONE.
    const p = U("d0d04");
    await pg.exec(
      `INSERT INTO deals (id, deal_number, name, stage_id, assigned_rep_id, company_id, property_id, awarded_amount, won_closed_date, contract_signed_date, project_number, office_code, project_type, workflow_route, pipeline_type_snapshot, is_bid_board_owned, estimator_user_id, sales_source_user_id) VALUES ` +
        `('${p}','DFW-9-50004-aa','Service Parent w/ Estimator + Source','${ST.won}','${REP}','${CO_NS}','${PROP}', 500000,'2025-07-01','2025-07-01','DFW-9-50004-aa','DFW','Roofing','service','service', false, '${DED_EST}','${DED_SRC}')`
    );
    const co = await addDealChangeOrder(tdb, { dealId: p, signedDate: "2027-06-01", amount: "-50000", createdBy: REP });
    // The child INHERITED both attributions, so the absent rows are the change-order rule firing — not the
    // estimator/source simply being missing from the row the mint paths read.
    const child = await fetchDeal(co.id);
    expect(child.estimator_user_id).toBe(DED_EST);
    expect(child.sales_source_user_id).toBe(DED_SRC);
    expect(child.workflow_route).toBe("service"); // the sales-source branch's own gate is satisfied too
    const rows = await commissionRows(co.id);
    expect(rows.length).toBe(1);
    expect(rows[0].rep_user_id).toBe(REP);
    expect(rows[0].attribution_role).toBe("owner");
    expect(rows.some((r) => r.rep_user_id === DED_EST)).toBe(false); // no estimator cut on a CO
    expect(rows.some((r) => r.rep_user_id === DED_SRC)).toBe(false); // no sales-source cut on a CO
    expect(rows.some((r) => r.attribution_role !== "owner")).toBe(false);
  });

  it("counts sign-agnostically: a deductive CO is +1 Won deal exactly like an additive one", async () => {
    // Counted through getWonCloseSummary — the CANONICAL Won count/value pair (won_closed_date basis,
    // reportable + is_active + non-test guards) that the dashboard Won card and the leaderboard read.
    // Its window is what isolates this assertion from every CO the suites above seeded.
    const p = U("d0d05");
    await seedWonParent(p, "DFW-9-50005-aa", 500000); // parent won 2025-07-01 → OUTSIDE the window below
    await createChangeOrderChildDeal(tdb, { parentDealId: p, signedDate: "2027-09-10", amount: "20000", createdBy: REP });
    await createChangeOrderChildDeal(tdb, { parentDealId: p, signedDate: "2027-09-20", amount: "-50000", createdBy: REP });
    const summary = await getWonCloseSummary(tdb, { from: "2027-09-01", to: "2027-09-30" });
    // COUNT is sign-agnostic — the deduction is a real signed change order, so it is a Won deal like any
    // other. VALUE is sign-aware. The two together are the decision: counts unchanged, dollars net out.
    expect(summary.count).toBe(2);
    expect(summary.totalValue).toBeCloseTo(-30000, 2);
  });
});
