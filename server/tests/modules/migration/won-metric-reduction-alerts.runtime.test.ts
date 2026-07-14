import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { WON_DEAL_STAGE_SLUGS } from "@trock-crm/shared/types";

const MIGRATION_SQL = readFileSync(
  new URL("../../../../migrations/0184_won_metric_reduction_alerts.sql", import.meta.url),
  "utf8",
);

const OFFICE = "00000000-0000-0000-0000-000000000010";
const REP = "00000000-0000-0000-0000-000000000011";
const WON_STAGE = "00000000-0000-0000-0000-000000000012";
const OPEN_STAGE = "00000000-0000-0000-0000-000000000013";
const DEAL = "00000000-0000-0000-0000-000000000014";
const DELETE_DEAL = "00000000-0000-0000-0000-000000000015";
const MIRROR_DEAL = "00000000-0000-0000-0000-000000000016";
const PARTIAL_REVERSAL_DEAL = "00000000-0000-0000-0000-000000000017";
const CHANGE_ORDER_DEAL = "00000000-0000-0000-0000-000000000018";

let pg: PGlite | null = null;

afterEach(async () => {
  await pg?.close();
  pg = null;
});

async function setup(options: { enableDelivery?: boolean } = {}): Promise<PGlite> {
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
      on_hold boolean NOT NULL DEFAULT false,
      assigned_rep_id uuid,
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
    CREATE TRIGGER audit_deals
      AFTER UPDATE OR DELETE ON office_dallas.deals
      FOR EACH ROW EXECUTE FUNCTION public.test_audit_deals();
  `);
  await db.exec(MIGRATION_SQL);
  if (options.enableDelivery ?? true) {
    await db.query("SELECT public.enable_won_metric_reduction_alert_delivery()");
  }
  return db;
}

async function insertWonDeal(db: PGlite, id = DEAL, value = 300000): Promise<void> {
  await db.query(
    `INSERT INTO office_dallas.deals (
       id, deal_number, name, stage_id, won_closed_date, assigned_rep_id, awarded_amount
     ) VALUES ($1, 'TR-100', 'Won deal', $2, CURRENT_DATE, $3, $4)`,
    [id, WON_STAGE, REP, value],
  );
}

function json(value: unknown): Record<string, any> {
  return typeof value === "string" ? JSON.parse(value) : (value as Record<string, any>);
}

describe("migration 0184 — Won metric reduction alerts (runtime, PGlite)", () => {
  it("adds won_metric_decrease to the deployed public notification enum", async () => {
    pg = await setup();

    const labels = await pg.query<{ enumlabel: string }>(
      "SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid " +
        "JOIN pg_namespace n ON n.oid = t.typnamespace " +
        "WHERE t.typname = 'notification_type' AND n.nspname = 'public' ORDER BY e.enumsortorder",
    );
    expect(labels.rows.map((row) => row.enumlabel)).toContain("won_metric_decrease");
    await expect(pg.query("SELECT 'won_metric_decrease'::public.notification_type")).resolves.toBeDefined();
  });

  it("persists a reduction outbox event with the exact audit action and queues delivery", async () => {
    pg = await setup();
    await insertWonDeal(pg);

    await pg.query(`UPDATE office_dallas.deals SET on_hold = true WHERE id = $1`, [DEAL]);

    const event = await pg.query<{
      event_kind: string;
      reason_code: string;
      changed_fields: unknown;
      impacts: unknown;
      audit_reference: unknown;
    }>(`
      SELECT event_kind, reason_code, changed_fields, impacts, audit_reference
      FROM public.won_metric_reduction_events
      WHERE deal_id = '${DEAL}'
    `);
    expect(event.rows).toHaveLength(1);
    expect(event.rows[0]?.event_kind).toBe("deal_mutation");
    expect(event.rows[0]?.reason_code).toBe("placed_on_hold");
    expect(json(event.rows[0]?.changed_fields).on_hold).toEqual({ from: false, to: true });
    const impacts = json(event.rows[0]?.impacts);
    expect(impacts["office.won_ytd"]).toMatchObject({
      metric: "won_ytd",
      countBefore: 1,
      countAfter: 0,
      countDelta: -1,
      before: 300000,
      after: 0,
      delta: -300000,
    });
    expect(impacts["office.estimator_pipeline.won_ytd"]).toMatchObject({
      metric: "estimator_pipeline.won_ytd",
      countBefore: 1,
      countAfter: 0,
      countDelta: -1,
      before: 300000,
      after: 0,
      delta: -300000,
    });
    const auditReference = json(event.rows[0]?.audit_reference);
    expect(auditReference).toMatchObject({ tenantSchema: "office_dallas", action: "Deal placed on hold" });
    expect(auditReference.auditLogIds).toHaveLength(1);

    const job = await pg.query<{ job_type: string; payload: unknown; office_id: string }>(`
      SELECT job_type, payload, office_id FROM public.job_queue WHERE job_type = 'won_metric_reduction_alert'
    `);
    expect(job.rows).toHaveLength(1);
    expect(job.rows[0]?.office_id).toBe(OFFICE);
    expect(json(job.rows[0]?.payload).eventId).toBeTruthy();
  });

  it("keeps reduction events durable until a handler-capable worker enables delivery", async () => {
    pg = await setup({ enableDelivery: false });
    await insertWonDeal(pg);

    await pg.query(`UPDATE office_dallas.deals SET on_hold = true WHERE id = $1`, [DEAL]);

    const beforeEnable = await pg.query(`SELECT id FROM public.job_queue WHERE job_type = 'won_metric_reduction_alert'`);
    expect(beforeEnable.rows).toHaveLength(0);

    const enabled = await pg.query<{ queued_count: number }>(
      "SELECT public.enable_won_metric_reduction_alert_delivery() AS queued_count",
    );
    expect(Number(enabled.rows[0]?.queued_count)).toBe(1);

    const afterEnable = await pg.query(`SELECT id FROM public.job_queue WHERE job_type = 'won_metric_reduction_alert'`);
    expect(afterEnable.rows).toHaveLength(1);
  });

  it("keeps the migration's Won-family eligibility aligned with the shared workflow contract", async () => {
    pg = await setup();

    for (const stageSlug of WON_DEAL_STAGE_SLUGS) {
      const result = await pg.query<{ impacts: unknown }>(
        `SELECT public.won_metric_reduction_impacts(
           jsonb_build_object(
             'canonicalStageSlug', $1::text,
             'isActive', true,
             'isTestData', false,
             'onHold', false,
             'isChangeOrder', false,
             'wonClosedDate', '2026-07-14',
             'awardedAmount', 300000
           ),
           jsonb_build_object(
             'canonicalStageSlug', 'estimating',
             'isActive', true,
             'isTestData', false,
             'onHold', false,
             'isChangeOrder', false,
             'wonClosedDate', '2026-07-14',
             'awardedAmount', 300000
           ),
           '2026-07-14'::date,
           'canonicalStageSlug',
           NULL,
           ARRAY['won_ytd'],
           false,
           false
         ) AS impacts`,
        [stageSlug],
      );
      expect(json(result.rows[0]?.impacts)["office.won_ytd"]).toMatchObject({
        countBefore: 1,
        countAfter: 0,
        countDelta: -1,
        before: 300000,
        after: 0,
        delta: -300000,
      });
    }
  });

  it("handles a delete without reading NEW and records the deleted Won contribution", async () => {
    pg = await setup();
    await insertWonDeal(pg, DELETE_DEAL, 125000);

    await pg.query(`DELETE FROM office_dallas.deals WHERE id = $1`, [DELETE_DEAL]);

    const row = await pg.query<{ reason_code: string; impacts: unknown }>(`
      SELECT reason_code, impacts
      FROM public.won_metric_reduction_events
      WHERE deal_id = '${DELETE_DEAL}'
    `);
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0]?.reason_code).toBe("deal_deleted");
    expect(json(row.rows[0]?.impacts)["office.won_ytd"]).toMatchObject({ delta: -125000 });
  });

  it("keeps the transaction's first material baseline so an intermediate reversal cannot produce a false alert", async () => {
    pg = await setup();
    await insertWonDeal(pg, PARTIAL_REVERSAL_DEAL, 100);

    await pg.exec("BEGIN");
    await pg.query(`UPDATE office_dallas.deals SET awarded_amount = 200 WHERE id = $1`, [PARTIAL_REVERSAL_DEAL]);
    await pg.query(`UPDATE office_dallas.deals SET awarded_amount = 150 WHERE id = $1`, [PARTIAL_REVERSAL_DEAL]);
    await pg.exec("COMMIT");

    const row = await pg.query<{ impacts: unknown }>(`
      SELECT impacts FROM public.won_metric_reduction_events WHERE deal_id = '${PARTIAL_REVERSAL_DEAL}'
    `);
    expect(row.rows).toHaveLength(1);
    const impacts = json(row.rows[0]?.impacts);
    expect(impacts["office.won_ytd"]).toMatchObject({ before: 100, after: 150, delta: 50 });
    const hasReduction = await pg.query<{ has_reduction: boolean }>(`
      SELECT public.won_metric_impacts_have_reduction(impacts) AS has_reduction
      FROM public.won_metric_reduction_events
      WHERE deal_id = '${PARTIAL_REVERSAL_DEAL}'
    `);
    expect(hasReduction.rows[0]?.has_reduction).toBe(false);
  });

  it("keeps Bid Board effective-stage reductions distinct from canonical CRM Won figures", async () => {
    pg = await setup();
    await pg.query(
      `INSERT INTO office_dallas.deals (
         id, deal_number, name, stage_id, bid_board_stage_slug, won_closed_date, assigned_rep_id, awarded_amount
       ) VALUES ($1, 'TR-MIRROR', 'Mirrored Won deal', $2, 'won', CURRENT_DATE, $3, 75000)`,
      [MIRROR_DEAL, OPEN_STAGE, REP],
    );

    await pg.query(`UPDATE office_dallas.deals SET bid_board_stage_slug = 'estimating' WHERE id = $1`, [MIRROR_DEAL]);

    const row = await pg.query<{ impacts: unknown; action_label: string }>(`
      SELECT impacts, action_label FROM public.won_metric_reduction_events WHERE deal_id = '${MIRROR_DEAL}'
    `);
    const impacts = json(row.rows[0]?.impacts);
    expect(impacts["office.won_ytd"]).toBeUndefined();
    expect(impacts["office.estimator_pipeline.won_ytd"]).toMatchObject({ delta: -75000, countDelta: -1 });
    expect(row.rows[0]?.action_label).toBe("Bid Board stage changed");
  });

  it("uses the Estimator Pipeline base-project guard without changing the canonical Deals Won figure", async () => {
    pg = await setup();
    await insertWonDeal(pg, CHANGE_ORDER_DEAL, 75000);

    await pg.query(`UPDATE office_dallas.deals SET is_change_order = true WHERE id = $1`, [CHANGE_ORDER_DEAL]);

    const row = await pg.query<{ reason_code: string; action_label: string; changed_fields: unknown; impacts: unknown }>(`
      SELECT reason_code, action_label, changed_fields, impacts
      FROM public.won_metric_reduction_events
      WHERE deal_id = '${CHANGE_ORDER_DEAL}'
    `);
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0]?.reason_code).toBe("won_change_order_classification_changed");
    expect(row.rows[0]?.action_label).toBe("Change-order classification changed");
    expect(json(row.rows[0]?.changed_fields).is_change_order).toEqual({ from: false, to: true });
    const impacts = json(row.rows[0]?.impacts);
    expect(impacts["office.won_ytd"]).toBeUndefined();
    expect(impacts["office.estimator_pipeline.won_ytd"]).toMatchObject({ delta: -75000, countDelta: -1 });
  });

  it("emits a release-cited event when a versioned published definition itself reduces Won", async () => {
    pg = await setup();
    await pg.query(`
      SELECT public.record_won_metric_definition_snapshot(
        'office_dallas', 'estimator_pipeline.won_ytd', 'v1', 'hash-v1', 3, 300000, 'release-v1'
      )
    `);
    await pg.query(`
      SELECT public.record_won_metric_definition_snapshot(
        'office_dallas', 'estimator_pipeline.won_ytd', 'v2', 'hash-v2', 2, 25000, 'release-v2'
      )
    `);

    const event = await pg.query<{
      event_kind: string;
      impacts: unknown;
      audit_reference: unknown;
      release_reference: string;
    }>(`
      SELECT event_kind, impacts, audit_reference, release_reference
      FROM public.won_metric_reduction_events
      WHERE event_kind = 'report_definition_change'
    `);
    expect(event.rows).toHaveLength(1);
    expect(event.rows[0]?.release_reference).toBe("release-v2");
    expect(json(event.rows[0]?.impacts)["office.estimator_pipeline.won_ytd"]).toMatchObject({
      countDelta: -1,
      delta: -275000,
    });
    expect(json(event.rows[0]?.audit_reference)).toMatchObject({
      kind: "release",
      previousDefinitionHash: "hash-v1",
      definitionHash: "hash-v2",
    });
  });

  it("refreshes the same-definition baseline before comparing a later definition change", async () => {
    pg = await setup();
    await pg.query(`
      SELECT public.record_won_metric_definition_snapshot(
        'office_dallas', 'deals_dashboard.won_ytd', 'v1', 'hash-v1', 3, 300000, 'release-v1'
      )
    `);
    await pg.query(`
      SELECT public.record_won_metric_definition_snapshot(
        'office_dallas', 'deals_dashboard.won_ytd', 'v1', 'hash-v1', 4, 400000, 'release-v1'
      )
    `);
    await pg.query(`
      SELECT public.record_won_metric_definition_snapshot(
        'office_dallas', 'deals_dashboard.won_ytd', 'v2', 'hash-v2', 3, 350000, 'release-v2'
      )
    `);

    const event = await pg.query<{ impacts: unknown }>(`
      SELECT impacts
      FROM public.won_metric_reduction_events
      WHERE event_kind = 'report_definition_change'
        AND report_metric_key = 'deals_dashboard.won_ytd'
    `);
    expect(event.rows).toHaveLength(1);
    expect(json(event.rows[0]?.impacts)["office.deals_dashboard.won_ytd"]).toMatchObject({
      countBefore: 4,
      countAfter: 3,
      countDelta: -1,
      before: 400000,
      after: 350000,
      delta: -50000,
    });
  });

  it("accepts the tenant current-schema value used by the published dashboard registrations", async () => {
    pg = await setup();
    await pg.exec("SET search_path TO office_dallas, public");

    await pg.query(`
      SELECT public.record_won_metric_definition_snapshot(
        current_schema()::text, 'deals_dashboard.won_ytd', 'v1', 'hash-v1', 7, 123456, 'release-v1'
      )
    `);

    const snapshot = await pg.query<{ tenant_schema: string; metric_key: string; won_count: number }>(`
      SELECT tenant_schema, metric_key, won_count
      FROM public.won_metric_definition_snapshots
      WHERE metric_key = 'deals_dashboard.won_ytd'
    `);
    expect(snapshot.rows).toEqual([
      { tenant_schema: "office_dallas", metric_key: "deals_dashboard.won_ytd", won_count: 7 },
    ]);
  });
});
