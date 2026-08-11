// Executes Migration 0206 FROM DISK, layered on 0184 FROM DISK, against a real Postgres (PGlite).
//
// 0184 alerts leadership when a published Won figure FALLS. It does not fire for a DEDUCTIVE change order,
// and two independent halves are why — either one alone leaves the alert inert:
//
//   (a) THERE IS NO INSERT TRIGGER. 0184 installs won_metric_reduction_update_trg (AFTER UPDATE OF ...) and
//       won_metric_reduction_delete_trg (AFTER DELETE). Creating a deductive CO INSERTS a child deal, so
//       capture_won_metric_reduction never runs at all — no event, no email.
//   (b) THE IMPACT CHAIN ZEROES NEGATIVES. won_metric_reduction_impacts resolves old_value/new_value through
//       a `> 0`-gated fallback chain with an `ELSE 0` fallback, so a negative awarded_amount computes as 0.
//       The canonical calls pass p_exclude_change_orders = false, so the CO IS in scope — it just measures
//       as zero. (a) without (b) is a trigger that fires and computes an empty impacts map and returns.
//
// Both halves ship in ONE migration. Each `it()` below names which half it pins, so reverting a half in
// isolation fails a known, named subset.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { WON_DEAL_STAGE_SLUGS } from "@trock-crm/shared/types";

const MIGRATIONS_DIR = join(__dirname, "../../../migrations");
const BASE_SQL = readFileSync(join(MIGRATIONS_DIR, "0184_won_metric_reduction_alerts.sql"), "utf-8");
const MIGRATION_PATH = join(MIGRATIONS_DIR, "0206_won_metric_reduction_deductive_change_orders.sql");
const MIGRATION_SQL = readFileSync(MIGRATION_PATH, "utf-8");

const START_MARKER = "-- TENANT_SCHEMA_START";
const END_MARKER = "-- TENANT_SCHEMA_END";

/** The office provisioner's own extraction, mirrored: the block between the markers with the
 *  office_dallas placeholder rewritten to the target schema. (server/src/modules/office/service.ts) */
function tenantBlockFor(schema: string): string {
  const startIdx = MIGRATION_SQL.indexOf(START_MARKER);
  const endIdx = MIGRATION_SQL.indexOf(END_MARKER);
  return MIGRATION_SQL.substring(startIdx + START_MARKER.length, endIdx)
    .trim()
    .replaceAll("office_dallas", schema);
}

const OFFICE = "00000000-0000-4000-8000-000000000010";
const REP = "00000000-0000-4000-8000-000000000011";
const WON_STAGE = "00000000-0000-4000-8000-000000000012";
const OPEN_STAGE = "00000000-0000-4000-8000-000000000013";
const PARENT_DEAL = "00000000-0000-4000-8000-000000000014";
const DEDUCTIVE_CO = "00000000-0000-4000-8000-000000000015";
const ADDITIVE_CO = "00000000-0000-4000-8000-000000000016";
const PLAIN_WON = "00000000-0000-4000-8000-000000000017";
const EDITED_CO = "00000000-0000-4000-8000-000000000018";
const ESTIMATOR = "00000000-0000-4000-8000-000000000019";
const NEXT_ESTIMATOR = "00000000-0000-4000-8000-00000000001a";

let pg: PGlite | null = null;

afterEach(async () => {
  await pg?.close();
  pg = null;
});

/** The 0184 runtime fixture's tenant shape, plus 0156's change-order child columns. */
async function setup(options: { apply0206?: boolean } = {}): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    CREATE TYPE public.notification_type AS ENUM ('system');
    CREATE TABLE public.offices (
      id uuid PRIMARY KEY,
      slug text NOT NULL UNIQUE,
      is_active boolean NOT NULL DEFAULT true
    );
    INSERT INTO public.offices (id, slug) VALUES ('${OFFICE}', 'dallas');
    CREATE TABLE public.pipeline_stage_config (
      id uuid PRIMARY KEY,
      slug text NOT NULL
    );
    INSERT INTO public.pipeline_stage_config (id, slug) VALUES
      ('${WON_STAGE}', 'won'),
      ('${OPEN_STAGE}', 'estimating');
    CREATE TABLE public.job_queue (
      id bigserial PRIMARY KEY,
      job_type text NOT NULL,
      payload jsonb NOT NULL,
      office_id uuid,
      status text NOT NULL,
      run_after timestamptz NOT NULL DEFAULT now()
    );
    CREATE SCHEMA office_dallas;
    CREATE TABLE office_dallas.deals (
      id uuid PRIMARY KEY,
      deal_number text,
      name text NOT NULL,
      stage_id uuid NOT NULL,
      bid_board_stage_slug text,
      won_closed_date date,
      is_active boolean NOT NULL DEFAULT true,
      is_test_data boolean NOT NULL DEFAULT false,
      is_change_order boolean NOT NULL DEFAULT false,
      parent_deal_id uuid,
      on_hold boolean NOT NULL DEFAULT false,
      assigned_rep_id uuid,
      estimator_user_id uuid,
      awarded_amount numeric,
      bid_board_total_sales numeric,
      bid_estimate numeric,
      dd_estimate numeric
    );
    CREATE TABLE office_dallas.audit_log (
      id bigserial PRIMARY KEY,
      table_name text NOT NULL,
      record_id uuid NOT NULL,
      action text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE OR REPLACE FUNCTION public.test_audit_deals()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        INSERT INTO office_dallas.audit_log (table_name, record_id, action)
        VALUES ('deals', OLD.id, lower(TG_OP));
        RETURN OLD;
      END IF;
      INSERT INTO office_dallas.audit_log (table_name, record_id, action)
      VALUES ('deals', NEW.id, lower(TG_OP));
      RETURN NEW;
    END;
    $$;
    -- Named 'audit_deals' so it sorts BEFORE won_metric_reduction_* and the citation lookup finds its row,
    -- exactly as the deployed per-tenant audit trigger does.
    CREATE TRIGGER audit_deals
      AFTER INSERT OR UPDATE OR DELETE ON office_dallas.deals
      FOR EACH ROW EXECUTE FUNCTION public.test_audit_deals();
  `);
  await db.exec(BASE_SQL);
  if (options.apply0206 ?? true) {
    await db.exec(MIGRATION_SQL);
  }
  await db.query("SELECT public.enable_won_metric_reduction_alert_delivery()");
  return db;
}

function json(value: unknown): Record<string, any> {
  return typeof value === "string" ? JSON.parse(value) : (value as Record<string, any>);
}

/** A Won parent deal — the thing a change order hangs off. */
async function insertWonParent(db: PGlite, id = PARENT_DEAL, value = 300000): Promise<void> {
  // Won periods are evaluated in Chicago; session CURRENT_DATE is a day ahead on a UTC runner between
  // UTC and Chicago midnight, which would future-date this otherwise-current fixture.
  await db.query(
    `INSERT INTO office_dallas.deals (id, deal_number, name, stage_id, won_closed_date, assigned_rep_id, awarded_amount)
     VALUES ($1, 'TR-100', 'Won parent', $2, (now() AT TIME ZONE 'America/Chicago')::date, $3, $4)`,
    [id, WON_STAGE, REP, value],
  );
}

/** A change-order CHILD deal (0156): real row, is_change_order = true, created Won, value in awarded_amount. */
async function insertChangeOrder(db: PGlite, id: string, amount: number): Promise<void> {
  await db.query(
    `INSERT INTO office_dallas.deals (
       id, deal_number, name, stage_id, won_closed_date, assigned_rep_id, awarded_amount, is_change_order, parent_deal_id
     ) VALUES ($1, 'TR-100-CO', 'Change order', $2, (now() AT TIME ZONE 'America/Chicago')::date, $3, $4, true, $5)`,
    [id, WON_STAGE, REP, amount, PARENT_DEAL],
  );
}

async function eventsFor(db: PGlite, dealId: string) {
  return db.query<{
    reason_code: string;
    action_label: string;
    impacts: unknown;
    old_snapshot: unknown;
    new_snapshot: unknown;
    audit_reference: unknown;
  }>(
    `SELECT reason_code, action_label, impacts, old_snapshot, new_snapshot, audit_reference
     FROM public.won_metric_reduction_events WHERE deal_id = $1`,
    [dealId],
  );
}

async function alertJobCount(db: PGlite): Promise<number> {
  const { rows } = await db.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM public.job_queue WHERE job_type = 'won_metric_reduction_alert'`,
  );
  return Number(rows[0]?.count ?? 0);
}

describe("Migration 0206 — Won-reduction alerts fire for deductive change orders", () => {
  it("carries BOTH required blocks: the office_% DO-loop AND the TENANT_SCHEMA provisioner section", () => {
    expect(MIGRATION_SQL).toContain("DO $tenant$");
    expect(MIGRATION_SQL).toMatch(/nspname LIKE 'office\\_%' ESCAPE '\\'|nspname ~ '\^office_'/);
    expect(MIGRATION_SQL).toContain(START_MARKER);
    expect(MIGRATION_SQL).toContain(END_MARKER);
    // The provisioner clones ONLY the marker block, so a NEW office gets the INSERT trigger only if it is
    // inside the block — a DO-loop-only migration leaves every future tenant without the alert.
    const block = tenantBlockFor("office_dallas");
    expect(block).toContain("won_metric_reduction_insert_trg");
    expect(block).toMatch(/AFTER INSERT\s+ON office_dallas\.deals/);
    // The provisioner takes the FIRST occurrence of the start marker, so spelling the marker out in a
    // header comment silently truncates the clone into un-parseable prose. Pin that the block begins at DDL.
    expect(block.startsWith("DROP TRIGGER IF EXISTS")).toBe(true);
  });

  // ---- half (a): the missing INSERT trigger -------------------------------------------------------

  it("REPRODUCES half (a) on 0184 alone: creating a deductive CO produces NO event at all", async () => {
    pg = await setup({ apply0206: false });
    await insertWonParent(pg);

    await insertChangeOrder(pg, DEDUCTIVE_CO, -50000);

    expect((await eventsFor(pg, DEDUCTIVE_CO)).rows).toHaveLength(0);
    const triggers = await pg.query<{ tgname: string }>(
      `SELECT t.tgname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'office_dallas' AND c.relname = 'deals' AND t.tgname = 'won_metric_reduction_insert_trg'`,
    );
    expect(triggers.rows).toHaveLength(0);
  });

  it("creating a deductive change order produces a durable event carrying the negative impact", async () => {
    pg = await setup();
    await insertWonParent(pg);

    await insertChangeOrder(pg, DEDUCTIVE_CO, -50000);

    const { rows } = await eventsFor(pg, DEDUCTIVE_CO);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.reason_code).toBe("deductive_change_order_created");
    expect(rows[0]?.action_label).toBe("Deductive change order created");
    const impacts = json(rows[0]?.impacts);
    // "Old contribution" for a row that did not exist is ZERO on every metric — countBefore 0, before 0.
    for (const metric of ["won_all_time", "won_ytd", "won_qtd", "won_mtd", "won_wtd"]) {
      expect(impacts[`office.${metric}`]).toMatchObject({
        metric,
        countBefore: 0,
        countAfter: 1,
        countDelta: 1,
        before: 0,
        after: -50000,
        delta: -50000,
      });
    }
    expect(impacts[`assigned_rep.${REP}.won_ytd`]).toMatchObject({
      scope: "assigned_rep",
      scopeId: REP,
      before: 0,
      after: -50000,
      delta: -50000,
    });
    // The event must be recognised as a REDUCTION, or the worker skips it as a non-negative aggregate.
    const reduction = await pg.query<{ has_reduction: boolean }>(
      `SELECT public.won_metric_impacts_have_reduction(impacts) AS has_reduction
       FROM public.won_metric_reduction_events WHERE deal_id = $1`,
      [DEDUCTIVE_CO],
    );
    expect(reduction.rows[0]?.has_reduction).toBe(true);
    // The pre-existing row is untouched: the insert's "before" is the deal's own absence, not the office total.
    expect(json(rows[0]?.old_snapshot)).toEqual({});
    expect(json(rows[0]?.new_snapshot).isChangeOrder).toBe(true);
    expect(json(rows[0]?.audit_reference).auditLogIds).toHaveLength(1);
    expect(await alertJobCount(pg)).toBe(1);
  });

  it("creating an ADDITIVE change order produces NO event", async () => {
    pg = await setup();
    await insertWonParent(pg);

    await insertChangeOrder(pg, ADDITIVE_CO, 25000);

    expect((await eventsFor(pg, ADDITIVE_CO)).rows).toHaveLength(0);
    expect(await alertJobCount(pg)).toBe(0);
  });

  it("creating an ORDINARY Won deal produces NO event — a reduction detector must not fire on every win", async () => {
    pg = await setup();

    await insertWonParent(pg, PLAIN_WON, 750000);

    expect((await eventsFor(pg, PLAIN_WON)).rows).toHaveLength(0);
    expect(await alertJobCount(pg)).toBe(0);
    // Not merely "no event": no row at all, so a later sweep cannot resurrect it.
    const all = await pg.query(`SELECT id FROM public.won_metric_reduction_events`);
    expect(all.rows).toHaveLength(0);
  });

  it("creating a Won deal with every value column NULL produces NO event", async () => {
    pg = await setup();
    await pg.query(
      `INSERT INTO office_dallas.deals (id, deal_number, name, stage_id, won_closed_date, assigned_rep_id)
       VALUES ($1, 'TR-NULL', 'Valueless Won deal', $2, (now() AT TIME ZONE 'America/Chicago')::date, $3)`,
      [PLAIN_WON, WON_STAGE, REP],
    );

    expect((await eventsFor(pg, PLAIN_WON)).rows).toHaveLength(0);
  });

  it("creating a deductive CO in a NON-Won stage produces NO event — it was never in a published figure", async () => {
    pg = await setup();
    await insertWonParent(pg);
    await pg.query(
      `INSERT INTO office_dallas.deals (
         id, deal_number, name, stage_id, won_closed_date, assigned_rep_id, awarded_amount, is_change_order, parent_deal_id
       ) VALUES ($1, 'TR-100-CO', 'Open change order', $2, NULL, $3, -50000, true, $4)`,
      [DEDUCTIVE_CO, OPEN_STAGE, REP, PARENT_DEAL],
    );

    expect((await eventsFor(pg, DEDUCTIVE_CO)).rows).toHaveLength(0);
  });

  // ---- half (b): the > 0-gated chain that zeroes a negative ----------------------------------------

  it("REPRODUCES half (b) on 0184 alone: editing a deductive CO further downward produces NO event", async () => {
    pg = await setup({ apply0206: false });
    await insertWonParent(pg);
    await insertChangeOrder(pg, EDITED_CO, -10000);

    await pg.query(`UPDATE office_dallas.deals SET awarded_amount = -25000 WHERE id = $1`, [EDITED_CO]);

    // The UPDATE trigger DOES fire here — both snapshots simply resolve to 0, so impacts is '{}'.
    expect((await eventsFor(pg, EDITED_CO)).rows).toHaveLength(0);
  });

  it("editing a deductive CO's amount further downward produces an event with the true negative delta", async () => {
    pg = await setup();
    await insertWonParent(pg);
    await insertChangeOrder(pg, EDITED_CO, -10000);
    // Creation is its own transaction and mints its own event (half (a)); clear it so this case pins the
    // EDIT in isolation — otherwise a passing half (a) would mask a reverted half (b).
    await pg.exec(`DELETE FROM public.won_metric_reduction_events`);

    await pg.query(`UPDATE office_dallas.deals SET awarded_amount = -25000 WHERE id = $1`, [EDITED_CO]);

    const { rows } = await eventsFor(pg, EDITED_CO);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.reason_code).toBe("won_value_reduced");
    expect(json(rows[0]?.impacts)["office.won_ytd"]).toMatchObject({
      countBefore: 1,
      countAfter: 1,
      countDelta: 0,
      before: -10000,
      after: -25000,
      delta: -15000,
    });
  });

  it("deleting a deductive CO reads as an INCREASE, never a reduction", async () => {
    pg = await setup();
    await insertWonParent(pg);
    await insertChangeOrder(pg, DEDUCTIVE_CO, -50000);
    await pg.exec(`DELETE FROM public.won_metric_reduction_events`);

    await pg.query(`DELETE FROM office_dallas.deals WHERE id = $1`, [DEDUCTIVE_CO]);

    const { rows } = await eventsFor(pg, DEDUCTIVE_CO);
    expect(rows).toHaveLength(1);
    const impacts = json(rows[0]?.impacts);
    // Removing a −$50k deduction RAISES published Won by $50k; the count still drops by one, which 0184
    // deliberately treats as alert-worthy, so this asserts the DOLLAR direction only.
    expect(impacts["office.won_ytd"]).toMatchObject({ before: -50000, after: 0, delta: 50000 });
  });

  it("resolves a CO child's value from awarded_amount VERBATIM, mirroring the published deal-value chain", async () => {
    pg = await setup();
    // deal-value-sql.ts: `CASE WHEN COALESCE(is_change_order, false) THEN COALESCE(awarded_amount, 0) ELSE <chain> END`.
    // A CO child never falls through to bid/DD — the alert must measure the same number the report publishes.
    const { rows } = await pg.query<{ impacts: unknown }>(
      `SELECT public.won_metric_reduction_impacts(
         jsonb_build_object('canonicalStageSlug','won','isActive',true,'isTestData',false,'onHold',false,
                            'isChangeOrder',true,'wonClosedDate','2026-07-14','awardedAmount',-40000,'bidEstimate',900000),
         jsonb_build_object('canonicalStageSlug','won','isActive',true,'isTestData',false,'onHold',false,
                            'isChangeOrder',true,'wonClosedDate','2026-07-14','awardedAmount',-90000,'bidEstimate',900000),
         '2026-07-14'::date, 'canonicalStageSlug', NULL, ARRAY['won_ytd'], false, false
       ) AS impacts`,
    );
    expect(json(rows[0]?.impacts)["office.won_ytd"]).toMatchObject({
      before: -40000,
      after: -90000,
      delta: -50000,
    });
  });

  it("leaves a NON-change-order deal's > 0 fallback chain untouched", async () => {
    pg = await setup();
    const { rows } = await pg.query<{ impacts: unknown }>(
      `SELECT public.won_metric_reduction_impacts(
         jsonb_build_object('canonicalStageSlug','won','isActive',true,'isTestData',false,'onHold',false,
                            'isChangeOrder',false,'wonClosedDate','2026-07-14','awardedAmount',0,'bidEstimate',200000),
         jsonb_build_object('canonicalStageSlug','won','isActive',true,'isTestData',false,'onHold',false,
                            'isChangeOrder',false,'wonClosedDate','2026-07-14','awardedAmount',0,'bidEstimate',125000),
         '2026-07-14'::date, 'canonicalStageSlug', NULL, ARRAY['won_ytd'], false, false
       ) AS impacts`,
    );
    expect(json(rows[0]?.impacts)["office.won_ytd"]).toMatchObject({
      before: 200000,
      after: 125000,
      delta: -75000,
    });
  });

  // ---- the estimator calls (p_exclude_change_orders = true) must be UNCHANGED ---------------------

  it("keeps the estimator-pipeline call (p_exclude_change_orders = true) blind to change orders", async () => {
    pg = await setup();
    const { rows } = await pg.query<{ impacts: unknown }>(
      `SELECT public.won_metric_reduction_impacts(
         jsonb_build_object('estimatorStageSlug','won','isActive',true,'isTestData',false,'onHold',false,
                            'isChangeOrder',true,'wonClosedDate','2026-07-14','awardedAmount',-40000),
         jsonb_build_object('estimatorStageSlug','won','isActive',true,'isTestData',false,'onHold',false,
                            'isChangeOrder',true,'wonClosedDate','2026-07-14','awardedAmount',-90000),
         '2026-07-14'::date, 'estimatorStageSlug', 'estimator_pipeline', ARRAY['won_ytd'], false, true
       ) AS impacts`,
    );
    expect(json(rows[0]?.impacts)).toEqual({});
  });

  it("emits no estimator_pipeline key when a deductive CO is created", async () => {
    pg = await setup();
    await insertWonParent(pg);

    await insertChangeOrder(pg, DEDUCTIVE_CO, -50000);

    const impacts = json((await eventsFor(pg, DEDUCTIVE_CO)).rows[0]?.impacts);
    expect(Object.keys(impacts).filter((key) => key.includes("estimator_pipeline"))).toEqual([]);
  });

  it("still reports the estimator-pipeline reduction for an ordinary Won deal leaving the figure", async () => {
    pg = await setup();
    await insertWonParent(pg, PLAIN_WON, 300000);

    await pg.query(`UPDATE office_dallas.deals SET on_hold = true WHERE id = $1`, [PLAIN_WON]);

    const impacts = json((await eventsFor(pg, PLAIN_WON)).rows[0]?.impacts);
    expect(impacts["office.won_ytd"]).toMatchObject({ delta: -300000, countDelta: -1 });
    expect(impacts["office.estimator_pipeline.won_ytd"]).toMatchObject({ delta: -300000, countDelta: -1 });
  });

  // ---- shape / replay ------------------------------------------------------------------------------

  it("is IDEMPOTENT: applying it twice leaves exactly one insert trigger and still fires once", async () => {
    pg = await setup();
    await pg.exec(MIGRATION_SQL); // replay — must not throw
    const triggers = await pg.query<{ tgname: string }>(
      `SELECT t.tgname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'office_dallas' AND c.relname = 'deals' AND NOT t.tgisinternal
       ORDER BY t.tgname`,
    );
    expect(triggers.rows.map((row) => row.tgname)).toEqual([
      "audit_deals",
      "won_metric_reduction_delete_trg",
      "won_metric_reduction_insert_trg",
      "won_metric_reduction_update_trg",
    ]);

    await insertWonParent(pg);
    await insertChangeOrder(pg, DEDUCTIVE_CO, -50000);
    expect((await eventsFor(pg, DEDUCTIVE_CO)).rows).toHaveLength(1);
  });

  it("reaches EVERY office_% schema, and skips a schema without the deals table", async () => {
    pg = await setup({ apply0206: false });
    await pg.exec(`
      CREATE SCHEMA office_atlanta;
      CREATE TABLE office_atlanta.deals (LIKE office_dallas.deals INCLUDING ALL);
      CREATE SCHEMA office_empty;
    `);
    await pg.exec(BASE_SQL);
    await pg.exec(MIGRATION_SQL);

    const { rows } = await pg.query<{ nspname: string }>(
      `SELECT n.nspname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relname = 'deals' AND t.tgname = 'won_metric_reduction_insert_trg'
       ORDER BY n.nspname`,
    );
    expect(rows.map((row) => row.nspname)).toEqual(["office_atlanta", "office_dallas"]);
  });

  it("the TENANT_SCHEMA block runs standalone (and twice) on a FRESH provisioned schema", async () => {
    pg = await setup();
    await pg.exec(`
      CREATE SCHEMA office_houston;
      CREATE TABLE office_houston.deals (LIKE office_dallas.deals INCLUDING ALL);
    `);
    const block = tenantBlockFor("office_houston");
    await pg.exec(block);
    await pg.exec(block);

    const { rows } = await pg.query<{ tgname: string }>(
      `SELECT t.tgname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'office_houston' AND c.relname = 'deals' AND NOT t.tgisinternal
       ORDER BY t.tgname`,
    );
    expect(rows.map((row) => row.tgname)).toEqual(["won_metric_reduction_insert_trg"]);
  });

  it("honours the app.skip_won_metric_reduction_alert escape hatch on the INSERT path", async () => {
    pg = await setup();
    await insertWonParent(pg);

    await pg.exec("BEGIN");
    await pg.exec(`SET LOCAL app.skip_won_metric_reduction_alert = 'true'`);
    await insertChangeOrder(pg, DEDUCTIVE_CO, -50000);
    await pg.exec("COMMIT");

    expect((await eventsFor(pg, DEDUCTIVE_CO)).rows).toHaveLength(0);
  });
});

// 0206 CREATE OR REPLACEs both public.won_metric_reduction_impacts and public.capture_won_metric_reduction,
// carrying 0184's bodies forward with the two flagged deltas. The 0184 suite applies 0184 ALONE, so nothing
// there would catch a transcription slip in the copy. These replay 0184's headline contracts against the
// REPLACED functions.
describe("Migration 0206 — 0184's contract survives the function replacement", () => {
  it("still reports placed_on_hold with its label, audit citation and queued delivery", async () => {
    pg = await setup();
    await insertWonParent(pg, PLAIN_WON, 300000);

    await pg.query(`UPDATE office_dallas.deals SET on_hold = true WHERE id = $1`, [PLAIN_WON]);

    const { rows } = await eventsFor(pg, PLAIN_WON);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.reason_code).toBe("placed_on_hold");
    expect(rows[0]?.action_label).toBe("Deal placed on hold");
    expect(json(rows[0]?.impacts)["office.won_ytd"]).toMatchObject({
      countBefore: 1,
      countAfter: 0,
      countDelta: -1,
      before: 300000,
      after: 0,
      delta: -300000,
    });
    expect(json(rows[0]?.audit_reference)).toMatchObject({
      tenantSchema: "office_dallas",
      action: "Deal placed on hold",
    });
    expect(await alertJobCount(pg)).toBe(1);
  });

  it("still handles a DELETE without reading NEW", async () => {
    pg = await setup();
    await insertWonParent(pg, PLAIN_WON, 125000);

    await pg.query(`DELETE FROM office_dallas.deals WHERE id = $1`, [PLAIN_WON]);

    const { rows } = await eventsFor(pg, PLAIN_WON);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.reason_code).toBe("deal_deleted");
    expect(json(rows[0]?.impacts)["office.won_ytd"]).toMatchObject({ delta: -125000 });
  });

  it("still keeps the transaction's first material baseline through an intermediate reversal", async () => {
    pg = await setup();
    await insertWonParent(pg, PLAIN_WON, 100);

    await pg.exec("BEGIN");
    await pg.query(`UPDATE office_dallas.deals SET awarded_amount = 200 WHERE id = $1`, [PLAIN_WON]);
    await pg.query(`UPDATE office_dallas.deals SET awarded_amount = 150 WHERE id = $1`, [PLAIN_WON]);
    await pg.exec("COMMIT");

    const { rows } = await eventsFor(pg, PLAIN_WON);
    expect(rows).toHaveLength(1);
    expect(json(rows[0]?.impacts)["office.won_ytd"]).toMatchObject({ before: 100, after: 150, delta: 50 });
    const reduction = await pg.query<{ has_reduction: boolean }>(
      `SELECT public.won_metric_impacts_have_reduction(impacts) AS has_reduction
       FROM public.won_metric_reduction_events WHERE deal_id = $1`,
      [PLAIN_WON],
    );
    expect(reduction.rows[0]?.has_reduction).toBe(false);
  });

  it("still separates a Bid Board effective-stage move from the canonical CRM Won figure", async () => {
    pg = await setup();
    await pg.query(
      `INSERT INTO office_dallas.deals (
         id, deal_number, name, stage_id, bid_board_stage_slug, won_closed_date, assigned_rep_id, awarded_amount
       ) VALUES ($1, 'TR-MIRROR', 'Mirrored Won deal', $2, 'won',
                 (now() AT TIME ZONE 'America/Chicago')::date, $3, 75000)`,
      [PLAIN_WON, OPEN_STAGE, REP],
    );

    await pg.query(`UPDATE office_dallas.deals SET bid_board_stage_slug = 'estimating' WHERE id = $1`, [PLAIN_WON]);

    const { rows } = await eventsFor(pg, PLAIN_WON);
    const impacts = json(rows[0]?.impacts);
    expect(impacts["office.won_ytd"]).toBeUndefined();
    expect(impacts["office.estimator_pipeline.won_ytd"]).toMatchObject({ delta: -75000, countDelta: -1 });
    expect(rows[0]?.action_label).toBe("Bid Board stage changed");
  });

  it("still captures estimator reassignment as an involved-rep change", async () => {
    pg = await setup();
    await pg.query(
      `INSERT INTO office_dallas.deals (
         id, deal_number, name, stage_id, won_closed_date, assigned_rep_id, estimator_user_id, awarded_amount
       ) VALUES ($1, 'TR-EST', 'Estimator deal', $2, (now() AT TIME ZONE 'America/Chicago')::date, $3, $4, 75000)`,
      [PLAIN_WON, WON_STAGE, REP, ESTIMATOR],
    );

    await pg.query(`UPDATE office_dallas.deals SET estimator_user_id = $1 WHERE id = $2`, [
      NEXT_ESTIMATOR,
      PLAIN_WON,
    ]);

    const { rows } = await eventsFor(pg, PLAIN_WON);
    expect(rows[0]?.reason_code).toBe("won_estimator_reassigned");
    const impacts = json(rows[0]?.impacts);
    expect(impacts["office.won_ytd"]).toBeUndefined();
    expect(impacts[`assigned_rep.${ESTIMATOR}.won_ytd`]).toMatchObject({ countDelta: -1, delta: -75000 });
    expect(impacts[`assigned_rep.${NEXT_ESTIMATOR}.won_ytd`]).toMatchObject({ countDelta: 1, delta: 75000 });
  });

  it("still keeps the migration's Won-family eligibility aligned with the shared workflow contract", async () => {
    pg = await setup();

    for (const stageSlug of WON_DEAL_STAGE_SLUGS) {
      const { rows } = await pg.query<{ impacts: unknown }>(
        `SELECT public.won_metric_reduction_impacts(
           jsonb_build_object('canonicalStageSlug', $1::text, 'isActive', true, 'isTestData', false,
                              'onHold', false, 'isChangeOrder', false, 'wonClosedDate', '2026-07-14',
                              'awardedAmount', 300000),
           jsonb_build_object('canonicalStageSlug', 'estimating', 'isActive', true, 'isTestData', false,
                              'onHold', false, 'isChangeOrder', false, 'wonClosedDate', '2026-07-14',
                              'awardedAmount', 300000),
           '2026-07-14'::date, 'canonicalStageSlug', NULL, ARRAY['won_ytd'], false, false
         ) AS impacts`,
        [stageSlug],
      );
      expect(json(rows[0]?.impacts)["office.won_ytd"]).toMatchObject({
        countBefore: 1,
        countAfter: 0,
        countDelta: -1,
        before: 300000,
        after: 0,
        delta: -300000,
      });
    }
  });

  it("still treats a false -> true change-order reclassification as estimator-only", async () => {
    pg = await setup();
    await insertWonParent(pg, PLAIN_WON, 75000);

    await pg.query(`UPDATE office_dallas.deals SET is_change_order = true WHERE id = $1`, [PLAIN_WON]);

    const { rows } = await eventsFor(pg, PLAIN_WON);
    expect(rows[0]?.reason_code).toBe("won_change_order_classification_changed");
    expect(rows[0]?.action_label).toBe("Change-order classification changed");
    const impacts = json(rows[0]?.impacts);
    // The canonical figure is unchanged: awarded_amount is POSITIVE, so 0206's change-order branch resolves
    // to the same number the `> 0` chain already produced.
    expect(impacts["office.won_ytd"]).toBeUndefined();
    expect(impacts["office.estimator_pipeline.won_ytd"]).toMatchObject({ delta: -75000, countDelta: -1 });
  });
});
