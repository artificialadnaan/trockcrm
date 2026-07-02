import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";

/**
 * REAL-SQL (PGlite) proof for migration 0146. The #498 back-seed (migration 0138) inserts a
 * `project_number_first_set` audit marker for every deal that already had a project_number at
 * deploy. The 0138 trigger gates the email enqueue on the audit INSERT succeeding, so a back-seeded
 * deal's later genuine null->non-null assignment hit the dedup and was silently dropped.
 *
 * This installs the ACTUAL trigger function (extracted from each migration file) on a throwaway
 * tenant schema and drives it with real DML, asserting:
 *   - OLD 0138 function: a back-seeded deal does NOT enqueue on a genuine new number (locks the bug);
 *   - 0146 function: it DOES enqueue exactly one job, reusing the existing marker id;
 *   - 0146 function: a fresh deal enqueues exactly one job and records a `transition='set'` marker;
 *   - 0146 function: re-setting an already-numbered deal does not enqueue (first-set semantics intact).
 */

const FN_0138 = extractFunction(
  readFileSync(
    new URL("../../../../migrations/0138_project_number_first_set_notification.sql", import.meta.url),
    "utf8",
  ),
);
const FN_0146 = extractFunction(
  readFileSync(
    new URL("../../../../migrations/0146_project_number_first_set_email_unblock_backseed.sql", import.meta.url),
    "utf8",
  ),
);

function extractFunction(sql: string): string {
  const match = sql.match(
    /CREATE OR REPLACE FUNCTION public\.enqueue_project_number_first_set_email[\s\S]*?\$\$;/,
  );
  if (!match) throw new Error("could not extract enqueue_project_number_first_set_email function body");
  return match[0];
}

const SCHEMA = "office_test";
const SET_MARKER = "jsonb_build_array(jsonb_build_object('transition','set'))";

let pg: PGlite | null = null;

afterEach(async () => {
  await pg?.close();
  pg = null;
});

async function setup(functionSql: string): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    CREATE TYPE public.audit_action AS ENUM ('insert','update','delete','soft_delete','legacy_cleanup_scope_change');
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
      project_number text
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
    CREATE UNIQUE INDEX audit_log_project_number_first_set_uidx
      ON ${SCHEMA}.audit_log (record_id)
      WHERE table_name = 'deals' AND actor_system_process = 'project_number_first_set';
  `);
  await db.exec(functionSql);
  await db.exec(`
    CREATE TRIGGER deals_project_number_first_set_email_trg
      AFTER INSERT OR UPDATE OF project_number ON ${SCHEMA}.deals
      FOR EACH ROW EXECUTE FUNCTION public.enqueue_project_number_first_set_email();
  `);
  return db;
}

async function insertDeal(db: PGlite, id: string, name: string, projectNumber: string | null): Promise<void> {
  await db.query(`INSERT INTO ${SCHEMA}.deals (id, name, project_number) VALUES ($1, $2, $3)`, [
    id,
    name,
    projectNumber,
  ]);
}

/** Simulate the #498 back-seed: a `transition='existing'` marker exists, but no email was ever sent. */
async function backSeedMarker(db: PGlite, dealId: string, name: string, oldNumber: string): Promise<string> {
  const res = await db.query<{ id: string }>(
    `INSERT INTO ${SCHEMA}.audit_log
       (table_name, record_id, action, actor_system_process, entity_type,
        entity_name_snapshot, entity_secondary_id_snapshot, field_changes_jsonb, changes, visibility_scope)
     VALUES ('deals', $1, 'update', 'project_number_first_set', 'deal',
        $2, $3, jsonb_build_array(jsonb_build_object('transition','existing')), '{}'::jsonb, 'internal')
     RETURNING id`,
    [dealId, name, oldNumber],
  );
  return res.rows[0]!.id;
}

async function emailJobs(db: PGlite): Promise<Array<{ payload: { auditLogId: number; projectNumber: string; dealId: string; tenantSchema: string } }>> {
  const res = await db.query<{ payload: { auditLogId: number; projectNumber: string; dealId: string; tenantSchema: string } }>(
    `SELECT payload FROM public.job_queue WHERE job_type = 'project_number_first_set_email' ORDER BY id`,
  );
  return res.rows;
}

const BETA = "00000000-0000-0000-0000-0000000000b1";
const ACME = "00000000-0000-0000-0000-0000000000a1";
const FRESH = "00000000-0000-0000-0000-0000000000c1";
const RESET = "00000000-0000-0000-0000-0000000000d1";
const CYCLE = "00000000-0000-0000-0000-0000000000e1";

describe("project_number_first_set trigger — back-seed must not block future sends", () => {
  it("OLD 0138 function: a back-seeded deal's genuine new number is silently NOT enqueued (the bug)", async () => {
    pg = await setup(FN_0138);
    await insertDeal(pg, ACME, "Acme", null);
    await backSeedMarker(pg, ACME, "Acme", "OLD-1");

    await pg.query(`UPDATE ${SCHEMA}.deals SET project_number = $2 WHERE id = $1`, [ACME, "DFW-1-99"]);

    expect(await emailJobs(pg)).toHaveLength(0); // blocked by the pre-existing back-seed marker
  });

  it("0146 function: a back-seeded deal's genuine new number enqueues exactly one job, reusing the marker id (the fix)", async () => {
    pg = await setup(FN_0146);
    await insertDeal(pg, BETA, "Beta", null);
    const seedId = await backSeedMarker(pg, BETA, "Beta", "OLD-2");

    await pg.query(`UPDATE ${SCHEMA}.deals SET project_number = $2 WHERE id = $1`, [BETA, "DFW-1-77"]);

    const jobs = await emailJobs(pg);
    expect(jobs).toHaveLength(1);
    expect(String(jobs[0]!.payload.auditLogId)).toBe(String(seedId)); // reused the existing marker
    expect(jobs[0]!.payload.projectNumber).toBe("DFW-1-77");
    expect(jobs[0]!.payload.dealId).toBe(BETA);
    expect(jobs[0]!.payload.tenantSchema).toBe(SCHEMA);
  });

  it("0146 function: a fresh deal (no prior marker) enqueues exactly one job and records a 'set' marker", async () => {
    pg = await setup(FN_0146);
    await insertDeal(pg, FRESH, "Fresh", null);

    await pg.query(`UPDATE ${SCHEMA}.deals SET project_number = $2 WHERE id = $1`, [FRESH, "DFW-1-10"]);

    const jobs = await emailJobs(pg);
    expect(jobs).toHaveLength(1);
    const markerRes = await pg.query<{ field_changes_jsonb: unknown }>(
      `SELECT field_changes_jsonb FROM ${SCHEMA}.audit_log WHERE record_id = $1 AND actor_system_process = 'project_number_first_set'`,
      [FRESH],
    );
    expect(markerRes.rows).toHaveLength(1);
    expect(JSON.stringify(markerRes.rows[0]!.field_changes_jsonb)).toContain('"transition":"set"');
    // the enqueued job references the freshly-inserted marker
    const markerId = await pg.query<{ id: string }>(
      `SELECT id FROM ${SCHEMA}.audit_log WHERE record_id = $1 AND actor_system_process = 'project_number_first_set'`,
      [FRESH],
    );
    expect(String(jobs[0]!.payload.auditLogId)).toBe(String(markerId.rows[0]!.id));
  });

  it("0146 function: re-setting an already-numbered deal does not enqueue (first-set semantics intact)", async () => {
    pg = await setup(FN_0146);
    await insertDeal(pg, RESET, "Reset", null);
    await pg.query(`UPDATE ${SCHEMA}.deals SET project_number = $2 WHERE id = $1`, [RESET, "DFW-1-20"]); // first set -> 1 job
    expect(await emailJobs(pg)).toHaveLength(1);

    await pg.query(`UPDATE ${SCHEMA}.deals SET project_number = $2 WHERE id = $1`, [RESET, "DFW-1-21"]); // re-set (old non-null) -> no job
    expect(await emailJobs(pg)).toHaveLength(1);
  });

  it("0146 function: a clear-then-reset cycle re-enqueues with the SAME stable marker id (handler receipt dedups to one send)", async () => {
    pg = await setup(FN_0146);
    await insertDeal(pg, CYCLE, "Cycle", null);

    await pg.query(`UPDATE ${SCHEMA}.deals SET project_number = $2 WHERE id = $1`, [CYCLE, "DFW-1-30"]); // first set -> job 1
    let jobs = await emailJobs(pg);
    expect(jobs).toHaveLength(1);
    const firstId = String(jobs[0]!.payload.auditLogId);

    await pg.query(`UPDATE ${SCHEMA}.deals SET project_number = NULL WHERE id = $1`, [CYCLE]); // clear -> no job
    expect(await emailJobs(pg)).toHaveLength(1);

    await pg.query(`UPDATE ${SCHEMA}.deals SET project_number = $2 WHERE id = $1`, [CYCLE, "DFW-1-31"]); // re-set -> job 2, SAME marker id
    jobs = await emailJobs(pg);
    expect(jobs).toHaveLength(2);
    // both jobs carry the same stable audit_log_id, so the handler's receipts ledger (tenant_schema,
    // audit_log_id) sends exactly once and dedups the second — proven by the handler unit tests.
    expect(String(jobs[1]!.payload.auditLogId)).toBe(firstId);
    expect(jobs[1]!.payload.projectNumber).toBe("DFW-1-31");
  });

  it("uses the canonical 'set' marker shape (guards the field_changes_jsonb contract)", () => {
    expect(FN_0146).toContain("'transition', 'set'");
    expect(FN_0146).toContain("ON CONFLICT DO NOTHING");
    expect(FN_0146).toContain("'project_number_first_set_email'");
    // the marker payload shape used elsewhere (kept stable)
    void SET_MARKER;
  });
});
