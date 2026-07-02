import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";

/**
 * REAL-SQL (PGlite) proof for migration 0147 — re-key the Christy notification to fire on a deal's
 * FIRST entry into the Opportunity stage, carrying deal_number (the operative "project number").
 *
 * This installs the ACTUAL trigger function (extracted from the migration file) on a throwaway
 * tenant schema, attaches it as `AFTER INSERT OR UPDATE OF stage_id`, and drives it with real DML to
 * lock the hard invariants:
 *   - New Service Opportunity (INSERT born in Opportunity, created_by set)  -> exactly one job;
 *   - lead conversion (INSERT born in Opportunity, source_lead set)         -> exactly one job;
 *   - SyncHub/synced-origin deal (created_by AND source_lead NULL)          -> NO job (origin guard);
 *   - deal born in a non-Opportunity stage (dd)                             -> no job until it enters;
 *   - re-entry (leave Opportunity, return) and director backward move       -> SAME stable marker id,
 *       never a NEW one (so the worker receipts ledger collapses it to a single send);
 *   - a no-op stage write while already in Opportunity                      -> no enqueue.
 *
 * The dedup marker is `record_id`-ALONE — that physical unique constraint is what makes "first entry
 * only" true across the deal's whole lifetime. The trigger never back-seeds (NO-SEED posture).
 */

const MIGRATION_SQL = readFileSync(
  new URL("../../../../migrations/0147_deal_opportunity_first_entry_email.sql", import.meta.url),
  "utf8",
);

const FN = extractFunction(MIGRATION_SQL);

function extractFunction(sql: string): string {
  const match = sql.match(
    /CREATE OR REPLACE FUNCTION public\.enqueue_deal_opportunity_first_entry_email[\s\S]*?\$\$;/,
  );
  if (!match) throw new Error("could not extract enqueue_deal_opportunity_first_entry_email function body");
  return match[0];
}

const SCHEMA = "office_test";
const OPP = "00000000-0000-0000-0000-0000000000aa"; // opportunity stage id
const DD = "00000000-0000-0000-0000-0000000000bb"; // due-diligence (non-opportunity) stage id
const EST = "00000000-0000-0000-0000-0000000000cc"; // estimating stage id

const USER = "00000000-0000-0000-0000-000000000099";
const LEAD = "00000000-0000-0000-0000-000000000088";

let pg: PGlite | null = null;

afterEach(async () => {
  await pg?.close();
  pg = null;
});

async function setup(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    CREATE TYPE public.audit_action AS ENUM ('insert','update','delete','soft_delete','legacy_cleanup_scope_change');
    CREATE TABLE public.pipeline_stage_config (id uuid PRIMARY KEY, slug varchar(100) UNIQUE NOT NULL);
    INSERT INTO public.pipeline_stage_config (id, slug) VALUES
      ('${OPP}', 'opportunity'),
      ('${DD}', 'dd'),
      ('${EST}', 'estimating');
    CREATE TABLE public.job_queue (
      id bigserial PRIMARY KEY,
      job_type text NOT NULL,
      payload jsonb NOT NULL,
      office_id uuid,
      status text NOT NULL,
      run_after timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE SCHEMA ${SCHEMA};
    CREATE TABLE ${SCHEMA}.deals (
      id uuid PRIMARY KEY, sales_source_user_id uuid,
      name text NOT NULL,
      deal_number text NOT NULL,
      stage_id uuid NOT NULL,
      created_by_user_id uuid,
      source_lead_id uuid
    );
    CREATE TABLE ${SCHEMA}.audit_log (
      id bigserial PRIMARY KEY,
      table_name varchar(100) NOT NULL,
      record_id uuid NOT NULL,
      action public.audit_action NOT NULL,
      changed_by uuid,
      actor_system_process text,
      entity_type text,
      entity_name_snapshot text,
      entity_secondary_id_snapshot text,
      field_changes_jsonb jsonb,
      changes jsonb,
      visibility_scope text,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX audit_log_deal_opportunity_first_entry_uidx
      ON ${SCHEMA}.audit_log (record_id)
      WHERE table_name = 'deals' AND actor_system_process = 'deal_opportunity_first_entry';
  `);
  await db.exec(FN);
  await db.exec(`
    CREATE TRIGGER deals_opportunity_first_entry_email_trg
      AFTER INSERT OR UPDATE OF stage_id ON ${SCHEMA}.deals
      FOR EACH ROW EXECUTE FUNCTION public.enqueue_deal_opportunity_first_entry_email();
  `);
  return db;
}

async function insertDeal(
  db: PGlite,
  opts: { id: string; name: string; dealNumber: string; stageId: string; createdBy?: string | null; sourceLead?: string | null },
): Promise<void> {
  await db.query(
    `INSERT INTO ${SCHEMA}.deals (id, name, deal_number, stage_id, created_by_user_id, source_lead_id)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [opts.id, opts.name, opts.dealNumber, opts.stageId, opts.createdBy ?? null, opts.sourceLead ?? null],
  );
}

async function moveStage(db: PGlite, id: string, stageId: string): Promise<void> {
  await db.query(`UPDATE ${SCHEMA}.deals SET stage_id = $2 WHERE id = $1`, [id, stageId]);
}

async function emailJobs(
  db: PGlite,
): Promise<Array<{ payload: { auditLogId: number; dealNumber: string; dealId: string; tenantSchema: string } }>> {
  const res = await db.query<{ payload: { auditLogId: number; dealNumber: string; dealId: string; tenantSchema: string } }>(
    `SELECT payload FROM public.job_queue WHERE job_type = 'deal_opportunity_first_entry_email' ORDER BY id`,
  );
  return res.rows;
}

const SERVICE = "00000000-0000-0000-0000-0000000000a1";
const CONVERT = "00000000-0000-0000-0000-0000000000a2";
const SYNCED = "00000000-0000-0000-0000-0000000000a3";
const LATER = "00000000-0000-0000-0000-0000000000a4";
const REENTRY = "00000000-0000-0000-0000-0000000000a5";
const NOOP = "00000000-0000-0000-0000-0000000000a6";
const SYNCMOVE = "00000000-0000-0000-0000-0000000000a7";
const LEGACY = "00000000-0000-0000-0000-0000000000a8";
const LEGACY2 = "00000000-0000-0000-0000-0000000000a9";

describe("deal_opportunity_first_entry trigger — fires once on first Opportunity entry, keyed to deal_number", () => {
  it("New Service Opportunity (INSERT born in Opportunity, created_by set) enqueues exactly one job carrying deal_number", async () => {
    pg = await setup();
    await insertDeal(pg, { id: SERVICE, name: "Service Op", dealNumber: "DFW-4-15326-ab", stageId: OPP, createdBy: USER });

    const jobs = await emailJobs(pg);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.payload.dealNumber).toBe("DFW-4-15326-ab");
    expect(jobs[0]!.payload.dealId).toBe(SERVICE);
    expect(jobs[0]!.payload.tenantSchema).toBe(SCHEMA);

    const marker = await pg.query<{ id: string }>(
      `SELECT id FROM ${SCHEMA}.audit_log WHERE record_id = $1 AND actor_system_process = 'deal_opportunity_first_entry'`,
      [SERVICE],
    );
    expect(marker.rows).toHaveLength(1);
    expect(String(jobs[0]!.payload.auditLogId)).toBe(String(marker.rows[0]!.id));
  });

  it("lead conversion (INSERT born in Opportunity; createDeal sets BOTH created_by + source_lead) enqueues exactly one job", async () => {
    pg = await setup();
    // conversion-service passes actorUserId AND sourceLeadId, so a live converted deal has both set.
    await insertDeal(pg, { id: CONVERT, name: "Converted", dealNumber: "DFW-4-15327-cd", stageId: OPP, createdBy: USER, sourceLead: LEAD });

    const jobs = await emailJobs(pg);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.payload.dealNumber).toBe("DFW-4-15327-cd");
    expect(jobs[0]!.payload.dealId).toBe(CONVERT);
  });

  it("synced-origin deal (created_by AND source_lead NULL) born in Opportunity does NOT enqueue (origin guard)", async () => {
    pg = await setup();
    await insertDeal(pg, { id: SYNCED, name: "Synced", dealNumber: "DFW-4-15328-ef", stageId: OPP, createdBy: null, sourceLead: null });

    expect(await emailJobs(pg)).toHaveLength(0);
  });

  it("legacy/imported lineage (created_by NULL + synthesized source_lead_id, per migrations 0026/0027) does NOT enqueue", async () => {
    pg = await setup();
    // A HubSpot-imported / legacy deal: source_lead_id was backfilled, but no app user created it.
    // The origin guard requires created_by_user_id, so source_lead_id alone must NOT qualify.
    await insertDeal(pg, { id: LEGACY, name: "Legacy", dealNumber: "DFW-4-15333-op", stageId: OPP, createdBy: null, sourceLead: LEAD });
    expect(await emailJobs(pg)).toHaveLength(0);

    // ...and it must stay silent when a legacy deal is MOVED into Opportunity later, too.
    await insertDeal(pg, { id: LEGACY2, name: "Legacy2", dealNumber: "DFW-4-15334-qr", stageId: DD, createdBy: null, sourceLead: LEAD });
    await moveStage(pg, LEGACY2, OPP);
    expect(await emailJobs(pg)).toHaveLength(0);
  });

  it("a deal created in a non-Opportunity stage (dd) does not enqueue until it enters Opportunity", async () => {
    pg = await setup();
    await insertDeal(pg, { id: LATER, name: "Later", dealNumber: "DFW-4-15329-gh", stageId: DD, createdBy: USER });
    expect(await emailJobs(pg)).toHaveLength(0); // born outside Opportunity -> nothing

    await moveStage(pg, LATER, OPP); // first entry via UPDATE
    const jobs = await emailJobs(pg);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.payload.dealNumber).toBe("DFW-4-15329-gh");
  });

  it("re-entry (leave Opportunity and return) does NOT mint a new marker — both jobs carry the SAME id (worker receipts collapse to one send)", async () => {
    pg = await setup();
    await insertDeal(pg, { id: REENTRY, name: "Reentry", dealNumber: "DFW-4-15330-ij", stageId: OPP, createdBy: USER });
    let jobs = await emailJobs(pg);
    expect(jobs).toHaveLength(1);
    const firstId = String(jobs[0]!.payload.auditLogId);

    await moveStage(pg, REENTRY, EST); // leave Opportunity -> no enqueue
    expect(await emailJobs(pg)).toHaveLength(1);

    await moveStage(pg, REENTRY, OPP); // director-style backward move back into Opportunity
    jobs = await emailJobs(pg);
    expect(jobs).toHaveLength(2);
    // The second enqueue reuses the SAME stable marker id -> the worker's receipts ledger
    // (tenant_schema, audit_log_id) sends exactly once and dedups the re-entry. (Proven in the
    // worker handler tests.) Critically there is still only ONE marker row for the deal.
    expect(String(jobs[1]!.payload.auditLogId)).toBe(firstId);
    const markers = await pg.query<{ n: string }>(
      `SELECT count(*)::int AS n FROM ${SCHEMA}.audit_log WHERE record_id = $1 AND actor_system_process = 'deal_opportunity_first_entry'`,
      [REENTRY],
    );
    expect(Number(markers.rows[0]!.n)).toBe(1);
  });

  it("a no-op stage write while already in Opportunity does not enqueue", async () => {
    pg = await setup();
    await insertDeal(pg, { id: NOOP, name: "Noop", dealNumber: "DFW-4-15331-kl", stageId: OPP, createdBy: USER });
    expect(await emailJobs(pg)).toHaveLength(1);

    await moveStage(pg, NOOP, OPP); // OLD already Opportunity -> not a fresh entry -> no enqueue
    expect(await emailJobs(pg)).toHaveLength(1);
  });

  it("a synced-origin deal that LATER moves into Opportunity still does not enqueue (origin guard on the UPDATE arm)", async () => {
    pg = await setup();
    await insertDeal(pg, { id: SYNCMOVE, name: "SyncMove", dealNumber: "DFW-4-15332-mn", stageId: DD, createdBy: null, sourceLead: null });
    await moveStage(pg, SYNCMOVE, OPP);
    expect(await emailJobs(pg)).toHaveLength(0);
  });

  it("is BEST-EFFORT: a failure in the enqueue path does NOT abort the deal write (mirrors 0143)", async () => {
    pg = await setup();
    // Force the trigger's job_queue INSERT to throw: a NOT NULL column it does not provide.
    await pg.exec(`ALTER TABLE public.job_queue ADD COLUMN required_marker text NOT NULL;`);

    // The deal INSERT must still succeed even though the notification enqueue raises internally.
    await insertDeal(pg, { id: SERVICE, name: "BestEffort", dealNumber: "DFW-4-15399-zz", stageId: OPP, createdBy: USER });

    const deals = await pg.query<{ id: string }>(`SELECT id FROM ${SCHEMA}.deals WHERE id = $1`, [SERVICE]);
    expect(deals.rows).toHaveLength(1); // deal write preserved
    expect(await emailJobs(pg)).toHaveLength(0); // enqueue failed -> no job (best-effort)
    // the whole best-effort sub-block rolled back, so no orphaned marker remains either
    const markers = await pg.query<{ n: string }>(
      `SELECT count(*)::int AS n FROM ${SCHEMA}.audit_log WHERE record_id = $1 AND actor_system_process = 'deal_opportunity_first_entry'`,
      [SERVICE],
    );
    expect(Number(markers.rows[0]!.n)).toBe(0);
  });

  it("honors the app.skip_deal_opportunity_email escape hatch (bulk scripts / migrations)", async () => {
    pg = await setup();
    await pg.query(`SELECT set_config('app.skip_deal_opportunity_email', '1', false)`);
    await insertDeal(pg, { id: SERVICE, name: "Skipped", dealNumber: "DFW-4-15388-yy", stageId: OPP, createdBy: USER });
    expect(await emailJobs(pg)).toHaveLength(0);
  });
});

describe("0147 migration text — locks the design contract", () => {
  it("fires on stage entry (INSERT OR UPDATE OF stage_id), not on project_number", () => {
    expect(MIGRATION_SQL).toContain("AFTER INSERT OR UPDATE OF stage_id");
    expect(MIGRATION_SQL).toContain("deals_opportunity_first_entry_email_trg");
    expect(MIGRATION_SQL).toContain("FROM public.pipeline_stage_config");
    expect(MIGRATION_SQL).toContain("slug = 'opportunity'");
  });

  it("applies the CRM-genuine origin guard (require created_by_user_id; source_lead_id is NOT a signal)", () => {
    expect(MIGRATION_SQL).toContain("IF NEW.created_by_user_id IS NULL THEN");
    // source_lead_id must NOT qualify a deal — migrations 0026/0027 synthesize it on imported deals
    expect(MIGRATION_SQL).not.toContain("NEW.created_by_user_id IS NULL AND NEW.source_lead_id");
    expect(MIGRATION_SQL).not.toContain("OR NEW.source_lead_id IS NOT NULL");
  });

  it("carries deal_number and enqueues the new job type", () => {
    expect(MIGRATION_SQL).toContain("NULLIF(BTRIM(NEW.deal_number), '')");
    expect(MIGRATION_SQL).toContain("'deal_opportunity_first_entry_email'");
    expect(MIGRATION_SQL).toContain("'dealNumber', new_deal_number");
  });

  it("dedups the first-entry marker on record_id ALONE (the first-entry-only guard)", () => {
    expect(MIGRATION_SQL).toContain("audit_log_deal_opportunity_first_entry_uidx");
    expect(MIGRATION_SQL).toContain("ON CONFLICT DO NOTHING");
    expect(MIGRATION_SQL).toContain("actor_system_process = 'deal_opportunity_first_entry'");
    // the dedup index must be on record_id ALONE — never widened with a per-entry column
    expect(MIGRATION_SQL).toMatch(/audit_log_deal_opportunity_first_entry_uidx\s+ON\s+\S+\.audit_log\s*\(record_id\)/);
    expect(MIGRATION_SQL).not.toMatch(/audit_log_deal_opportunity_first_entry_uidx[\s\S]*?\(record_id,\s*\w/);
  });

  it("preserves the reuse-existing-marker-and-enqueue branch", () => {
    expect(MIGRATION_SQL).toContain("IF inserted_audit_id IS NULL THEN");
    expect(MIGRATION_SQL).toMatch(/SELECT\s+id[\s\S]*?FROM\s+%I\.audit_log[\s\S]*?record_id = \$1/);
  });

  it("takes the NO-SEED posture — never back-seeds markers from existing deals", () => {
    // a back-seed would be an INSERT INTO ...audit_log ... SELECT ... FROM <schema>.deals
    expect(MIGRATION_SQL).not.toMatch(/INSERT INTO[\s\S]*?audit_log[\s\S]*?SELECT[\s\S]*?FROM\s+\S*deals/i);
    expect(MIGRATION_SQL).not.toContain("'transition', 'existing'");
  });

  it("creates a dedicated receipts ledger keyed (tenant_schema, audit_log_id)", () => {
    expect(MIGRATION_SQL).toContain("CREATE TABLE IF NOT EXISTS public.deal_opportunity_first_entry_email_receipts");
    expect(MIGRATION_SQL).toContain("deal_number text NOT NULL");
    expect(MIGRATION_SQL).toContain("PRIMARY KEY (tenant_schema, audit_log_id)");
  });

  it("includes tenant provisioning DDL for future office schemas", () => {
    expect(MIGRATION_SQL).toContain("-- TENANT_SCHEMA_START");
    expect(MIGRATION_SQL).toContain("ON office_dallas.deals");
    expect(MIGRATION_SQL).toContain("-- TENANT_SCHEMA_END");
  });

  it("supports the bulk-script skip setting", () => {
    expect(MIGRATION_SQL).toContain("app.skip_deal_opportunity_email");
  });

  it("is best-effort — a notification failure cannot abort the deal write", () => {
    expect(MIGRATION_SQL).toContain("EXCEPTION WHEN others THEN");
    expect(MIGRATION_SQL).toContain("deal write preserved");
  });
});
