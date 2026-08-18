// ★ THE ACCEPTANCE TEST for the Bid Board Due Date -> deals.bid_due_date write-through.
//
// This write is NOT cosmetic. Since 2026-07-27 `bid_due_date` is the auto-park HORIZON for genuine
// estimating-stage deals ([[deal-hold-risk]] / holdHorizonDateSql), so a date more than 90 CT-days out
// zeroes the deal's value on cards, dashboards, at-risk counts and the worker rollups — and a nearer date
// un-parks a deal a far-out close target had parked. The sync runs on a SCHEDULE, so there is no human
// between a deploy and the first mass write. Everything below therefore runs the REAL ingestBidBoardRows
// against an in-memory Postgres (only the pg pool is swapped for a PGlite client), never a string mock:
// the UTC-midnight instant, the IS DISTINCT FROM guard and the blank-never-clears rule are all properties
// of the SQL, and a mock would assert my beliefs about the SQL instead of the SQL.
//
// The single most important case here is "flag off => no write and no history row". `bid_board_due_date`
// is already populated on prod, so the flag is the only thing making this PR inert.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";

const U = (s: string) => `00000000-0000-4000-8000-${s.padStart(12, "0")}`;
const SCHEMA = "office_test";
const ADMIN = U("5e7");
const ST_ESTIMATING = U("57e1");
const ST_WON = U("57e4");

const DEAL = U("d0001");
const DETACHED = U("d0002");

let pg: PGlite;

// node-pg exposes rowCount; PGlite exposes affectedRows. The production code reads rowCount, so present a
// node-pg-compatible client here — a harness adapter, not a code change.
const client = {
  query: async (text: string, params?: unknown[]) => {
    const r: unknown = await pg.query(text, params as never);
    const row = r as { rows: unknown[]; affectedRows?: number; rowCount?: number };
    return { ...row, rowCount: row.affectedRows ?? row.rowCount ?? row.rows?.length ?? 0 };
  },
  release: () => {},
};

vi.mock("../../../src/db.js", () => ({
  pool: { connect: async () => client },
  releasePooledClient: () => {},
  isBrokenConnectionError: () => false,
}));

const { ingestBidBoardRows } = await import("../../../src/modules/bid-board-sync/service.js");

/** One export row for the deal below; `Due Date` is what this suite is about. */
function exportRow(overrides: Record<string, unknown> = {}) {
  return {
    Name: "Riverbend Tower",
    "Project #": "DFW-1-00001-aa",
    Status: "Estimate in Progress",
    "Total Sales": "250000",
    "Due Date": "2026-09-01",
    ...overrides,
  };
}

async function dealRow(id = DEAL) {
  const { rows } = await pg.query<Record<string, any>>(`SELECT * FROM ${SCHEMA}.deals WHERE id = '${id}'`);
  return rows[0];
}

async function historyRows(id = DEAL) {
  const { rows } = await pg.query<Record<string, any>>(
    `SELECT field_name, old_value, new_value, changed_by, source, reason
       FROM ${SCHEMA}.deal_history WHERE deal_id = '${id}' ORDER BY changed_at ASC`
  );
  return rows;
}

/**
 * The audit mirror's RAW field changes for this deal. `changes` (the raw `{ field: { from, to } }` record),
 * not `field_changes_jsonb` (the display-formatted ARRAY the audit UI renders) — this asserts what the sync
 * recorded, not how the UI would draw it.
 */
async function auditFieldChanges(id = DEAL) {
  const { rows } = await pg.query<{ changes: Record<string, unknown> | null }>(
    `SELECT changes FROM ${SCHEMA}.audit_log WHERE record_id = '${id}'`
  );
  return rows.map((r) => r.changes).filter((c): c is Record<string, unknown> => c != null);
}

/**
 * `deals.bid_board_due_date` as a calendar day, read through a SQL ::text cast rather than String(Date):
 * node-pg/PGlite hand back a JS Date for a DATE column, whose default string form is rendered in the LOCAL
 * zone and reads a day early west of UTC — the exact off-by-one this feature is careful about.
 */
async function mirrorDay(id = DEAL): Promise<string | null> {
  const { rows } = await pg.query<{ mirror: string | null }>(
    `SELECT bid_board_due_date::text AS mirror FROM ${SCHEMA}.deals WHERE id = '${id}'`
  );
  return rows[0]?.mirror ?? null;
}

async function latestRun() {
  const { rows } = await pg.query<Record<string, any>>(
    `SELECT * FROM ${SCHEMA}.bid_board_sync_runs ORDER BY created_at DESC LIMIT 1`
  );
  return rows[0];
}

async function seedDeals(bidDueDate: string | null = null) {
  await pg.exec(`DELETE FROM ${SCHEMA}.deals;`);
  await pg.exec(`DELETE FROM ${SCHEMA}.deal_history;`);
  await pg.exec(`DELETE FROM ${SCHEMA}.deal_stage_history;`);
  await pg.exec(`DELETE FROM ${SCHEMA}.audit_log;`);
  await pg.exec(`DELETE FROM ${SCHEMA}.bid_board_sync_runs;`);
  await pg.query(
    `INSERT INTO ${SCHEMA}.deals
       (id, name, stage_id, stage_entered_at, workflow_route, deal_number, project_number,
        bid_board_project_number, bid_estimate, is_bid_board_owned, bid_board_stage_slug,
        is_active, bid_due_date, bid_board_detached_at, updated_at)
     VALUES
       ($1, 'Riverbend Tower', $2, now() - interval '5 days', 'normal',
        'DFW-1-00001-aa', 'DFW-1-00001-aa', 'DFW-1-00001-aa', 250000, true, 'estimating',
        true, $3::timestamptz, NULL, now() - interval '1 day'),
       ($4, 'Detached Tower', $2, now() - interval '5 days', 'normal',
        'DFW-2-00002-bb', 'DFW-2-00002-bb', NULL, 100000, false, NULL,
        true, NULL, '2026-07-20T12:00:00Z', now() - interval '1 day')`,
    [DEAL, ST_ESTIMATING, bidDueDate, DETACHED]
  );
}

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`SET TimeZone='UTC';`);
  await pg.exec(`
    CREATE TABLE public.pipeline_stage_config (
      id uuid PRIMARY KEY, slug text UNIQUE NOT NULL, name text NOT NULL,
      display_order int, is_terminal boolean NOT NULL DEFAULT false,
      is_active_pipeline boolean NOT NULL DEFAULT true
    );
    CREATE TABLE public.users (
      id uuid PRIMARY KEY, display_name text NOT NULL, is_active boolean NOT NULL DEFAULT true,
      role text, office_id uuid, created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE public.offices (id uuid PRIMARY KEY, slug text UNIQUE NOT NULL);
    CREATE SCHEMA ${SCHEMA};
    CREATE TABLE ${SCHEMA}.deals (
      id uuid PRIMARY KEY, name text, stage_id uuid NOT NULL, stage_entered_at timestamptz,
      on_hold boolean NOT NULL DEFAULT false, on_hold_started_at timestamptz,
      on_hold_accumulated_seconds bigint NOT NULL DEFAULT 0,
      on_hold_accumulated_seconds_at_stage_entry bigint NOT NULL DEFAULT 0,
      workflow_route text NOT NULL DEFAULT 'normal', deal_number text, project_number text,
      bid_board_project_number text, bid_board_estimator text, estimator_user_id uuid,
      sales_source_user_id uuid, bid_board_office text, bid_board_status text,
      bid_board_sales_price_per_area text, bid_board_project_cost numeric,
      bid_board_profit_margin_pct numeric, bid_board_total_sales numeric,
      bid_board_created_at timestamptz, bid_board_due_date date, bid_board_customer_name text,
      bid_board_customer_contact_raw text, bid_board_stage_slug text, bid_board_stage_family text,
      bid_board_stage_status text, bid_board_stage_entered_at timestamptz,
      bid_board_last_updated_at timestamptz, bid_estimate numeric, awarded_amount numeric,
      -- The column under test: a timestamptz stored at UTC midnight (migration 0132).
      bid_due_date timestamptz,
      -- Migration 0223: the provenance stamp the read resolver requires.
      bid_due_date_from_bid_board_at timestamptz, bid_due_date_bid_board_project_number text,
      won_closed_date date, contract_signed_date date, contract_signed_at timestamptz,
      actual_close_date date, lost_at timestamptz, bid_board_loss_outcome text,
      lost_reason_id uuid, lost_notes text, lost_competitor text,
      procore_bid_id bigint, is_bid_board_owned boolean NOT NULL DEFAULT false,
      read_only_synced_at timestamptz, is_active boolean NOT NULL DEFAULT true,
      is_change_order boolean NOT NULL DEFAULT false, parent_deal_id uuid,
      bid_board_detached_at timestamptz, bid_board_detached_by uuid, bid_board_detach_reason text,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE ${SCHEMA}.deal_stage_history (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      deal_id uuid NOT NULL, from_stage_id uuid, to_stage_id uuid NOT NULL, changed_by uuid NOT NULL,
      is_backward_move boolean NOT NULL DEFAULT false, is_director_override boolean NOT NULL DEFAULT false,
      override_reason text, duration_in_previous_stage interval,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE ${SCHEMA}.deal_history (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), deal_id uuid NOT NULL, field_name text NOT NULL,
      old_value text, new_value text, changed_by uuid, source text, reason text,
      changed_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE ${SCHEMA}.audit_log (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), table_name text, record_id uuid, action text,
      changed_by uuid, actor_name text, actor_role text, actor_system_process text, entity_type text,
      entity_name_snapshot text, entity_secondary_id_snapshot text, impersonator_id uuid,
      changes jsonb, field_changes_jsonb jsonb, full_row jsonb, visibility_scope text,
      ip_address text, user_agent text, created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE ${SCHEMA}.bid_board_sync_runs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), source_filename text, extracted_at timestamptz,
      payload_hash text, row_count int DEFAULT 0, updated_count int DEFAULT 0,
      no_match_count int DEFAULT 0, multi_match_count int DEFAULT 0, warning_count int DEFAULT 0,
      matched_count int DEFAULT 0, stage_updated_count int DEFAULT 0,
      skipped_no_project_number_count int DEFAULT 0, skipped_unmapped_status_count int DEFAULT 0,
      skipped_template_count int DEFAULT 0, applied_backward_count int DEFAULT 0,
      skipped_terminal_count int DEFAULT 0, skipped_no_stage_change_count int DEFAULT 0,
      skipped_detached_count int NOT NULL DEFAULT 0,
      estimate_updated_count int DEFAULT 0, estimate_updated_higher_count int DEFAULT 0,
      estimate_updated_lower_count int DEFAULT 0, estimate_skipped_no_value_count int DEFAULT 0,
      estimate_skipped_no_change_count int DEFAULT 0, estimate_warning_count int DEFAULT 0,
      estimate_skipped_terminal_count int DEFAULT 0,
      -- Migration 0222. NOT NULL DEFAULT 0 exactly as the migration declares it, so a run that never
      -- writes the column still reads as "zero deals moved".
      bid_due_date_updated_count int NOT NULL DEFAULT 0,
      status text DEFAULT 'received',
      errors jsonb DEFAULT '[]', warnings jsonb DEFAULT '[]',
      unmatched_project_numbers jsonb DEFAULT '[]', created_at timestamptz NOT NULL DEFAULT now()
    );
    INSERT INTO public.pipeline_stage_config (id, slug, name, display_order, is_terminal) VALUES
      ('${ST_ESTIMATING}', 'estimating', 'Estimating', 3, false),
      ('${ST_WON}', 'won', 'Won', 7, true);
    INSERT INTO public.users (id, display_name, is_active, role) VALUES ('${ADMIN}', 'Ada Admin', true, 'admin');
  `);
}, 30_000);

afterAll(async () => {
  await pg?.close();
});

beforeEach(async () => {
  await seedDeals();
  process.env.BID_BOARD_DUE_DATE_READBACK = "true";
});

afterEach(() => {
  delete process.env.BID_BOARD_DUE_DATE_READBACK;
});

describe("Bid Board Due Date -> deals.bid_due_date (flag ON)", () => {
  it("writes the export's Due Date at UTC MIDNIGHT, the shape holdHorizonDateSql reads back", async () => {
    const result = await ingestBidBoardRows({ office_slug: "test", rows: [exportRow()] });

    const deal = await dealRow();
    // The instant, not just the day: a bare date literal would resolve in the session timezone and could
    // land the deal on the previous calendar day, flipping its auto-park verdict and its dollar value.
    expect(new Date(deal.bid_due_date).toISOString()).toBe("2026-09-01T00:00:00.000Z");
    // …and the SQL twin agrees about which calendar day that is.
    const { rows } = await pg.query<{ day: string }>(
      `SELECT (bid_due_date AT TIME ZONE 'UTC')::date::text AS day FROM ${SCHEMA}.deals WHERE id = '${DEAL}'`
    );
    expect(rows[0].day).toBe("2026-09-01");
    expect(result.metrics.bidDueDateUpdated).toBe(1);
  });

  // ★ PROVENANCE (migration 0223). The read resolver refuses the override without this stamp, so the write
  // is what makes a deal eligible — a coincidental day match never does. Stamped in the same statement as
  // the value it vouches for.
  it("stamps bid_due_date_from_bid_board_at on the SAME write, so the deal becomes override-eligible", async () => {
    await ingestBidBoardRows({ office_slug: "test", rows: [exportRow()] });

    const { rows } = await pg.query<{ stamped: boolean; landed: boolean }>(
      `SELECT bid_due_date_from_bid_board_at IS NOT NULL AS stamped,
              ((bid_due_date AT TIME ZONE 'UTC')::date = bid_board_due_date) AS landed
         FROM ${SCHEMA}.deals WHERE id = '${DEAL}'`
    );
    expect(rows[0]).toEqual({ stamped: true, landed: true });
  });

  // ★ P2. A lead-backed legacy deal can already hold the RIGHT DAY while its lead says something else. The
  // value guard correctly skips it — there is nothing to write — but if that also skipped the stamp the
  // deal could never earn the override: every later sync carrying the same Board date would skip it again,
  // forever, even though the Board plainly confirms the date.
  it("STAMPS a deal whose day already matches, so a Board-confirmed date can still earn the override", async () => {
    await seedDeals("2026-09-01T00:00:00.000Z");
    expect((await dealRow()).bid_due_date_from_bid_board_at).toBeNull();

    const result = await ingestBidBoardRows({ office_slug: "test", rows: [exportRow()] });

    const after = await dealRow();
    // Provenance recorded...
    expect(after.bid_due_date_from_bid_board_at).not.toBeNull();
    expect(after.bid_due_date_bid_board_project_number).toBe("DFW-1-00001-aa");
    // ...the value untouched, and NOT counted as a change.
    expect(new Date(after.bid_due_date).toISOString()).toBe("2026-09-01T00:00:00.000Z");
    expect(result.metrics.bidDueDateUpdated).toBe(0);
    expect(result.metrics.bidDueDateProvenanceStamped).toBe(1);
    // NOT also counted as a skip: a row that was genuinely written is not a no-change row. The two
    // counters are mutually exclusive so the per-row outcomes reconcile against `matched`.
    expect(result.metrics.bidDueDateSkippedNoChange).toBe(0);
    // No history row and no audit entry: nothing a human reads changed. (`updated_at` is deliberately
    // NOT asserted — the ingest's own mirror UPDATE stamps it on every matched row regardless, so an
    // assertion here would be pinning someone else's behaviour, exactly as noted on the no-op case above.
    // The stamp-only branch's `updated_at = CASE ... ELSE d.updated_at END` is covered by the unit-level
    // guard instead.)
    expect((await historyRows()).filter((h) => h.field_name === "bid_due_date")).toHaveLength(0);
    expect((await auditFieldChanges()).filter((c) => "bidDueDate" in c)).toHaveLength(0);
  });

  it("does not RE-stamp on every later sync once the provenance is already correct", async () => {
    await seedDeals("2026-09-01T00:00:00.000Z");
    await ingestBidBoardRows({ office_slug: "test", rows: [exportRow()] });

    const second = await ingestBidBoardRows({ office_slug: "test", rows: [exportRow()] });

    expect(second.metrics.bidDueDateProvenanceStamped).toBe(0);
    expect(second.metrics.bidDueDateSkippedNoChange).toBe(1);
  });

  // ★ P1. A deal detached and later linked to a genuinely NEW Bid Board project keeps its old dates and
  // its old stamp — the link callback clears only bid_board_detached_at. The stamp must stop counting the
  // moment the deal leaves the project it was earned on, or the detached-deal leak returns through the
  // front door where the detach guard cannot see it.
  it("re-stamps for the NEW project after a re-link, so retired provenance never resurrects the override", async () => {
    // Cycle 1: the deal earns provenance on its original project.
    await ingestBidBoardRows({ office_slug: "test", rows: [exportRow()] });
    expect((await dealRow()).bid_due_date_bid_board_project_number).toBe("DFW-1-00001-aa");

    // Detach, then re-link to a DIFFERENT project — the shape the internal-RFP bid-board-created callback
    // leaves behind: detach marker cleared, dates and stamp preserved, new project number.
    await pg.query(
      `UPDATE ${SCHEMA}.deals
          SET bid_board_detached_at = NULL,
              bid_board_project_number = 'DFW-2-99999-zz',
              project_number = 'DFW-2-99999-zz',
              deal_number = 'DFW-2-99999-zz'
        WHERE id = $1`,
      [DEAL]
    );
    const afterRelink = await dealRow();
    // The stamp still names the RETIRED project, which is exactly what makes it void.
    expect(afterRelink.bid_due_date_bid_board_project_number).toBe("DFW-1-00001-aa");
    expect(afterRelink.bid_board_project_number).toBe("DFW-2-99999-zz");

    // The next sync for the NEW project re-earns the stamp legitimately.
    await ingestBidBoardRows({
      office_slug: "test",
      rows: [exportRow({ "Project #": "DFW-2-99999-zz", "Due Date": "2026-10-15" })],
    });

    const after = await dealRow();
    expect(after.bid_due_date_bid_board_project_number).toBe("DFW-2-99999-zz");
    expect(new Date(after.bid_due_date).toISOString()).toBe("2026-10-15T00:00:00.000Z");
  });

  it("does NOT stamp a deal the write-through skipped — a blank Due Date confers no provenance", async () => {
    await seedDeals("2026-06-01T00:00:00.000Z");

    await ingestBidBoardRows({ office_slug: "test", rows: [exportRow({ "Due Date": "" })] });

    expect((await dealRow()).bid_due_date_from_bid_board_at).toBeNull();
  });

  it("records exactly ONE deal_history row with the expected field/source/reason and both days", async () => {
    await seedDeals("2026-06-01T00:00:00.000Z");

    await ingestBidBoardRows({ office_slug: "test", rows: [exportRow()] });

    const history = (await historyRows()).filter((h) => h.field_name === "bid_due_date");
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      field_name: "bid_due_date",
      old_value: "2026-06-01",
      new_value: "2026-09-01",
      changed_by: ADMIN,
      source: "bid_board_sync",
      reason: "Bid Board export sync - Due Date -> Bid Due Date",
    });
  });

  it("mirrors the change onto the audit trail as a bidDueDate field change", async () => {
    await ingestBidBoardRows({ office_slug: "test", rows: [exportRow()] });

    const bidDueDateChange = (await auditFieldChanges()).find((changes) => "bidDueDate" in changes);
    expect(bidDueDateChange?.bidDueDate).toEqual({ from: null, to: "2026-09-01" });
  });

  // BLANK NEVER CLEARS. A Procore field nobody filled in, or one export where the column fails to
  // populate, must not wipe a date reps rely on — and, because the column is the auto-park horizon,
  // wiping it would silently RESTORE value to deals the CRM had parked.
  it("leaves an existing CRM date ALONE when the export's Due Date is blank", async () => {
    await seedDeals("2026-06-01T00:00:00.000Z");

    const result = await ingestBidBoardRows({
      office_slug: "test",
      rows: [exportRow({ "Due Date": "" })],
    });

    const deal = await dealRow();
    expect(new Date(deal.bid_due_date).toISOString()).toBe("2026-06-01T00:00:00.000Z");
    expect(result.metrics.bidDueDateUpdated).toBe(0);
    expect(result.metrics.bidDueDateSkippedNoValue).toBe(1);
    expect((await historyRows()).filter((h) => h.field_name === "bid_due_date")).toHaveLength(0);
  });

  // ★ THE REAL EXPORT FORMAT. Procore ships US "M/D/YYYY" (the pre-existing fixtures in service.test.ts
  // use "4/30/2026" for exactly that reason), and an ISO-only suite cannot catch what goes wrong with it:
  // `new Date("4/30/2026")` is parsed in the SESSION timezone, so the old parser produced 2026-04-30 under
  // TZ=UTC and 2026-04-29 under Europe/Berlin. That was survivable while the value only fed a column
  // nobody read; it is not survivable now that the parsed day is written to deals.bid_due_date, where one
  // wrong day flips an estimating deal's hold verdict and zeroes (or restores) its reported value.
  //
  // Asserted under BOTH timezones, because a test that only runs under UTC is precisely the test that
  // cannot see this bug. TZ is restored in the finally so no later suite inherits it.
  it.each(["UTC", "Europe/Berlin", "America/Chicago", "Pacific/Auckland"])(
    "writes the correct calendar day from a US-format Due Date under TZ=%s",
    async (timeZone) => {
      const originalTz = process.env.TZ;
      process.env.TZ = timeZone;
      try {
        await seedDeals();
        const result = await ingestBidBoardRows({
          office_slug: "test",
          rows: [exportRow({ "Due Date": "4/30/2026" })],
        });

        expect(result.metrics.invalidDueDates).toBe(0);
        expect(result.metrics.bidDueDateUpdated).toBe(1);
        const { rows } = await pg.query<{ day: string }>(
          `SELECT (bid_due_date AT TIME ZONE 'UTC')::date::text AS day FROM ${SCHEMA}.deals WHERE id = '${DEAL}'`
        );
        expect(rows[0].day).toBe("2026-04-30");
      } finally {
        if (originalTz === undefined) delete process.env.TZ;
        else process.env.TZ = originalTz;
      }
    }
  );

  it("rejects an IMPOSSIBLE US-format date instead of rolling it over into a plausible day", async () => {
    // 13/01/2026 and 2/31/2026 would silently become 2027-01-01 and 2026-03-03 through Date.UTC, which is
    // worse than a null: a wrong-but-plausible horizon is invisible.
    await seedDeals("2026-06-01T00:00:00.000Z");

    const result = await ingestBidBoardRows({
      office_slug: "test",
      rows: [exportRow({ "Due Date": "2/31/2026" })],
    });

    expect(new Date((await dealRow()).bid_due_date).toISOString()).toBe("2026-06-01T00:00:00.000Z");
    expect(result.metrics.bidDueDateUpdated).toBe(0);
    expect(result.metrics.invalidDueDates).toBe(1);
  });

  // The guard compares CALENDAR DAYS, not instants. A legacy row stored at 14:30 on the right day needs no
  // correction — and rewriting it would emit a deal_history entry reading "2026-09-01 -> 2026-09-01",
  // because the guard compared instants while the history renders days. That row looks like a bug to
  // whoever audits the first enabled run.
  it("treats a legacy NON-MIDNIGHT instant on the correct day as no change — no 'X -> X' history row", async () => {
    await seedDeals("2026-09-01T14:30:00.000Z");

    const result = await ingestBidBoardRows({ office_slug: "test", rows: [exportRow()] });

    expect(result.metrics.bidDueDateUpdated).toBe(0);
    // Stamped, not skipped: provenance was stale on this first sync. The VALUE not moving is the property
    // under test, and the absent history row is what proves it.
    expect(result.metrics.bidDueDateProvenanceStamped).toBe(1);
    expect(result.metrics.bidDueDateSkippedNoChange).toBe(0);
    const history = (await historyRows()).filter((h) => h.field_name === "bid_due_date");
    expect(history).toHaveLength(0);
    // The instant is left exactly as it was; the day is all any surface reads.
    expect(new Date((await dealRow()).bid_due_date).toISOString()).toBe("2026-09-01T14:30:00.000Z");
  });

  // ★ THE SIGNAL-PRESERVATION TEST. The mirror column is what the read resolver compares the written date
  // against, so if a blank cell on a later export CLEARED it while the written bid_due_date was
  // deliberately preserved, the signal would stop holding: a lead-backed deal's detail page would silently
  // revert to the lead's date while every raw-column surface kept reading the written one. One rule, both
  // columns — a blank export is the absence of information, not an instruction to clear.
  it("a blank export Due Date does NOT clear the MIRROR either, so the landed signal survives", async () => {
    // Cycle 1: a real Due Date lands in both columns.
    await ingestBidBoardRows({ office_slug: "test", rows: [exportRow()] });
    const afterWrite = await mirrorDay();
    expect(afterWrite).toBe("2026-09-01");

    // Cycle 2: the same project, Due Date cell now empty.
    const result = await ingestBidBoardRows({
      office_slug: "test",
      rows: [exportRow({ "Due Date": "" })],
    });

    expect(await mirrorDay()).toBe("2026-09-01");
    expect(new Date((await dealRow()).bid_due_date).toISOString()).toBe("2026-09-01T00:00:00.000Z");
    expect(result.metrics.bidDueDateSkippedNoValue).toBe(1);
    // The two columns still agree, which is the whole point: the read override keeps firing.
    const { rows } = await pg.query<{ landed: boolean }>(
      `SELECT ((bid_due_date AT TIME ZONE 'UTC')::date = bid_board_due_date) AS landed
         FROM ${SCHEMA}.deals WHERE id = '${DEAL}'`
    );
    expect(rows[0].landed).toBe(true);
  });

  it("a blank Due Date does not churn the row or claim a clear in the audit trail", async () => {
    await ingestBidBoardRows({ office_slug: "test", rows: [exportRow()] });
    await pg.exec(`DELETE FROM ${SCHEMA}.audit_log;`);

    await ingestBidBoardRows({ office_slug: "test", rows: [exportRow({ "Due Date": "" })] });

    // The mirror audit must not report `to: null` for a column that was left exactly as it was.
    const cleared = (await auditFieldChanges()).filter((c) => {
      const change = c.bidBoardDueDate as { to?: unknown } | undefined;
      return change != null && change.to == null;
    });
    expect(cleared).toHaveLength(0);
  });

  it("a blank Due Date on a deal that never had one leaves the mirror NULL", async () => {
    // The non-clearing rule must not fabricate a value either — COALESCE(NULL, NULL) is still NULL.
    const result = await ingestBidBoardRows({
      office_slug: "test",
      rows: [exportRow({ "Due Date": "" })],
    });

    expect(await mirrorDay()).toBeNull();
    expect((await dealRow()).bid_due_date).toBeNull();
    expect(result.metrics.bidDueDateSkippedNoValue).toBe(1);
  });

  it("a LATER real Due Date still overwrites the mirror — non-clearing is not write-once", async () => {
    await ingestBidBoardRows({ office_slug: "test", rows: [exportRow()] });
    await ingestBidBoardRows({ office_slug: "test", rows: [exportRow({ "Due Date": "" })] });

    await ingestBidBoardRows({ office_slug: "test", rows: [exportRow({ "Due Date": "2026-10-15" })] });

    expect(await mirrorDay()).toBe("2026-10-15");
    expect(new Date((await dealRow()).bid_due_date).toISOString()).toBe("2026-10-15T00:00:00.000Z");
  });

  // ★ RECONCILIATION. Exactly one outcome fires per matched row, so the five counters sum to `matched`.
  // This is the invariant the double-count broke, and the null-attributor path used to break silently.
  it("reports exactly one outcome per matched row — the counters sum to `matched`", async () => {
    await pg.exec(`DELETE FROM ${SCHEMA}.deals;`);
    await pg.query(
      `INSERT INTO ${SCHEMA}.deals
         (id, name, stage_id, stage_entered_at, workflow_route, deal_number, project_number,
          bid_board_project_number, bid_estimate, is_active, bid_due_date, updated_at)
       VALUES
         ($1, 'Changes',   $4, now(), 'normal', 'P-1', 'P-1', 'P-1', 1, true, '2026-01-01T00:00:00Z', now()),
         ($2, 'Confirmed', $4, now(), 'normal', 'P-2', 'P-2', 'P-2', 1, true, '2026-09-01T00:00:00Z', now()),
         ($3, 'Blank',     $4, now(), 'normal', 'P-3', 'P-3', 'P-3', 1, true, NULL, now())`,
      [U("e0001"), U("e0002"), U("e0003"), ST_ESTIMATING]
    );

    const result = await ingestBidBoardRows({
      office_slug: "test",
      rows: [
        exportRow({ Name: "Changes", "Project #": "P-1" }),
        exportRow({ Name: "Confirmed", "Project #": "P-2" }),
        exportRow({ Name: "Blank", "Project #": "P-3", "Due Date": "" }),
      ],
    });

    const m = result.metrics;
    expect(m.matched).toBe(3);
    expect(m.bidDueDateUpdated).toBe(1); // the date moved
    expect(m.bidDueDateProvenanceStamped).toBe(1); // already right, newly confirmed
    expect(m.bidDueDateSkippedNoValue).toBe(1); // blank export cell
    expect(m.bidDueDateSkippedNoChange).toBe(0);
    expect(m.bidDueDateSkippedNoAttributor).toBe(0);
    expect(
      m.bidDueDateUpdated +
        m.bidDueDateProvenanceStamped +
        m.bidDueDateSkippedNoValue +
        m.bidDueDateSkippedNoChange +
        m.bidDueDateSkippedNoAttributor +
        m.bidDueDateSkippedDuplicateProjectNumber
    ).toBe(m.matched);

    // A second identical sync: nothing left to do, and the no-change counter is where they land.
    const second = await ingestBidBoardRows({
      office_slug: "test",
      rows: [
        exportRow({ Name: "Changes", "Project #": "P-1" }),
        exportRow({ Name: "Confirmed", "Project #": "P-2" }),
        exportRow({ Name: "Blank", "Project #": "P-3", "Due Date": "" }),
      ],
    });
    expect(second.metrics.bidDueDateSkippedNoChange).toBe(2);
    expect(second.metrics.bidDueDateProvenanceStamped).toBe(0);
    expect(
      second.metrics.bidDueDateUpdated +
        second.metrics.bidDueDateProvenanceStamped +
        second.metrics.bidDueDateSkippedNoValue +
        second.metrics.bidDueDateSkippedNoChange +
        second.metrics.bidDueDateSkippedNoAttributor +
        second.metrics.bidDueDateSkippedDuplicateProjectNumber
    ).toBe(second.metrics.matched);
  });

  // ★ AMBIGUOUS SOURCE. Two export rows share a canonical Project # but disagree about the Due Date. The
  // pre-scan already detects the duplicate and warns; before this, BOTH rows still reached the
  // write-through and the second overwrote the first — so the export's ROW ORDER decided which date landed
  // on the deal, and therefore which auto-park horizon its reported value was computed from.
  it("refuses the due-date write when a duplicate Project # carries CONFLICTING Due Dates", async () => {
    await seedDeals("2026-06-01T00:00:00.000Z");

    const result = await ingestBidBoardRows({
      office_slug: "test",
      rows: [
        exportRow({ "Due Date": "2026-09-01" }),
        exportRow({ "Due Date": "2026-10-15" }),
      ],
    });

    // Neither date wins — the CRM value is left exactly as it was.
    expect(new Date((await dealRow()).bid_due_date).toISOString()).toBe("2026-06-01T00:00:00.000Z");
    expect(result.metrics.bidDueDateUpdated).toBe(0);
    expect(result.metrics.bidDueDateSkippedDuplicateProjectNumber).toBe(2);
    expect((await historyRows()).filter((h) => h.field_name === "bid_due_date")).toHaveLength(0);
    // …and the operator is told which project to fix on the board, not just that a duplicate exists.
    expect(result.warnings.join(" ")).toContain("appears more than once in this export with different Due Dates");
  });

  it("still writes when duplicate rows AGREE on the Due Date — a repeat is not a conflict", async () => {
    // Procore appends "(N)" to duplicated project names, so repeats are normal. Only DISAGREEMENT is
    // ambiguous; refusing every repeat would strand deals whose board rows simply appear twice.
    await seedDeals("2026-06-01T00:00:00.000Z");

    const result = await ingestBidBoardRows({
      office_slug: "test",
      rows: [exportRow(), exportRow()],
    });

    expect(new Date((await dealRow()).bid_due_date).toISOString()).toBe("2026-09-01T00:00:00.000Z");
    expect(result.metrics.bidDueDateUpdated).toBe(1);
    expect(result.metrics.bidDueDateSkippedDuplicateProjectNumber).toBe(0);
  });

  it("treats a blank duplicate as no opinion, not as a conflict", async () => {
    // A blank cell never clears, so "one row dated, one row blank" has exactly one opinion in it.
    await seedDeals("2026-06-01T00:00:00.000Z");

    const result = await ingestBidBoardRows({
      office_slug: "test",
      rows: [exportRow(), exportRow({ "Due Date": "" })],
    });

    expect(new Date((await dealRow()).bid_due_date).toISOString()).toBe("2026-09-01T00:00:00.000Z");
    expect(result.metrics.bidDueDateSkippedDuplicateProjectNumber).toBe(0);
  });

  // The skip is scoped to the DUE DATE only. A `continue` here would also have skipped the stage
  // writeback, quietly widening an ambiguous date into an ambiguous stage.
  it("still applies the STAGE writeback for a conflicting-duplicate row", async () => {
    await seedDeals("2026-06-01T00:00:00.000Z");

    const result = await ingestBidBoardRows({
      office_slug: "test",
      rows: [
        exportRow({ Status: "Won", "Due Date": "2026-09-01" }),
        exportRow({ Status: "Won", "Due Date": "2026-10-15" }),
      ],
    });

    expect((await dealRow()).stage_id).toBe(ST_WON);
    expect(result.metrics.stageUpdated).toBe(1);
    expect(result.metrics.bidDueDateSkippedDuplicateProjectNumber).toBe(2);
  });

  it("counts the null-attributor refusal under its own metric, keeping the sum intact", async () => {
    await pg.exec(`UPDATE public.users SET is_active = false WHERE id = '${ADMIN}'`);
    try {
      const result = await ingestBidBoardRows({ office_slug: "test", rows: [exportRow()] });

      expect(result.metrics.matched).toBe(1);
      expect(result.metrics.bidDueDateSkippedNoAttributor).toBe(1);
      expect(result.metrics.bidDueDateUpdated).toBe(0);
      expect(result.metrics.bidDueDateProvenanceStamped).toBe(0);
      expect(result.metrics.bidDueDateSkippedNoChange).toBe(0);
    } finally {
      await pg.exec(`UPDATE public.users SET is_active = true WHERE id = '${ADMIN}'`);
    }
  });

  // ★ THE WARNING MUST DESCRIBE THE WRITE THAT HAPPENED. With the read-back on, an unusable Due Date is
  // not stored at all — the mirror goes through COALESCE and keeps its previous value — so "was stored as
  // NULL" would describe a write that never occurred, on the exact message an operator reads to decide
  // whether the sync did something surprising.
  it("says the value was IGNORED, not 'stored as NULL', when the mirror is preserved", async () => {
    const result = await ingestBidBoardRows({
      office_slug: "test",
      rows: [exportRow({ "Due Date": "TBD" })],
    });

    const warning = result.warnings.find((w) => w.includes("could not be parsed"));
    expect(warning).toContain("was ignored");
    expect(warning).toContain("previously synced Bid Board due date is left unchanged");
    expect(warning).not.toContain("stored as NULL");
  });

  it("also leaves it alone when the Due Date is present but UNPARSEABLE (the parser's null)", async () => {
    await seedDeals("2026-06-01T00:00:00.000Z");

    const result = await ingestBidBoardRows({
      office_slug: "test",
      rows: [exportRow({ "Due Date": "TBD" })],
    });

    expect(new Date((await dealRow()).bid_due_date).toISOString()).toBe("2026-06-01T00:00:00.000Z");
    expect(result.metrics.bidDueDateUpdated).toBe(0);
    expect(result.metrics.bidDueDateSkippedNoValue).toBe(1);
    expect(result.metrics.invalidDueDates).toBe(1);
  });

  // The IS DISTINCT FROM guard. This job runs on a schedule; without it every cycle would append an
  // identical history row and an identical audit entry to every matched deal, forever.
  //
  // NOTE on what is deliberately NOT asserted: `updated_at`. The ingest's stage-metadata refresh
  // (updateBidBoardStageMetadata) stamps updated_at on EVERY matched row every cycle, independently of
  // this feature, so a "no updated_at churn" assertion here would be pinning someone else's behaviour and
  // would pass or fail for reasons that have nothing to do with the bid due date. The guard's observable
  // effect is the absence of a history row, an audit field change and a counter increment.
  it("writes NOTHING when the value is unchanged — no history row, no audit entry", async () => {
    await seedDeals("2026-09-01T00:00:00.000Z");

    const result = await ingestBidBoardRows({ office_slug: "test", rows: [exportRow()] });

    expect(new Date((await dealRow()).bid_due_date).toISOString()).toBe("2026-09-01T00:00:00.000Z");
    expect((await historyRows()).filter((h) => h.field_name === "bid_due_date")).toHaveLength(0);
    expect((await auditFieldChanges()).filter((c) => "bidDueDate" in c)).toHaveLength(0);
    expect(result.metrics.bidDueDateUpdated).toBe(0);
    // On a FIRST sync this row still gets a stamp-only pass (its provenance is stale), so it is counted as
    // stamped rather than skipped — the value is what did not change, and that is what this test is about.
    expect(result.metrics.bidDueDateProvenanceStamped).toBe(1);
    expect(result.metrics.bidDueDateSkippedNoChange).toBe(0);
  });

  it("is idempotent across two consecutive syncs of the same export", async () => {
    await ingestBidBoardRows({ office_slug: "test", rows: [exportRow()] });
    const second = await ingestBidBoardRows({ office_slug: "test", rows: [exportRow()] });

    expect(second.metrics.bidDueDateUpdated).toBe(0);
    expect(second.metrics.bidDueDateSkippedNoChange).toBe(1);
    expect((await historyRows()).filter((h) => h.field_name === "bid_due_date")).toHaveLength(1);
  });

  // A deal moved back to Opportunity (migration 0200) is severed from Bid Board sync. The matcher already
  // refuses it, and the write-through repeats the predicate at its own write site.
  it("never touches a DETACHED deal", async () => {
    const result = await ingestBidBoardRows({
      office_slug: "test",
      rows: [exportRow({ Name: "Detached Tower", "Project #": "DFW-2-00002-bb" })],
    });

    const detached = await dealRow(DETACHED);
    expect(detached.bid_due_date).toBeNull();
    expect(await historyRows(DETACHED)).toHaveLength(0);
    expect(result.metrics.skippedDetached).toBe(1);
    expect(result.metrics.bidDueDateUpdated).toBe(0);
  });

  // Unlike the estimate and stage writebacks, this one is NOT terminal-skipped: correcting a historical
  // deal's bid date has no financial or attribution consequence (terminal deals are exempt from the
  // far-out auto-park leg server-side), and skipping them would leave permanent drift against the board.
  it("applies to a TERMINAL deal too", async () => {
    await pg.query(`UPDATE ${SCHEMA}.deals SET stage_id = $1 WHERE id = $2`, [ST_WON, DEAL]);

    const result = await ingestBidBoardRows({
      office_slug: "test",
      rows: [exportRow({ Status: "Won" })],
    });

    expect(new Date((await dealRow()).bid_due_date).toISOString()).toBe("2026-09-01T00:00:00.000Z");
    expect(result.metrics.bidDueDateUpdated).toBe(1);
  });

  it("persists bid_due_date_updated_count on the run row", async () => {
    await ingestBidBoardRows({ office_slug: "test", rows: [exportRow()] });

    const run = await latestRun();
    expect(run.bid_due_date_updated_count).toBe(1);
    // The run row's other counters are untouched by the new column being appended to the UPDATE.
    expect(run.status).toBe("success");
    expect(run.matched_count).toBe(1);
  });

  it("skips the write (with a warning) when no admin/director exists to attribute the history row to", async () => {
    // Same posture as the estimate writeback: a value change that moves money must be attributable, so an
    // unattributable one is refused rather than recorded anonymously.
    await pg.exec(`UPDATE public.users SET is_active = false WHERE id = '${ADMIN}'`);
    try {
      const result = await ingestBidBoardRows({ office_slug: "test", rows: [exportRow()] });

      expect((await dealRow()).bid_due_date).toBeNull();
      expect(result.metrics.bidDueDateUpdated).toBe(0);
      expect(result.warnings.join(" ")).toContain("no active admin/director user available");
    } finally {
      await pg.exec(`UPDATE public.users SET is_active = true WHERE id = '${ADMIN}'`);
    }
  });
});

// ★ THE TEST THAT PROTECTS PROD. deals.bid_board_due_date is already populated on every matched deal, so
// the ONLY thing keeping this PR inert on deploy is the flag.
describe("Bid Board Due Date read-back (flag OFF)", () => {
  beforeEach(() => {
    delete process.env.BID_BOARD_DUE_DATE_READBACK;
  });

  it("writes NOTHING: bid_due_date untouched, no history row, no audit entry, counters all 0", async () => {
    // The mirror says 2026-09-01 and the CRM says 2026-06-01 — precisely the shape that WOULD be written
    // with the flag on, so this is not vacuously passing.
    await seedDeals("2026-06-01T00:00:00.000Z");

    const result = await ingestBidBoardRows({ office_slug: "test", rows: [exportRow()] });

    const after = await dealRow();
    expect(new Date(after.bid_due_date).toISOString()).toBe("2026-06-01T00:00:00.000Z");
    expect((await historyRows()).filter((h) => h.field_name === "bid_due_date")).toHaveLength(0);
    expect((await auditFieldChanges()).filter((c) => "bidDueDate" in c)).toHaveLength(0);
    expect(result.metrics.bidDueDateUpdated).toBe(0);
    expect(result.metrics.bidDueDateSkippedNoValue).toBe(0);
    expect(result.metrics.bidDueDateSkippedNoChange).toBe(0);
    expect((await latestRun()).bid_due_date_updated_count).toBe(0);
  });

  // ★ MIRROR PARITY. The non-clearing COALESCE is itself flag-gated, because it is externally visible even
  // with the read-back off: the flag-off RFP payload still passes `bid_board_due_date` to SyncHub as its
  // dueDate fallback, so preserving a stale date here would send one onward to Procore where main sent
  // null. Flag off must clear exactly as main does.
  it("a blank export Due Date CLEARS the mirror, exactly as main does", async () => {
    process.env.BID_BOARD_DUE_DATE_READBACK = "true";
    await ingestBidBoardRows({ office_slug: "test", rows: [exportRow()] });
    expect(await mirrorDay()).toBe("2026-09-01");
    delete process.env.BID_BOARD_DUE_DATE_READBACK;

    await ingestBidBoardRows({ office_slug: "test", rows: [exportRow({ "Due Date": "" })] });

    expect(await mirrorDay()).toBeNull();
    // …and the written bid_due_date is still preserved — that half was never conditional.
    expect(new Date((await dealRow()).bid_due_date).toISOString()).toBe("2026-09-01T00:00:00.000Z");
  });

  it("still mirrors bid_board_due_date and still writes the estimate — the flag gates ONLY the read-back", async () => {
    // Proof the gate is surgical rather than an off-switch for the whole row loop: the mirror column and
    // the estimate writeback are unaffected, which is also what makes bid_board_due_date already-populated
    // on prod and therefore what makes the flag necessary.
    await seedDeals();
    await pg.query(`UPDATE ${SCHEMA}.deals SET bid_estimate = 1 WHERE id = $1`, [DEAL]);

    const result = await ingestBidBoardRows({ office_slug: "test", rows: [exportRow()] });

    const deal = await dealRow();
    expect(Number(deal.bid_estimate)).toBe(250000);
    expect(deal.bid_due_date).toBeNull();
    expect(result.metrics.estimateUpdated).toBe(1);
    // Read the DATE column through a SQL ::text cast, not String(Date): node-pg/PGlite hand back a JS Date
    // whose default string form ("Mon Aug 31 2026 …") is rendered in the LOCAL zone and would read a day
    // early west of UTC — the exact off-by-one this feature is careful about.
    const { rows } = await pg.query<{ mirror: string }>(
      `SELECT bid_board_due_date::text AS mirror FROM ${SCHEMA}.deals WHERE id = '${DEAL}'`
    );
    expect(rows[0].mirror).toBe("2026-09-01");
  });
});
