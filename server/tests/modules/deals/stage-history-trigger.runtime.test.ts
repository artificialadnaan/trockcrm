import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Runtime coverage for the forward stage-history backstop trigger (migration 0143). The
// repo has no Postgres test harness, so this boots an in-memory Postgres (PGlite), loads the
// REAL record_stage_history() function from the latest migration that defines it (so it
// follows future redefinitions, not just 0143), and drives the same paths verified by hand
// post-deploy: one row per path (create/bulk/app/sync), the skip-flag de-dup, the no-flag
// double-record control, stage_entered_at == created_at, and backward-move flagging.

const MIGRATIONS_DIR = fileURLToPath(new URL("../../../../migrations", import.meta.url));

function loadRecordStageHistoryFn(): string {
  const marker = "$body$ LANGUAGE plpgsql;";
  let fn = "";
  for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort()) {
    const sql = readFileSync(`${MIGRATIONS_DIR}/${file}`, "utf8");
    const start = sql.indexOf("CREATE OR REPLACE FUNCTION public.record_stage_history()");
    if (start === -1) continue;
    const end = sql.indexOf(marker, start);
    if (end === -1) continue;
    fn = sql.slice(start, end + marker.length); // latest definer wins
  }
  if (!fn) throw new Error("record_stage_history() not found in any migration");
  return fn;
}

// stage uuids carry their pipeline display_order in the last hex digit (2..5)
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
    CREATE TABLE public.users (id uuid PRIMARY KEY);
    CREATE TABLE public.pipeline_stage_config (id uuid PRIMARY KEY, display_order int);
    CREATE TABLE public.deals (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      deal_number text NOT NULL, name text NOT NULL, stage_id uuid NOT NULL,
      stage_entered_at timestamptz NOT NULL DEFAULT now(),
      assigned_rep_id uuid, created_by_user_id uuid
    );
    CREATE TABLE public.deal_stage_history (
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
    CREATE TRIGGER stage_entered_at_trigger BEFORE UPDATE ON public.deals
      FOR EACH ROW EXECUTE FUNCTION public.reset_stage_entered_at();
  `);
  await db.exec(loadRecordStageHistoryFn());
  await db.exec(`CREATE TRIGGER stage_history_trigger AFTER INSERT OR UPDATE ON public.deals
    FOR EACH ROW EXECUTE FUNCTION public.record_stage_history();`);
  await db.exec(`
    INSERT INTO public.users (id) VALUES ('${REP}');
    INSERT INTO public.pipeline_stage_config (id, display_order) VALUES
      ('${ST.opp}',2),('${ST.est}',3),('${ST.eur}',4),('${ST.ess}',5);
  `);
});
afterAll(async () => { await db?.close(); });

async function histIds(dealId: string): Promise<Set<string>> {
  const r = await db.query<{ id: string }>(`SELECT id FROM public.deal_stage_history WHERE deal_id=$1`, [dealId]);
  return new Set(r.rows.map((x) => x.id));
}
async function newRows(dealId: string, before: Set<string>) {
  const after = [...(await histIds(dealId))].filter((i) => !before.has(i));
  if (!after.length) return [] as any[];
  const r = await db.query<any>(
    `SELECT h.from_stage_id, h.to_stage_id, h.changed_by, h.is_backward_move,
            (h.created_at = d.stage_entered_at) AS ts_match
     FROM public.deal_stage_history h JOIN public.deals d ON d.id=h.deal_id
     WHERE h.id = ANY($1::uuid[])`, [after]);
  return r.rows;
}
async function makeDeal(stage: string, opts: { rep?: string | null } = {}) {
  const rep = opts.rep === undefined ? REP : opts.rep;
  const r = await db.query<{ id: string }>(
    `INSERT INTO public.deals (deal_number, name, stage_id, assigned_rep_id)
     VALUES ($1,'verify',$2,$3) RETURNING id`, [`TR-PG-${++seq}`, stage, rep]);
  return r.rows[0].id;
}

describe("record_stage_history trigger (runtime, PGlite)", () => {
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
    await db.query(`UPDATE public.deals SET stage_id=$1 WHERE id=$2`, [ST.est, id]);
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
    await db.query(`UPDATE public.deals SET stage_id=$1 WHERE id=$2`, [ST.opp, id]); // ord 3 -> 2
    const added = await newRows(id, before);
    expect(added).toHaveLength(1);
    expect(added[0].is_backward_move).toBe(true);
  });

  it("de-dupes the app/sync path: skip flag + UPDATE + explicit insert => exactly one row", async () => {
    const id = await makeDeal(ST.opp);
    const before = await histIds(id);
    await db.transaction(async (tx) => {
      await tx.query(`SELECT set_config('app.skip_stage_history_trigger','1',true)`);
      await tx.query(`UPDATE public.deals SET stage_id=$1 WHERE id=$2`, [ST.eur, id]);
      await tx.query(`INSERT INTO public.deal_stage_history (deal_id, from_stage_id, to_stage_id, changed_by) VALUES ($1,$2,$3,$4)`, [id, ST.opp, ST.eur, REP]);
    });
    expect(await newRows(id, before)).toHaveLength(1); // explicit only; trigger suppressed
  });

  it("WITHOUT the flag the same pattern double-records (the flag is load-bearing -- the P1 bug)", async () => {
    const id = await makeDeal(ST.opp);
    const before = await histIds(id);
    await db.transaction(async (tx) => {
      await tx.query(`UPDATE public.deals SET stage_id=$1 WHERE id=$2`, [ST.eur, id]); // trigger fires
      await tx.query(`INSERT INTO public.deal_stage_history (deal_id, from_stage_id, to_stage_id, changed_by) VALUES ($1,$2,$3,$4)`, [id, ST.opp, ST.eur, REP]);
    });
    expect(await newRows(id, before)).toHaveLength(2); // trigger row + explicit row
  });

  it("never breaks a stage change when no actor resolves -- skips the row, update still applies", async () => {
    const id = await makeDeal(ST.opp, { rep: null }); // no actor -> no creation row
    const before = await histIds(id);
    await db.query(`UPDATE public.deals SET stage_id=$1 WHERE id=$2`, [ST.est, id]);
    expect(await newRows(id, before)).toHaveLength(0);
    const d = await db.query<{ stage_id: string }>(`SELECT stage_id FROM public.deals WHERE id=$1`, [id]);
    expect(d.rows[0].stage_id).toBe(ST.est); // the stage change succeeded
  });
});
