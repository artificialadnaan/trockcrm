import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import {
  runReimport,
  type ImportRowInput,
  type Queryable,
} from "../../../scripts/lib/close-date-workflow.js";

/**
 * REAL-SQL (PGlite) coverage of the RE-IMPORT. Safe default: never clobber an
 * existing date (CONFLICT), dry-run writes nothing, blanks/bad-dates/bad-keys/
 * unmatched rows are reported (never crash the run), commit is idempotent, and
 * --overwrite-existing is the only way to replace an existing date.
 */
const U = (s: string) => `00000000-0000-4000-8000-${s.padStart(12, "0")}`;
const DEALS = {
  empty: U("e1"),
  same: U("e2"),
  diff: U("e3"),
  blank: U("e4"),
  bad: U("e5"),
  atlEmpty: U("a1"),
  ghost: U("f0"), // valid uuid, no row
};
const VALID = new Set(["office_dallas", "office_atlanta"]);

let pg: PGlite;
let client: Queryable;

async function dateOf(schema: string, id: string): Promise<string | null> {
  const { rows } = await pg.query<{ d: string | null }>(
    `SELECT to_char(expected_close_date, 'YYYY-MM-DD') AS d FROM ${schema}.deals WHERE id = $1`,
    [id],
  );
  return rows[0]?.d ?? null;
}

/** The standard "filled sheet" covering every outcome. */
function standardRows(): ImportRowInput[] {
  return [
    { tenantSchema: "office_dallas", dealId: DEALS.empty, rawDate: "2026-09-15" }, // WRITTEN
    { tenantSchema: "office_dallas", dealId: DEALS.same, rawDate: "2026-09-15" }, // NOOP
    { tenantSchema: "office_dallas", dealId: DEALS.diff, rawDate: "2026-09-15" }, // CONFLICT / OVERWRITTEN
    { tenantSchema: "office_dallas", dealId: DEALS.blank, rawDate: "" }, // SKIPPED_BLANK
    { tenantSchema: "office_dallas", dealId: DEALS.bad, rawDate: "whenever" }, // INVALID_DATE
    { tenantSchema: "office_dallas", dealId: "not-a-uuid", rawDate: "2026-09-15" }, // INVALID_KEY (bad id)
    { tenantSchema: "office_nope", dealId: DEALS.empty, rawDate: "2026-09-15" }, // INVALID_KEY (unknown schema)
    { tenantSchema: "office_dallas", dealId: DEALS.ghost, rawDate: "2026-09-15" }, // UNMATCHED
    { tenantSchema: "office_atlanta", dealId: DEALS.atlEmpty, rawDate: "2026-09-15" }, // WRITTEN (cross-tenant)
  ];
}

beforeAll(async () => {
  pg = new PGlite();
  client = { query: (text: string, params?: unknown[]) => pg.query(text, params) };
  await pg.exec(`
    CREATE SCHEMA office_dallas;
    CREATE SCHEMA office_atlanta;
    CREATE TABLE office_dallas.deals (id uuid PRIMARY KEY, deal_number text, expected_close_date date, updated_at timestamptz DEFAULT now());
    CREATE TABLE office_atlanta.deals (id uuid PRIMARY KEY, deal_number text, expected_close_date date, updated_at timestamptz DEFAULT now());
  `);
});

afterAll(async () => {
  await pg?.close?.();
});

beforeEach(async () => {
  await pg.exec(`
    DELETE FROM office_dallas.deals; DELETE FROM office_atlanta.deals;
    INSERT INTO office_dallas.deals (id, deal_number, expected_close_date) VALUES
      ('${DEALS.empty}','DFW-1', NULL),
      ('${DEALS.same}','DFW-2','2026-09-15'),
      ('${DEALS.diff}','DFW-3','2026-01-01'),
      ('${DEALS.blank}','DFW-4', NULL),
      ('${DEALS.bad}','DFW-5', NULL);
    INSERT INTO office_atlanta.deals (id, deal_number, expected_close_date) VALUES
      ('${DEALS.atlEmpty}','ATL-1', NULL);
  `);
});

describe("close-date re-import (PGlite)", () => {
  it("dry-run previews every outcome and writes NOTHING", async () => {
    const report = await runReimport({ client, rows: standardRows(), validSchemas: VALID, mode: "dry-run", overwriteExisting: false });

    expect(report.counts.WRITTEN).toBe(2);
    expect(report.counts.NOOP).toBe(1);
    expect(report.counts.CONFLICT).toBe(1);
    expect(report.counts.SKIPPED_BLANK).toBe(1);
    expect(report.counts.INVALID_DATE).toBe(1);
    expect(report.counts.INVALID_KEY).toBe(2);
    expect(report.counts.UNMATCHED).toBe(1);
    expect(report.counts.total).toBe(9);

    // Nothing persisted in dry-run.
    expect(await dateOf("office_dallas", DEALS.empty)).toBeNull();
    expect(await dateOf("office_atlanta", DEALS.atlEmpty)).toBeNull();
    expect(await dateOf("office_dallas", DEALS.diff)).toBe("2026-01-01");
  });

  it("--commit writes filled dates to the right deal by id+office, never clobbering a conflict", async () => {
    const report = await runReimport({ client, rows: standardRows(), validSchemas: VALID, mode: "commit", overwriteExisting: false });

    expect(report.counts.WRITTEN).toBe(2);
    expect(report.counts.CONFLICT).toBe(1);

    expect(await dateOf("office_dallas", DEALS.empty)).toBe("2026-09-15"); // written
    expect(await dateOf("office_atlanta", DEALS.atlEmpty)).toBe("2026-09-15"); // cross-tenant written
    expect(await dateOf("office_dallas", DEALS.same)).toBe("2026-09-15"); // unchanged (noop)
    expect(await dateOf("office_dallas", DEALS.diff)).toBe("2026-01-01"); // CONFLICT: NOT clobbered
  });

  it("is idempotent: a second --commit writes nothing new (all NOOP)", async () => {
    await runReimport({ client, rows: standardRows(), validSchemas: VALID, mode: "commit", overwriteExisting: false });
    const second = await runReimport({ client, rows: standardRows(), validSchemas: VALID, mode: "commit", overwriteExisting: false });

    expect(second.counts.WRITTEN).toBe(0);
    expect(second.counts.NOOP).toBe(3); // empty, same, atlEmpty all now match the sheet
    expect(second.counts.CONFLICT).toBe(1); // diff still differs
    expect(await dateOf("office_dallas", DEALS.empty)).toBe("2026-09-15");
  });

  it("--overwrite-existing is the ONLY way an existing date is replaced", async () => {
    const report = await runReimport({ client, rows: standardRows(), validSchemas: VALID, mode: "commit", overwriteExisting: true });
    expect(report.counts.OVERWRITTEN).toBe(1);
    expect(report.counts.CONFLICT ?? 0).toBe(0);
    expect(await dateOf("office_dallas", DEALS.diff)).toBe("2026-09-15"); // replaced
  });

  it("never throws on bad rows — the whole run completes and reports them", async () => {
    const onlyBadRows: ImportRowInput[] = [
      { tenantSchema: "office_dallas", dealId: "not-a-uuid", rawDate: "2026-09-15" },
      { tenantSchema: "office_dallas", dealId: DEALS.bad, rawDate: "garbage" },
      { tenantSchema: "office_dallas", dealId: DEALS.ghost, rawDate: "2026-09-15" },
    ];
    const report = await runReimport({ client, rows: onlyBadRows, validSchemas: VALID, mode: "commit", overwriteExisting: false });
    expect(report.counts.total).toBe(3);
    expect(report.counts.WRITTEN).toBe(0);
  });
});

describe("re-import is side-effect-safe under the guarded deal triggers", () => {
  let tpg: PGlite;
  let tclient: Queryable;
  const DEAL = U("aa1");
  const STAGE = U("57a6e");
  const REP = U("4ec");

  beforeAll(async () => {
    tpg = new PGlite();
    tclient = { query: (text: string, params?: unknown[]) => tpg.query(text, params) };
    // Reproduce the two triggers that fire on a GENERIC deals UPDATE in production
    // (migrations 0143 record_stage_history + 0001 reset_stage_entered_at). Both are
    // guarded on a stage_id change, so a close-date-only update must be inert.
    await tpg.exec(`
      CREATE SCHEMA office_dallas;
      CREATE TABLE pipeline_stage_config (id uuid PRIMARY KEY, slug text, name text, display_order int);
      CREATE TABLE office_dallas.deals (
        id uuid PRIMARY KEY, stage_id uuid NOT NULL, assigned_rep_id uuid, created_by_user_id uuid,
        expected_close_date date, stage_entered_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz DEFAULT now()
      );
      CREATE TABLE office_dallas.deal_stage_history (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), deal_id uuid, from_stage_id uuid, to_stage_id uuid,
        changed_by uuid NOT NULL, is_backward_move boolean, duration_in_previous_stage interval, created_at timestamptz
      );

      CREATE OR REPLACE FUNCTION reset_stage_entered_at() RETURNS TRIGGER AS $$
      BEGIN
        IF OLD.stage_id IS DISTINCT FROM NEW.stage_id THEN NEW.stage_entered_at = NOW(); END IF;
        RETURN NEW;
      END; $$ LANGUAGE plpgsql;

      CREATE OR REPLACE FUNCTION public.record_stage_history() RETURNS trigger AS $body$
      DECLARE v_actor uuid; v_backward boolean;
      BEGIN
        IF coalesce(current_setting('app.skip_stage_history_trigger', true), '') = '1' THEN RETURN NEW; END IF;
        IF TG_OP = 'UPDATE' AND OLD.stage_id IS NOT DISTINCT FROM NEW.stage_id THEN RETURN NEW; END IF;
        BEGIN
          v_actor := coalesce(nullif(current_setting('app.current_user_id', true), '')::uuid, NEW.assigned_rep_id, NEW.created_by_user_id);
          IF v_actor IS NOT NULL THEN
            IF TG_OP = 'INSERT' THEN
              EXECUTE format('INSERT INTO %I.deal_stage_history (deal_id, from_stage_id, to_stage_id, changed_by, duration_in_previous_stage, created_at) VALUES ($1, NULL, $2, $3, NULL, $4)', TG_TABLE_SCHEMA)
                USING NEW.id, NEW.stage_id, v_actor, NEW.stage_entered_at;
            ELSE
              EXECUTE format('INSERT INTO %I.deal_stage_history (deal_id, from_stage_id, to_stage_id, changed_by, is_backward_move, duration_in_previous_stage, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)', TG_TABLE_SCHEMA)
                USING NEW.id, OLD.stage_id, NEW.stage_id, v_actor, false, NEW.stage_entered_at - OLD.stage_entered_at, NEW.stage_entered_at;
            END IF;
          END IF;
        EXCEPTION WHEN others THEN RAISE WARNING 'skipped: %', SQLERRM; END;
        RETURN NEW;
      END; $body$ LANGUAGE plpgsql;

      CREATE TRIGGER set_reset_stage BEFORE UPDATE ON office_dallas.deals FOR EACH ROW EXECUTE FUNCTION reset_stage_entered_at();
      CREATE TRIGGER stage_history_trigger AFTER INSERT OR UPDATE ON office_dallas.deals FOR EACH ROW EXECUTE FUNCTION public.record_stage_history();

      INSERT INTO pipeline_stage_config (id, slug, name, display_order) VALUES ('${STAGE}','estimating','Estimating', 2);
      INSERT INTO office_dallas.deals (id, stage_id, assigned_rep_id, expected_close_date, stage_entered_at)
        VALUES ('${DEAL}','${STAGE}','${REP}', NULL, '2026-02-01T00:00:00Z');
    `);
  });

  afterAll(async () => {
    await tpg?.close?.();
  });

  it("writing expected_close_date inserts NO stage-history row and leaves stage_entered_at untouched", async () => {
    // The seed INSERT legitimately recorded the deal's initial stage (production
    // behavior). Clear it so we measure ONLY the close-date UPDATE's side effects.
    await tpg.exec(`DELETE FROM office_dallas.deal_stage_history`);
    const before = await tpg.query<{ se: string }>(`SELECT stage_entered_at::text AS se FROM office_dallas.deals WHERE id = $1`, [DEAL]);

    const report = await runReimport({
      client: tclient,
      rows: [{ tenantSchema: "office_dallas", dealId: DEAL, rawDate: "2026-09-15" }],
      validSchemas: new Set(["office_dallas"]),
      mode: "commit",
      overwriteExisting: false,
    });
    expect(report.counts.WRITTEN).toBe(1);

    const written = await tpg.query<{ d: string }>(`SELECT to_char(expected_close_date,'YYYY-MM-DD') AS d FROM office_dallas.deals WHERE id = $1`, [DEAL]);
    expect(written.rows[0].d).toBe("2026-09-15");

    const history = await tpg.query<{ n: number }>(`SELECT count(*)::int AS n FROM office_dallas.deal_stage_history`);
    expect(history.rows[0].n).toBe(0); // no spurious stage-history row

    const after = await tpg.query<{ se: string }>(`SELECT stage_entered_at::text AS se FROM office_dallas.deals WHERE id = $1`, [DEAL]);
    expect(after.rows[0].se).toBe(before.rows[0].se); // stage_entered_at unchanged
  });
});
