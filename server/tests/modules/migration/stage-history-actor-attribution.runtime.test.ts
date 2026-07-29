import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";

// The REAL 0143 (which created the backstop and its assigned-rep fallback) applied verbatim, then the REAL
// 0207 on top. Modelling 0143's output by hand would be testing my description of the trigger rather than
// the trigger — and the whole defect here lives in one coalesce() inside it.
const PRIOR_MIGRATION_SQL = readFileSync(
  new URL("../../../../migrations/0143_reenable_forward_stage_history.sql", import.meta.url),
  "utf8",
);
const MIGRATION_SQL = readFileSync(
  new URL("../../../../migrations/0207_stage_history_actor_no_rep_fallback.sql", import.meta.url),
  "utf8",
);

const SCHEMA = "office_dallas";
const REP = "11111111-1111-1111-1111-111111111111";
const CREATOR = "22222222-2222-2222-2222-222222222222";
const REAL_ACTOR = "33333333-3333-3333-3333-333333333333";
const EARLY = "aaaaaaaa-0000-0000-0000-000000000001";
const LATE = "aaaaaaaa-0000-0000-0000-000000000002";

// ONE PGlite instance for the whole file, booted in beforeAll.
//
// Each test used to build its own and apply both migrations — five boots, and each is a full in-memory
// Postgres. Under the server suite's four workers and 15s testTimeout that setup cost lands INSIDE the
// first test's budget and fails on contention while passing when the file runs alone. Tests are isolated
// by deal id instead, which is cheaper and does not depend on how busy the runner is.
let pg: PGlite;

beforeAll(async () => {
  pg = await buildDb();
}, 60_000);

afterAll(async () => {
  await pg?.close();
});

async function buildDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    CREATE SCHEMA ${SCHEMA};
    CREATE TABLE public.users (id uuid PRIMARY KEY, email text);
    CREATE TABLE public.pipeline_stage_config (id uuid PRIMARY KEY, name text, display_order int);
    CREATE TABLE ${SCHEMA}.deals (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      stage_id uuid,
      assigned_rep_id uuid,
      created_by_user_id uuid,
      stage_entered_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE ${SCHEMA}.deal_stage_history (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      deal_id uuid NOT NULL,
      from_stage_id uuid,
      to_stage_id uuid NOT NULL,
      changed_by uuid NOT NULL REFERENCES public.users(id),
      is_backward_move boolean NOT NULL DEFAULT false,
      is_director_override boolean NOT NULL DEFAULT false,
      override_reason text,
      duration_in_previous_stage interval,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    INSERT INTO public.users (id, email) VALUES
      ('${REP}','rep@trockgc.com'), ('${CREATOR}','creator@trockgc.com'), ('${REAL_ACTOR}','actor@trockgc.com');
    INSERT INTO public.pipeline_stage_config (id, name, display_order) VALUES
      ('${EARLY}','Opportunity',2), ('${LATE}','Won',7);
  `);
  await db.exec(PRIOR_MIGRATION_SQL);
  await db.exec(MIGRATION_SQL);
  return db;
}

/** A deal that HAS an assigned rep and a creator — the fallback had both to reach for. */
async function seedDeal(db: PGlite, opts: { rep?: string | null; creator?: string | null } = {}) {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO ${SCHEMA}.deals (stage_id, assigned_rep_id, created_by_user_id)
     VALUES ($1, $2, $3) RETURNING id`,
    [LATE, opts.rep === undefined ? REP : opts.rep, opts.creator === undefined ? CREATOR : opts.creator],
  );
  // Drop THIS deal's creation row only — the moves are the subject. A global DELETE was fine when every
  // test owned its own database; with one shared instance it would erase a sibling test's evidence.
  await db.query(`DELETE FROM ${SCHEMA}.deal_stage_history WHERE deal_id = $1`, [rows[0].id]);
  return rows[0].id;
}

async function history(db: PGlite, dealId: string) {
  const { rows } = await db.query<{ changed_by: string | null; is_backward_move: boolean }>(
    `SELECT changed_by, is_backward_move FROM ${SCHEMA}.deal_stage_history WHERE deal_id = $1`,
    [dealId],
  );
  return rows;
}

describe("migration 0207 — stage-history actor attribution", () => {
  it("records a NULL actor for an unattributed write instead of blaming the assigned rep", async () => {
    // The defect, exactly. A sync/script/raw-SQL write sets no app.current_user_id, and 0143 resolved the
    // actor as the deal's own assigned rep — so a batch job presented as that rep moving their deal by
    // hand. It misdirected two investigations, and usage-rollup counts DISTINCT changed_by as evidence the
    // user was ACTIVE that day, so it also marked reps active on days they may never have signed in.
    const db = pg;
    const dealId = await seedDeal(db);

    await db.query(`UPDATE ${SCHEMA}.deals SET stage_id = $1 WHERE id = $2`, [EARLY, dealId]);

    const rows = await history(db, dealId);
    expect(rows).toHaveLength(1);
    expect(rows[0].changed_by).toBeNull();
    // The specific lie this migration exists to stop.
    expect(rows[0].changed_by).not.toBe(REP);
    // ...and the rest of the backstop still works: Won(7) -> Opportunity(2) is backward.
    expect(rows[0].is_backward_move).toBe(true);
  });

  it("still records the REAL actor when the session supplies one", async () => {
    // The app path sets app.current_user_id. Dropping the fallback must not drop genuine attribution.
    const db = pg;
    const dealId = await seedDeal(db);

    await db.exec("BEGIN");
    await db.query("SELECT set_config('app.current_user_id', $1, true)", [REAL_ACTOR]);
    await db.query(`UPDATE ${SCHEMA}.deals SET stage_id = $1 WHERE id = $2`, [EARLY, dealId]);
    await db.exec("COMMIT");

    const rows = await history(db, dealId);
    expect(rows).toHaveLength(1);
    expect(rows[0].changed_by).toBe(REAL_ACTOR);
  });

  it("RECOVERS history that 0143 silently discarded when nobody could be named", async () => {
    // 0143 skipped the insert entirely when no actor resolved, so a stage change on a deal with neither an
    // assigned rep nor a creator left NO trace — losing precisely the machine-made transitions that are
    // hardest to reconstruct afterwards. Recording it with a null actor is strictly more truthful.
    const db = pg;
    const dealId = await seedDeal(db, { rep: null, creator: null });

    await db.query(`UPDATE ${SCHEMA}.deals SET stage_id = $1 WHERE id = $2`, [EARLY, dealId]);

    const rows = await history(db, dealId);
    expect(rows).toHaveLength(1);
    expect(rows[0].changed_by).toBeNull();
  });

  it("keeps honouring the app's skip flag, so the explicit insert is never doubled", async () => {
    // changeDealStage writes its own rich row and sets this flag. If the backstop stopped respecting it the
    // History tab would show every transition twice.
    const db = pg;
    const dealId = await seedDeal(db);

    await db.exec("BEGIN");
    await db.query("SELECT set_config('app.skip_stage_history_trigger', '1', true)");
    await db.query(`UPDATE ${SCHEMA}.deals SET stage_id = $1 WHERE id = $2`, [EARLY, dealId]);
    await db.exec("COMMIT");

    expect(await history(db, dealId)).toHaveLength(0);
  });

  // The ONE test that legitimately needs its own database — it asserts across TWO office schemas, which the
  // shared fixture deliberately does not have. Explicit budget because it pays a second PGlite boot on a
  // runner that may already be busy; `pg` is left alone so afterAll still closes the shared instance.
  it("drops NOT NULL in every office schema, not just the one the TENANT block names", async () => {
    // The tenant block hard-codes office_dallas for provisioning to replay; the DO-loop is what covers the
    // offices that already exist. Shipping only one of the two is how a tenant change lands half-applied.
    const db = new PGlite();
    try {
    await db.exec(`
      CREATE SCHEMA ${SCHEMA};
      CREATE SCHEMA office_atlanta;
      CREATE TABLE public.users (id uuid PRIMARY KEY);
      CREATE TABLE public.pipeline_stage_config (id uuid PRIMARY KEY, name text, display_order int);
    `);
    for (const schema of [SCHEMA, "office_atlanta"]) {
      await db.exec(`
        CREATE TABLE ${schema}.deals (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(), stage_id uuid, assigned_rep_id uuid,
          created_by_user_id uuid, stage_entered_at timestamptz NOT NULL DEFAULT now());
        CREATE TABLE ${schema}.deal_stage_history (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(), deal_id uuid NOT NULL, from_stage_id uuid,
          to_stage_id uuid NOT NULL, changed_by uuid NOT NULL REFERENCES public.users(id),
          is_backward_move boolean NOT NULL DEFAULT false, is_director_override boolean NOT NULL DEFAULT false,
          override_reason text, duration_in_previous_stage interval,
          created_at timestamptz NOT NULL DEFAULT now());
      `);
    }
    await db.exec(PRIOR_MIGRATION_SQL);
    await db.exec(MIGRATION_SQL);

    const { rows } = await db.query<{ table_schema: string; is_nullable: string }>(
      `SELECT table_schema, is_nullable FROM information_schema.columns
        WHERE table_name = 'deal_stage_history' AND column_name = 'changed_by'
        ORDER BY table_schema`,
    );
    expect(rows.map((r) => [r.table_schema, r.is_nullable])).toEqual([
      ["office_atlanta", "YES"],
      ["office_dallas", "YES"],
    ]);
    } finally {
      await db.close();
    }
  }, 60_000);
});
