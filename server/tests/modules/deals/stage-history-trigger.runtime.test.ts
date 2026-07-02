import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Runtime coverage for the forward stage-history backstop trigger (migration 0143). The
// repo has no Postgres test harness, so this boots an in-memory Postgres (PGlite), loads the
// REAL record_stage_history() function from the latest migration that defines it, attaches
// it to a TENANT (office_*) schema -- exactly as production does -- and drives the same paths
// verified by hand post-deploy: one row per path (create/bulk/app/sync), the skip-flag
// de-dup, the no-flag double-record control, stage_entered_at == created_at, backward-move
// flagging, and the no-actor skip.

const MIGRATIONS_DIR = fileURLToPath(new URL("../../../../migrations", import.meta.url));
const SIG = "CREATE OR REPLACE FUNCTION public.record_stage_history()";

// Extract the function body from the LATEST migration that defines it. Fails loudly rather
// than silently testing a stale definition if a future migration changes the dollar-tag or
// terminator (which would defeat "latest definer wins").
function loadRecordStageHistoryFn(): string {
  const target = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .filter((f) => readFileSync(`${MIGRATIONS_DIR}/${f}`, "utf8").includes(SIG))
    .pop();
  if (!target) throw new Error("record_stage_history() is not defined in any migration");
  const sql = readFileSync(`${MIGRATIONS_DIR}/${target}`, "utf8");
  const start = sql.indexOf(SIG);
  const tag = sql.slice(start).match(/\bAS\s+(\$[A-Za-z0-9_]*\$)/);
  if (!tag) throw new Error(`could not find the body delimiter of record_stage_history() in ${target}`);
  const bodyStart = start + (tag.index ?? 0) + tag[0].length;
  const closeIdx = sql.indexOf(tag[1], bodyStart);
  if (closeIdx === -1) throw new Error(`unterminated record_stage_history() body in ${target}`);
  const semi = sql.indexOf(";", closeIdx + tag[1].length);
  if (semi === -1) throw new Error(`missing statement terminator for record_stage_history() in ${target}`);
  return sql.slice(start, semi + 1);
}

const T = "office_test"; // a tenant schema -> exercises the function's TG_TABLE_SCHEMA insert
const ST = {
  opp: "00000000-0000-0000-0000-0000000000a2",
  est: "00000000-0000-0000-0000-0000000000a3",
  eur: "00000000-0000-0000-0000-0000000000a4",
  ess: "00000000-0000-0000-0000-0000000000a5",
};
const REP = "00000000-0000-0000-0000-0000000000f1";

let db: PGlite;
let seq = 0;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE SCHEMA ${T};
    CREATE TABLE public.users (id uuid PRIMARY KEY);
    CREATE TABLE public.pipeline_stage_config (id uuid PRIMARY KEY, display_order int);
    CREATE TABLE ${T}.deals (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), sales_source_user_id uuid,
      deal_number text NOT NULL, name text NOT NULL, stage_id uuid NOT NULL,
      stage_entered_at timestamptz NOT NULL DEFAULT now(),
      assigned_rep_id uuid, created_by_user_id uuid
    );
    CREATE TABLE ${T}.deal_stage_history (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      deal_id uuid NOT NULL, from_stage_id uuid, to_stage_id uuid NOT NULL,
      changed_by uuid NOT NULL REFERENCES public.users(id),
      is_backward_move boolean NOT NULL DEFAULT false,
      is_director_override boolean NOT NULL DEFAULT false,
      override_reason text, duration_in_previous_stage interval,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE FUNCTION public.reset_stage_entered_at() RETURNS trigger AS $$
    BEGIN IF OLD.stage_id IS DISTINCT FROM NEW.stage_id THEN NEW.stage_entered_at = now(); END IF; RETURN NEW; END;
    $$ LANGUAGE plpgsql;
    CREATE TRIGGER stage_entered_at_trigger BEFORE UPDATE ON ${T}.deals
      FOR EACH ROW EXECUTE FUNCTION public.reset_stage_entered_at();
  `);
  await db.exec(loadRecordStageHistoryFn());
  await db.exec(`CREATE TRIGGER stage_history_trigger AFTER INSERT OR UPDATE ON ${T}.deals
    FOR EACH ROW EXECUTE FUNCTION public.record_stage_history();`);
  await db.exec(`
    INSERT INTO public.users (id) VALUES ('${REP}');
    INSERT INTO public.pipeline_stage_config (id, display_order) VALUES
      ('${ST.opp}',2),('${ST.est}',3),('${ST.eur}',4),('${ST.ess}',5);
  `);
});
afterAll(async () => { await db?.close(); });

async function histIds(dealId: string): Promise<Set<string>> {
  const r = await db.query<{ id: string }>(`SELECT id FROM ${T}.deal_stage_history WHERE deal_id=$1`, [dealId]);
  return new Set(r.rows.map((x) => x.id));
}
async function newRows(dealId: string, before: Set<string>) {
  const after = [...(await histIds(dealId))].filter((i) => !before.has(i));
  if (!after.length) return [] as any[];
  const r = await db.query<any>(
    `SELECT h.from_stage_id, h.to_stage_id, h.changed_by, h.is_backward_move,
            (h.created_at = d.stage_entered_at) AS ts_match
     FROM ${T}.deal_stage_history h JOIN ${T}.deals d ON d.id=h.deal_id
     WHERE h.id = ANY($1::uuid[])`, [after]);
  return r.rows;
}
async function makeDeal(stage: string, opts: { rep?: string | null } = {}) {
  const rep = opts.rep === undefined ? REP : opts.rep;
  const r = await db.query<{ id: string }>(
    `INSERT INTO ${T}.deals (deal_number, name, stage_id, assigned_rep_id)
     VALUES ($1,'verify',$2,$3) RETURNING id`, [`TR-PG-${++seq}`, stage, rep]);
  return r.rows[0].id;
}

describe("record_stage_history trigger (runtime, PGlite, tenant schema)", () => {
  it("records a 'Created in' row on deal creation (from NULL, dated stage_entered_at)", async () => {
    const id = await makeDeal(ST.opp);
    const added = await newRows(id, new Set());
    expect(added).toHaveLength(1);
    expect(added[0].from_stage_id).toBeNull();
    expect(added[0].to_stage_id).toBe(ST.opp);
    expect(added[0].changed_by).toBe(REP);
    expect(added[0].ts_match).toBe(true);
  });

  it("records a bulk/raw stage change (the backstop) -- one forward row", async () => {
    const id = await makeDeal(ST.opp);
    const before = await histIds(id);
    await db.query(`UPDATE ${T}.deals SET stage_id=$1 WHERE id=$2`, [ST.est, id]);
    const added = await newRows(id, before);
    expect(added).toHaveLength(1);
    expect(added[0].from_stage_id).toBe(ST.opp);
    expect(added[0].to_stage_id).toBe(ST.est);
    expect(added[0].is_backward_move).toBe(false);
    expect(added[0].ts_match).toBe(true);
  });

  it("flags a backward stage change via display_order (P2)", async () => {
    const id = await makeDeal(ST.est);
    const before = await histIds(id);
    await db.query(`UPDATE ${T}.deals SET stage_id=$1 WHERE id=$2`, [ST.opp, id]); // ord 3 -> 2
    const added = await newRows(id, before);
    expect(added).toHaveLength(1);
    expect(added[0].is_backward_move).toBe(true);
  });

  it("de-dupes the app/sync path: skip flag + UPDATE + explicit insert => exactly one row", async () => {
    const id = await makeDeal(ST.opp);
    const before = await histIds(id);
    await db.transaction(async (tx) => {
      await tx.query(`SELECT set_config('app.skip_stage_history_trigger','1',true)`);
      await tx.query(`UPDATE ${T}.deals SET stage_id=$1 WHERE id=$2`, [ST.eur, id]);
      await tx.query(`INSERT INTO ${T}.deal_stage_history (deal_id, from_stage_id, to_stage_id, changed_by) VALUES ($1,$2,$3,$4)`, [id, ST.opp, ST.eur, REP]);
    });
    expect(await newRows(id, before)).toHaveLength(1); // explicit only; trigger suppressed
  });

  it("WITHOUT the flag the same pattern double-records (the flag is load-bearing -- the P1 bug)", async () => {
    const id = await makeDeal(ST.opp);
    const before = await histIds(id);
    await db.transaction(async (tx) => {
      await tx.query(`UPDATE ${T}.deals SET stage_id=$1 WHERE id=$2`, [ST.eur, id]); // trigger fires
      await tx.query(`INSERT INTO ${T}.deal_stage_history (deal_id, from_stage_id, to_stage_id, changed_by) VALUES ($1,$2,$3,$4)`, [id, ST.opp, ST.eur, REP]);
    });
    expect(await newRows(id, before)).toHaveLength(2); // trigger row + explicit row
  });

  it("never breaks a stage change when no actor resolves -- skips the row, update still applies", async () => {
    const id = await makeDeal(ST.opp, { rep: null }); // no actor -> no creation row
    const before = await histIds(id);
    await db.query(`UPDATE ${T}.deals SET stage_id=$1 WHERE id=$2`, [ST.est, id]);
    expect(await newRows(id, before)).toHaveLength(0);
    const d = await db.query<{ stage_id: string }>(`SELECT stage_id FROM ${T}.deals WHERE id=$1`, [id]);
    expect(d.rows[0].stage_id).toBe(ST.est); // the stage change succeeded
  });
});
