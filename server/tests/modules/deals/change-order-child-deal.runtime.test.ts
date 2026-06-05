import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import {
  addDealChangeOrder,
  createChangeOrderChildDeal,
  deleteDealChangeOrder,
  getDealChangeOrderById,
  listDealChangeOrders,
  sumDealChangeOrders,
  updateDealChangeOrder,
} from "../../../src/modules/deals/change-order-service.js";
import { WON_STAGE_SLUGS } from "../../../src/modules/shared/pipeline-terminal-stages.js";

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
  await pg.exec(`
    CREATE TABLE pipeline_stage_config (
      id uuid PRIMARY KEY, name text NOT NULL, slug text UNIQUE NOT NULL, display_order int NOT NULL,
      workflow_family text NOT NULL DEFAULT 'standard_deal', is_active_pipeline boolean NOT NULL DEFAULT true,
      is_terminal boolean NOT NULL DEFAULT false
    );
    CREATE TABLE users (id uuid PRIMARY KEY, display_name text);
    CREATE TABLE deals (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), deal_number varchar(50) UNIQUE NOT NULL, name varchar(500) NOT NULL,
      stage_id uuid NOT NULL, assigned_rep_id uuid, company_id uuid, property_id uuid, source_lead_id uuid,
      awarded_amount numeric(14,2), won_closed_date date, contract_signed_date date,
      project_number text, office_code text, project_type text, project_type_id uuid, region_id uuid,
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
    INSERT INTO pipeline_stage_config (id, name, slug, display_order, is_terminal) VALUES
      ('${ST.won}','Won','${WON_SLUG}', 90, true), ('${ST.open}','Opportunity','opportunity', 30, false);
    INSERT INTO users (id, display_name) VALUES ('${REP}','Alice');
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

  it("delete is dual-path: removes a child deal row, and falls back to a legacy row", async () => {
    const p = U("e1003");
    await seedWonParent(p, "DFW-9-20003-aa", 100000);
    const child = await createChangeOrderChildDeal(tdb, { parentDealId: p, signedDate: "2026-06-01", amount: "1000", createdBy: REP });
    await deleteDealChangeOrder(tdb, { id: child.id, dealId: p });
    expect(await fetchDeal(child.id)).toBeUndefined(); // child deal row removed
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
});
