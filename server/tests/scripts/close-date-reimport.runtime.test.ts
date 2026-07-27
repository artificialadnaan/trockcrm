import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import {
  applyCloseDate,
  runReimport,
  type ImportRowInput,
  type Queryable,
} from "../../../scripts/lib/close-date-workflow.js";

/**
 * REAL-SQL (PGlite) coverage of the v2 RE-IMPORT (fill-or-refresh, protect a
 * maintained future date). `today` is injected for determinism: empty -> WRITTEN,
 * stale-past -> REFRESHED, same -> NOOP, different FUTURE -> CONFLICT (unless
 * --overwrite-existing -> OVERWRITTEN). Dry-run writes nothing; the run never
 * crashes on a bad row; per-row SAVEPOINT isolation; idempotent.
 */
const TODAY = "2026-06-04";
const U = (s: string) => `00000000-0000-4000-8000-${s.padStart(12, "0")}`;
const DEALS = {
  empty: U("e1"),
  same: U("e2"),
  stale: U("e3"),
  futureDiff: U("e4"),
  blank: U("e5"),
  bad: U("e6"),
  atlEmpty: U("a1"),
  ghost: U("f0"), // valid uuid, no row
};
const VALID = new Set(["office_dallas", "office_atlanta"]);
const SHEET = "2026-09-15"; // a future date the rep entered

let pg: PGlite;
let client: Queryable;

async function dateOf(schema: string, id: string): Promise<string | null> {
  const { rows } = await pg.query<{ d: string | null }>(
    `SELECT to_char(expected_close_date, 'YYYY-MM-DD') AS d FROM ${schema}.deals WHERE id = $1`,
    [id],
  );
  return rows[0]?.d ?? null;
}

/** A filled sheet covering every v2 outcome. */
function standardRows(): ImportRowInput[] {
  return [
    { tenantSchema: "office_dallas", dealId: DEALS.empty, rawDate: SHEET }, // WRITTEN
    { tenantSchema: "office_dallas", dealId: DEALS.same, rawDate: SHEET }, // NOOP
    { tenantSchema: "office_dallas", dealId: DEALS.stale, rawDate: SHEET }, // REFRESHED (existing past)
    { tenantSchema: "office_dallas", dealId: DEALS.futureDiff, rawDate: SHEET }, // CONFLICT / OVERWRITTEN (existing future)
    { tenantSchema: "office_dallas", dealId: DEALS.blank, rawDate: "" }, // SKIPPED_BLANK
    { tenantSchema: "office_dallas", dealId: DEALS.bad, rawDate: "whenever" }, // INVALID_DATE
    { tenantSchema: "office_dallas", dealId: "not-a-uuid", rawDate: SHEET }, // INVALID_KEY (bad id)
    { tenantSchema: "office_nope", dealId: DEALS.empty, rawDate: SHEET }, // INVALID_KEY (unknown schema)
    { tenantSchema: "office_dallas", dealId: DEALS.ghost, rawDate: SHEET }, // UNMATCHED
    { tenantSchema: "office_atlanta", dealId: DEALS.atlEmpty, rawDate: SHEET }, // WRITTEN (cross-tenant)
  ];
}

beforeAll(async () => {
  pg = new PGlite();
  client = { query: (text: string, params?: unknown[]) => pg.query(text, params) };
  await pg.exec(`
    CREATE SCHEMA office_dallas;
    CREATE SCHEMA office_atlanta;
    CREATE TABLE office_dallas.deals (id uuid PRIMARY KEY, sales_source_user_id uuid, deal_number text, expected_close_date date, bid_due_date timestamptz, updated_at timestamptz DEFAULT now());
    CREATE TABLE office_atlanta.deals (id uuid PRIMARY KEY, deal_number text, expected_close_date date, bid_due_date timestamptz, updated_at timestamptz DEFAULT now());
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
      ('${DEALS.same}','DFW-2','${SHEET}'),
      ('${DEALS.stale}','DFW-3','2026-01-01'),
      ('${DEALS.futureDiff}','DFW-4','2026-12-01'),
      ('${DEALS.blank}','DFW-5', NULL),
      ('${DEALS.bad}','DFW-6', NULL);
    INSERT INTO office_atlanta.deals (id, deal_number, expected_close_date) VALUES
      ('${DEALS.atlEmpty}','ATL-1', NULL);
  `);
});

describe("close-date v2 re-import (PGlite)", () => {
  it("dry-run previews every outcome (incl. REFRESHED for stale) and writes NOTHING", async () => {
    const report = await runReimport({ client, rows: standardRows(), validSchemas: VALID, mode: "dry-run", overwriteExisting: false, today: TODAY });

    expect(report.counts.WRITTEN).toBe(2);
    expect(report.counts.REFRESHED).toBe(1);
    expect(report.counts.NOOP).toBe(1);
    expect(report.counts.CONFLICT).toBe(1);
    expect(report.counts.SKIPPED_BLANK).toBe(1);
    expect(report.counts.INVALID_DATE).toBe(1);
    expect(report.counts.INVALID_KEY).toBe(2);
    expect(report.counts.UNMATCHED).toBe(1);
    expect(report.counts.total).toBe(10);

    // nothing persisted
    expect(await dateOf("office_dallas", DEALS.empty)).toBeNull();
    expect(await dateOf("office_dallas", DEALS.stale)).toBe("2026-01-01");
    expect(await dateOf("office_dallas", DEALS.futureDiff)).toBe("2026-12-01");
  });

  it("--commit fills empty, REFRESHES stale, and PROTECTS a maintained future date", async () => {
    const report = await runReimport({ client, rows: standardRows(), validSchemas: VALID, mode: "commit", overwriteExisting: false, today: TODAY });

    expect(report.counts.WRITTEN).toBe(2);
    expect(report.counts.REFRESHED).toBe(1);
    expect(report.counts.CONFLICT).toBe(1);

    expect(await dateOf("office_dallas", DEALS.empty)).toBe(SHEET); // filled
    expect(await dateOf("office_atlanta", DEALS.atlEmpty)).toBe(SHEET); // cross-tenant
    expect(await dateOf("office_dallas", DEALS.stale)).toBe(SHEET); // stale refreshed
    expect(await dateOf("office_dallas", DEALS.same)).toBe(SHEET); // noop
    expect(await dateOf("office_dallas", DEALS.futureDiff)).toBe("2026-12-01"); // future PROTECTED
  });

  it("is idempotent: a second --commit is all NOOP (no new writes/refreshes)", async () => {
    await runReimport({ client, rows: standardRows(), validSchemas: VALID, mode: "commit", overwriteExisting: false, today: TODAY });
    const second = await runReimport({ client, rows: standardRows(), validSchemas: VALID, mode: "commit", overwriteExisting: false, today: TODAY });

    expect(second.counts.WRITTEN).toBe(0);
    expect(second.counts.REFRESHED).toBe(0);
    expect(second.counts.NOOP).toBe(4); // empty, same, stale, atlEmpty all == sheet now
    expect(second.counts.CONFLICT).toBe(1); // futureDiff still differs
  });

  it("--overwrite-existing replaces the maintained future date (still refreshes stale either way)", async () => {
    const report = await runReimport({ client, rows: standardRows(), validSchemas: VALID, mode: "commit", overwriteExisting: true, today: TODAY });
    expect(report.counts.OVERWRITTEN).toBe(1); // the future deal
    expect(report.counts.REFRESHED).toBe(1); // the stale deal
    expect(report.counts.CONFLICT).toBe(0);
    expect(await dateOf("office_dallas", DEALS.futureDiff)).toBe(SHEET); // replaced
  });

  it("rejects a sheet value in the PAST (un-usable forecast) as INVALID_DATE, writing nothing", async () => {
    const report = await runReimport({
      client,
      rows: [{ tenantSchema: "office_dallas", dealId: DEALS.stale, rawDate: "2026-02-01" }], // past relative to TODAY
      validSchemas: VALID,
      mode: "commit",
      overwriteExisting: false,
      today: TODAY,
    });
    expect(report.counts.INVALID_DATE).toBe(1);
    expect(report.counts.REFRESHED).toBe(0);
    expect(await dateOf("office_dallas", DEALS.stale)).toBe("2026-01-01"); // unchanged — not falsely "refreshed"
  });

  it("never throws on bad rows — the whole run completes and reports them", async () => {
    const report = await runReimport({
      client,
      rows: [
        { tenantSchema: "office_dallas", dealId: "not-a-uuid", rawDate: SHEET },
        { tenantSchema: "office_dallas", dealId: DEALS.bad, rawDate: "garbage" },
        { tenantSchema: "office_dallas", dealId: DEALS.ghost, rawDate: SHEET },
      ],
      validSchemas: VALID,
      mode: "commit",
      overwriteExisting: false,
      today: TODAY,
    });
    expect(report.counts.total).toBe(3);
    expect(report.counts.WRITTEN).toBe(0);
    expect(report.counts.REFRESHED).toBe(0);
  });
});

describe("re-import fault isolation (real DB errors + races + commit failure)", () => {
  let fpg: PGlite;
  let fclient: Queryable;
  const A = U("fa1");
  const B = U("fb2"); // its write violates a CHECK -> real mid-transaction PG error
  const C = U("fc3");

  beforeAll(async () => {
    fpg = new PGlite();
    fclient = { query: (text: string, params?: unknown[]) => fpg.query(text, params) };
    await fpg.exec(`
      CREATE SCHEMA office_dallas;
      CREATE TABLE office_dallas.deals (
        id uuid PRIMARY KEY, expected_close_date date, bid_due_date timestamptz, updated_at timestamptz DEFAULT now(),
        CONSTRAINT no_sentinel CHECK (expected_close_date <> DATE '2099-12-31')
      );
    `);
  });
  afterAll(async () => {
    await fpg?.close?.();
  });
  beforeEach(async () => {
    await fpg.exec(`DELETE FROM office_dallas.deals;
      INSERT INTO office_dallas.deals (id) VALUES ('${A}'), ('${B}'), ('${C}');`);
  });

  function dateOfF(id: string) {
    return fpg
      .query<{ d: string | null }>(`SELECT to_char(expected_close_date,'YYYY-MM-DD') AS d FROM office_dallas.deals WHERE id = $1`, [id])
      .then((r) => r.rows[0]?.d ?? null);
  }

  it("applyCloseDate guard: writes over null/stale, skips a maintained future date, unconditional when forced", async () => {
    expect(await applyCloseDate(fclient, "office_dallas", A, SHEET, { guard: "null_or_stale", today: TODAY })).toBe(true); // was null
    expect(await applyCloseDate(fclient, "office_dallas", A, "2026-10-01", { guard: "null_or_stale", today: TODAY })).toBe(false); // now future -> skipped
    expect(await applyCloseDate(fclient, "office_dallas", A, "2026-10-01", { guard: "none" })).toBe(true); // forced
    await fpg.query(`UPDATE office_dallas.deals SET expected_close_date = DATE '2025-01-01' WHERE id = $1`, [A]); // make stale
    expect(await applyCloseDate(fclient, "office_dallas", A, SHEET, { guard: "null_or_stale", today: TODAY })).toBe(true); // refreshes stale
  });

  it("a real per-row DB error rolls back ONLY that row (SAVEPOINT) and the rest commit", async () => {
    const report = await runReimport({
      client: fclient,
      rows: [
        { tenantSchema: "office_dallas", dealId: A, rawDate: SHEET },
        { tenantSchema: "office_dallas", dealId: B, rawDate: "2099-12-31" }, // violates CHECK
        { tenantSchema: "office_dallas", dealId: C, rawDate: "2026-10-01" },
      ],
      validSchemas: new Set(["office_dallas"]),
      mode: "commit",
      overwriteExisting: false,
      today: TODAY,
    });
    expect(report.counts.WRITTEN).toBe(2);
    expect(report.counts.ERROR).toBe(1);
    expect(report.results.find((r) => r.dealId === B)!.outcome).toBe("ERROR");
    expect(await dateOfF(A)).toBe(SHEET);
    expect(await dateOfF(B)).toBeNull();
    expect(await dateOfF(C)).toBe("2026-10-01");
  });

  it("PROTECTS a future date set concurrently between read and write (CONFLICT, value preserved)", async () => {
    let injected = false;
    const racing: Queryable = {
      query: async (text: string, params?: unknown[]) => {
        if (!injected && /UPDATE\s.*SET expected_close_date/i.test(text) && params?.[1] === A) {
          injected = true;
          await fpg.query(`UPDATE office_dallas.deals SET expected_close_date = DATE '2026-12-01' WHERE id = $1`, [A]); // becomes FUTURE
        }
        return fpg.query(text, params);
      },
    };
    const report = await runReimport({
      client: racing,
      rows: [{ tenantSchema: "office_dallas", dealId: A, rawDate: SHEET }],
      validSchemas: new Set(["office_dallas"]),
      mode: "commit",
      overwriteExisting: false,
      today: TODAY,
    });
    expect(report.counts.WRITTEN).toBe(0);
    expect(report.counts.CONFLICT).toBe(1);
    expect(await dateOfF(A)).toBe("2026-12-01"); // concurrent future forecast preserved
  });

  it("under --overwrite-existing, a write that loses the race to a future date still overwrites (no false ERROR)", async () => {
    let injected = false;
    const racing: Queryable = {
      query: async (text: string, params?: unknown[]) => {
        if (!injected && /UPDATE\s.*SET expected_close_date/i.test(text) && params?.[1] === A) {
          injected = true;
          await fpg.query(`UPDATE office_dallas.deals SET expected_close_date = DATE '2026-12-01' WHERE id = $1`, [A]);
        }
        return fpg.query(text, params);
      },
    };
    const report = await runReimport({
      client: racing,
      rows: [{ tenantSchema: "office_dallas", dealId: A, rawDate: SHEET }],
      validSchemas: new Set(["office_dallas"]),
      mode: "commit",
      overwriteExisting: true,
      today: TODAY,
    });
    expect(report.counts.ERROR).toBe(0);
    expect(report.counts.OVERWRITTEN).toBe(1); // the forced reclassify path is genuinely exercised
    expect(report.counts.WRITTEN).toBe(0);
    expect(await dateOfF(A)).toBe(SHEET);
  });

  it("a concurrent STALE edit between read and write still writes truthfully (guard matches null OR stale)", async () => {
    let injected = false;
    const racing: Queryable = {
      query: async (text: string, params?: unknown[]) => {
        if (!injected && /UPDATE\s.*SET expected_close_date/i.test(text) && params?.[1] === A) {
          injected = true;
          await fpg.query(`UPDATE office_dallas.deals SET expected_close_date = DATE '2026-02-01' WHERE id = $1`, [A]); // becomes a DIFFERENT past date
        }
        return fpg.query(text, params);
      },
    };
    const report = await runReimport({
      client: racing,
      rows: [{ tenantSchema: "office_dallas", dealId: A, rawDate: SHEET }],
      validSchemas: new Set(["office_dallas"]),
      mode: "commit",
      overwriteExisting: false,
      today: TODAY,
    });
    expect(report.counts.ERROR).toBe(0);
    expect(report.counts.WRITTEN).toBe(1); // A was null at read -> WRITTEN; guard still matched the injected stale date
    expect(await dateOfF(A)).toBe(SHEET); // sheet value persisted, no false report
  });

  it("applyCloseDate throws if the null_or_stale guard is used without `today`", async () => {
    await expect(applyCloseDate(fclient, "office_dallas", A, SHEET, { guard: "null_or_stale" })).rejects.toThrow();
  });

  it("a COMMIT failure marks the ENTIRE rolled-back tenant batch as ERROR (no false WRITTEN)", async () => {
    const failing: Queryable = {
      query: async (text: string, params?: unknown[]) => {
        if (text.trim().toUpperCase() === "COMMIT") throw new Error("injected commit failure");
        return fpg.query(text, params);
      },
    };
    const report = await runReimport({
      client: failing,
      rows: [
        { tenantSchema: "office_dallas", dealId: A, rawDate: SHEET },
        { tenantSchema: "office_dallas", dealId: C, rawDate: "2026-10-01" },
      ],
      validSchemas: new Set(["office_dallas"]),
      mode: "commit",
      overwriteExisting: false,
      today: TODAY,
    });
    expect(report.counts.WRITTEN).toBe(0);
    expect(report.counts.ERROR).toBe(2);
    expect(await dateOfF(A)).toBeNull();
    expect(await dateOfF(C)).toBeNull();
  });
});

describe("re-import is side-effect-safe under the guarded deal triggers (incl. a Bid Board mirror row)", () => {
  let tpg: PGlite;
  let tclient: Queryable;
  const DEAL = U("aa1");
  const MIRROR = U("bb2"); // is_read_only_mirror = true (Bid Board Owned)
  const STAGE = U("57a6e");
  const REP = U("4ec");
  const ACTOR = U("ac70");

  beforeAll(async () => {
    tpg = new PGlite();
    tclient = { query: (text: string, params?: unknown[]) => tpg.query(text, params) };
    await tpg.exec(`
      CREATE SCHEMA office_dallas;
      CREATE TABLE pipeline_stage_config (id uuid PRIMARY KEY, slug text, name text, display_order int);
      CREATE TABLE office_dallas.deals (
        id uuid PRIMARY KEY, stage_id uuid NOT NULL, assigned_rep_id uuid, created_by_user_id uuid,
        project_number text, rfp_approval_status text, is_read_only_mirror boolean NOT NULL DEFAULT false,
        expected_close_date date, bid_due_date timestamptz, stage_entered_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz DEFAULT now()
      );
      CREATE TABLE office_dallas.deal_stage_history (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), deal_id uuid, from_stage_id uuid, to_stage_id uuid,
        changed_by uuid NOT NULL, is_backward_move boolean, duration_in_previous_stage interval, created_at timestamptz
      );
      CREATE TABLE office_dallas.job_queue (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), kind text, deal_id uuid);
      CREATE TABLE office_dallas.audit_log (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), record_id uuid, action text, changed_by uuid);

      CREATE OR REPLACE FUNCTION reset_stage_entered_at() RETURNS TRIGGER AS $$
      BEGIN IF OLD.stage_id IS DISTINCT FROM NEW.stage_id THEN NEW.stage_entered_at = NOW(); END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;

      CREATE OR REPLACE FUNCTION test_enqueue_job() RETURNS TRIGGER AS $$
      BEGIN INSERT INTO office_dallas.job_queue (kind, deal_id) VALUES (TG_ARGV[0], NEW.id); RETURN NEW; END; $$ LANGUAGE plpgsql;

      CREATE OR REPLACE FUNCTION test_audit() RETURNS TRIGGER AS $$
      BEGIN INSERT INTO office_dallas.audit_log (record_id, action, changed_by)
        VALUES (NEW.id, 'update', NULLIF(current_setting('app.current_user_id', true), '')::uuid); RETURN NEW; END; $$ LANGUAGE plpgsql;

      CREATE OR REPLACE FUNCTION public.record_stage_history() RETURNS trigger AS $body$
      DECLARE v_actor uuid;
      BEGIN
        IF coalesce(current_setting('app.skip_stage_history_trigger', true), '') = '1' THEN RETURN NEW; END IF;
        IF TG_OP = 'UPDATE' AND OLD.stage_id IS NOT DISTINCT FROM NEW.stage_id THEN RETURN NEW; END IF;
        BEGIN
          v_actor := coalesce(nullif(current_setting('app.current_user_id', true), '')::uuid, NEW.assigned_rep_id, NEW.created_by_user_id);
          IF v_actor IS NOT NULL THEN
            EXECUTE format('INSERT INTO %I.deal_stage_history (deal_id, to_stage_id, changed_by, created_at) VALUES ($1,$2,$3,$4)', TG_TABLE_SCHEMA)
              USING NEW.id, NEW.stage_id, v_actor, NEW.stage_entered_at;
          END IF;
        EXCEPTION WHEN others THEN RAISE WARNING 'skipped: %', SQLERRM; END;
        RETURN NEW;
      END; $body$ LANGUAGE plpgsql;

      CREATE TRIGGER set_reset_stage BEFORE UPDATE ON office_dallas.deals FOR EACH ROW EXECUTE FUNCTION reset_stage_entered_at();
      CREATE TRIGGER stage_history_trigger AFTER INSERT OR UPDATE ON office_dallas.deals FOR EACH ROW EXECUTE FUNCTION public.record_stage_history();
      CREATE TRIGGER email_project_number AFTER UPDATE OF project_number ON office_dallas.deals FOR EACH ROW EXECUTE FUNCTION test_enqueue_job('project_number');
      CREATE TRIGGER email_stage AFTER UPDATE OF stage_id ON office_dallas.deals FOR EACH ROW EXECUTE FUNCTION test_enqueue_job('stage');
      CREATE TRIGGER email_rfp AFTER UPDATE OF rfp_approval_status ON office_dallas.deals FOR EACH ROW EXECUTE FUNCTION test_enqueue_job('rfp');
      CREATE TRIGGER audit_deals AFTER UPDATE ON office_dallas.deals FOR EACH ROW EXECUTE FUNCTION test_audit();

      INSERT INTO pipeline_stage_config (id, slug, name, display_order) VALUES ('${STAGE}','estimating','Estimating', 2);
      INSERT INTO office_dallas.deals (id, stage_id, assigned_rep_id, expected_close_date, is_read_only_mirror, stage_entered_at) VALUES
        ('${DEAL}','${STAGE}','${REP}', NULL, false, '2026-02-01T00:00:00Z'),
        ('${MIRROR}','${STAGE}','${REP}', NULL, true, '2026-02-01T00:00:00Z');
    `);
  });

  afterAll(async () => {
    await tpg?.close?.();
  });

  it("writing expected_close_date (incl. a Bid Board mirror deal) fires no notifications/stage-history and attributes the audit row", async () => {
    await tpg.exec(`DELETE FROM office_dallas.deal_stage_history; DELETE FROM office_dallas.job_queue; DELETE FROM office_dallas.audit_log;`);
    const before = await tpg.query<{ se: string }>(`SELECT stage_entered_at::text AS se FROM office_dallas.deals WHERE id = $1`, [DEAL]);

    const report = await runReimport({
      client: tclient,
      rows: [
        { tenantSchema: "office_dallas", dealId: DEAL, rawDate: SHEET },
        { tenantSchema: "office_dallas", dealId: MIRROR, rawDate: SHEET }, // Bid Board Owned
      ],
      validSchemas: new Set(["office_dallas"]),
      mode: "commit",
      overwriteExisting: false,
      today: TODAY,
      actorUserId: ACTOR,
    });
    expect(report.counts.WRITTEN).toBe(2);

    expect((await tpg.query<{ d: string }>(`SELECT to_char(expected_close_date,'YYYY-MM-DD') AS d FROM office_dallas.deals WHERE id = $1`, [MIRROR])).rows[0].d).toBe(SHEET);
    expect((await tpg.query<{ n: number }>(`SELECT count(*)::int AS n FROM office_dallas.deal_stage_history`)).rows[0].n).toBe(0);
    expect((await tpg.query<{ n: number }>(`SELECT count(*)::int AS n FROM office_dallas.job_queue`)).rows[0].n).toBe(0);

    const after = await tpg.query<{ se: string }>(`SELECT stage_entered_at::text AS se FROM office_dallas.deals WHERE id = $1`, [DEAL]);
    expect(after.rows[0].se).toBe(before.rows[0].se);

    const audit = await tpg.query<{ n: number; distinct_actor: string | null }>(
      `SELECT count(*)::int AS n, max(changed_by::text) AS distinct_actor FROM office_dallas.audit_log`,
    );
    expect(audit.rows[0].n).toBe(2); // one per written deal
    expect(audit.rows[0].distinct_actor).toBe(ACTOR);
  });
});
