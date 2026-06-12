import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { writeStageIfSafe } from "../../../src/modules/bid-board-sync/service.js";

/**
 * Runtime (PGlite) proof that the Bid Board sync AUTHORITATIVELY MIRRORS the Bid Board onto
 * bid-board-owned deals: it self-corrects a deal trapped in a terminal stage and keeps
 * won_closed_date (the migration-0141 Won-period reporting basis) in lockstep with Won status —
 * matching changeDealStage's resolveWonClosedDateWriteThrough convention exactly.
 */

type WriteArgs = Parameters<typeof writeStageIfSafe>;
type DealArg = WriteArgs[2];
type StageArg = WriteArgs[3];
type RowArg = WriteArgs[4];

const U = (s: string) => `00000000-0000-4000-8000-${s.padStart(12, "0")}`;
const USER = U("5e7");
const SCHEMA = "office_test";

const ST_ESTIMATING = U("57e1");
const ST_CONTRACT = U("57e2");
const ST_CLOSED_WON = U("57e3");
const ST_WON = U("57e4");
const ST_LOST = U("57e5");

let pg: PGlite;
let client: { query: (text: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number }> };

beforeAll(async () => {
  pg = new PGlite();
  // node-pg exposes rowCount; PGlite exposes affectedRows. The production code reads rowCount, so
  // present a node-pg-compatible shape here (this is a harness adapter, not a code change).
  client = {
    query: async (text, params) => {
      const r: any = await pg.query(text, params);
      return { ...r, rowCount: r.affectedRows ?? r.rowCount ?? r.rows?.length ?? 0 };
    },
  };
  await pg.exec(`
    CREATE TABLE public.pipeline_stage_config (
      id uuid PRIMARY KEY, slug text UNIQUE NOT NULL, name text NOT NULL,
      display_order int, is_terminal boolean NOT NULL DEFAULT false,
      is_active_pipeline boolean NOT NULL DEFAULT true
    );
    CREATE TABLE public.users (
      id uuid PRIMARY KEY, display_name text NOT NULL, is_active boolean NOT NULL DEFAULT true,
      role text, office_id uuid
    );
    CREATE SCHEMA office_test;
    CREATE TABLE office_test.deals (
      id uuid PRIMARY KEY, name text, deal_number text, project_number text,
      stage_id uuid NOT NULL, stage_entered_at timestamptz,
      on_hold boolean NOT NULL DEFAULT false, on_hold_started_at timestamptz,
      on_hold_accumulated_seconds bigint NOT NULL DEFAULT 0,
      on_hold_accumulated_seconds_at_stage_entry bigint NOT NULL DEFAULT 0,
      is_bid_board_owned boolean NOT NULL DEFAULT false, bid_board_status text,
      bid_board_stage_slug text, bid_board_stage_family text, bid_board_stage_status text,
      bid_board_stage_entered_at timestamptz, read_only_synced_at timestamptz,
      actual_close_date date, lost_at timestamptz, bid_board_loss_outcome text,
      lost_reason_id uuid, lost_notes text, lost_competitor text,
      won_closed_date date, contract_signed_date date, contract_signed_at timestamptz,
      awarded_amount numeric, bid_estimate numeric,
      updated_at timestamptz DEFAULT now()
    );
    CREATE TABLE office_test.deal_stage_history (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      deal_id uuid NOT NULL, from_stage_id uuid, to_stage_id uuid NOT NULL, changed_by uuid NOT NULL,
      is_backward_move boolean NOT NULL DEFAULT false, is_director_override boolean NOT NULL DEFAULT false,
      override_reason text, duration_in_previous_stage interval, created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE office_test.audit_log (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      table_name text, record_id text, action text, changed_by uuid,
      actor_name text, actor_role text, actor_system_process text,
      entity_type text, entity_name_snapshot text, entity_secondary_id_snapshot text,
      impersonator_id uuid, changes jsonb, field_changes_jsonb jsonb, full_row jsonb,
      visibility_scope text, ip_address inet, user_agent text, created_at timestamptz DEFAULT now()
    );
    INSERT INTO public.users (id, display_name, role) VALUES ('${USER}', 'Sync Admin', 'admin');
    INSERT INTO public.pipeline_stage_config (id, slug, name, display_order, is_terminal) VALUES
      ('${ST_ESTIMATING}','estimating','Estimating',2,false),
      ('${ST_CONTRACT}','contract','Contract',6,false),
      ('${ST_CLOSED_WON}','closed_won','Closed Won',6,true),
      ('${ST_WON}','won','Won',7,true),
      ('${ST_LOST}','lost','Lost',7,true);
  `);
});

afterAll(async () => {
  await pg?.close?.();
});

function buildDeal(overrides: Partial<DealArg>): DealArg {
  const pn = `DFW-1-${String(overrides.id ?? "").slice(-4)}-aa`;
  return {
    id: U("d00"), name: "Test Deal", stage_id: ST_WON, stage_slug: "won",
    stage_display_order: 7, stage_is_terminal: true, stage_entered_at: "2026-05-01T12:00:00Z",
    on_hold: false, on_hold_started_at: null, on_hold_accumulated_seconds: 0,
    on_hold_accumulated_seconds_at_stage_entry: 0, workflow_route: "normal",
    deal_number: pn, project_number: pn, bid_board_project_number: pn,
    bid_board_estimator: null, estimator_user_id: null, bid_board_office: null,
    bid_board_status: null, bid_board_sales_price_per_area: null, bid_board_project_cost: null,
    bid_board_profit_margin_pct: null, bid_board_total_sales: null, bid_board_created_at: null,
    bid_board_due_date: null, bid_board_customer_name: null, bid_board_customer_contact_raw: null,
    bid_board_stage_slug: null, bid_board_stage_family: null, bid_board_stage_status: null,
    bid_board_last_updated_at: null, bid_estimate: null, awarded_amount: null,
    won_closed_date: null, contract_signed_date: null, contract_signed_at: null,
    ...overrides,
  } as DealArg;
}

async function seedDeal(opts: {
  id: string; stageId: string; stageSlug: string; stageOrder: number; stageTerminal: boolean;
  wonClosedDate?: string | null; contractSignedDate?: string | null; contractSignedAt?: string | null;
  stageEnteredAt?: string; bidBoardStatus: string; actualCloseDate?: string | null;
  awardedAmount?: string | null; bidEstimate?: string | null;
}): Promise<DealArg> {
  const stageEnteredAt = opts.stageEnteredAt ?? "2026-05-01T12:00:00Z";
  const pn = `DFW-1-${opts.id.slice(-4)}-aa`;
  await client.query(
    `INSERT INTO office_test.deals
       (id, name, deal_number, project_number, stage_id, stage_entered_at, is_bid_board_owned,
        bid_board_status, won_closed_date, contract_signed_date, contract_signed_at, actual_close_date,
        awarded_amount, bid_estimate)
     VALUES ($1,$2,$3,$3,$4,$5::timestamptz,true,$6,$7::date,$8::date,$9::timestamptz,$10::date,
             $11::numeric,$12::numeric)`,
    [opts.id, `Deal ${opts.id.slice(-4)}`, pn, opts.stageId, stageEnteredAt, opts.bidBoardStatus,
      opts.wonClosedDate ?? null, opts.contractSignedDate ?? null, opts.contractSignedAt ?? null,
      opts.actualCloseDate ?? null, opts.awardedAmount ?? null, opts.bidEstimate ?? null]
  );
  return buildDeal({
    id: opts.id, stage_id: opts.stageId, stage_slug: opts.stageSlug,
    stage_display_order: opts.stageOrder, stage_is_terminal: opts.stageTerminal,
    stage_entered_at: stageEnteredAt, won_closed_date: opts.wonClosedDate ?? null,
    contract_signed_date: opts.contractSignedDate ?? null, contract_signed_at: opts.contractSignedAt ?? null,
    bid_board_status: opts.bidBoardStatus,
    awarded_amount: opts.awardedAmount ?? null, bid_estimate: opts.bidEstimate ?? null,
  });
}

const stage = (id: string, slug: string, order: number, terminal: boolean): StageArg =>
  ({ id, slug, display_order: order, is_terminal: terminal } as StageArg);

const row = (bidBoardStatus: string): RowArg =>
  ({
    name: "Test Deal", bidBoardProjectId: null, bidBoardEstimator: null, bidBoardOffice: null,
    bidBoardStatus, bidBoardSalesPricePerArea: null, bidBoardProjectCost: null,
    bidBoardProfitMarginPct: null, bidBoardTotalSales: null, bidBoardCreatedAt: null,
    bidBoardDueDate: null, bidBoardCustomerName: null, bidBoardCustomerContactRaw: null,
    bidBoardProjectNumber: "DFW-1-0000-aa",
  } as RowArg);

async function dealRow(id: string) {
  const { rows } = await client.query(
    `SELECT stage_id, won_closed_date::text AS won_closed_date, actual_close_date::text AS actual_close_date,
            lost_at, awarded_amount::text AS awarded_amount FROM office_test.deals WHERE id = $1`,
    [id]
  );
  return rows[0];
}

describe("Bid Board sync — authoritative stage + won_closed_date mirror (runtime)", () => {
  it("self-corrects a trapped terminal Won deal to Contract and CLEARS won_closed_date + records history", async () => {
    const id = U("d01");
    const deal = await seedDeal({
      id, stageId: ST_WON, stageSlug: "won", stageOrder: 7, stageTerminal: true,
      wonClosedDate: "2026-05-01", actualCloseDate: "2026-05-01", bidBoardStatus: "Contract",
    });

    const result = await writeStageIfSafe(client as any, SCHEMA, deal, stage(ST_CONTRACT, "contract", 6, false), row("Contract"), USER);

    expect(result.updated).toBe(true);
    const d = await dealRow(id);
    expect(d.stage_id).toBe(ST_CONTRACT);
    expect(d.won_closed_date).toBeNull();
    expect(d.actual_close_date).toBeNull();

    const hist = await client.query(
      `SELECT to_stage_id, is_backward_move FROM office_test.deal_stage_history WHERE deal_id = $1`,
      [id]
    );
    expect(hist.rows).toHaveLength(1);
    expect(hist.rows[0].to_stage_id).toBe(ST_CONTRACT);
    expect(hist.rows[0].is_backward_move).toBe(true);
  });

  it("stamps won_closed_date = today when a non-Won deal becomes Won", async () => {
    const id = U("d02");
    const deal = await seedDeal({
      id, stageId: ST_ESTIMATING, stageSlug: "estimating", stageOrder: 2, stageTerminal: false,
      bidBoardStatus: "Won",
    });

    const before = new Date().toISOString().slice(0, 10);
    await writeStageIfSafe(client as any, SCHEMA, deal, stage(ST_WON, "won", 7, true), row("Won"), USER);
    const after = new Date().toISOString().slice(0, 10);

    const d = await dealRow(id);
    expect(d.stage_id).toBe(ST_WON);
    // "today" is computed in TS at write time; accept either side of a midnight-UTC boundary.
    expect([before, after]).toContain(d.won_closed_date);
  });

  it("PRESERVES the existing won_closed_date when moving BETWEEN Won stages (never fabricates today)", async () => {
    const id = U("d03");
    const deal = await seedDeal({
      id, stageId: ST_CLOSED_WON, stageSlug: "closed_won", stageOrder: 6, stageTerminal: true,
      wonClosedDate: "2026-04-01", bidBoardStatus: "Won",
    });

    await writeStageIfSafe(client as any, SCHEMA, deal, stage(ST_WON, "won", 7, true), row("Won"), USER);

    const d = await dealRow(id);
    expect(d.stage_id).toBe(ST_WON);
    expect(d.won_closed_date).toBe("2026-04-01");
  });

  it("a present contract_signed_date overrides the stage-driven won date on a fresh Win", async () => {
    const id = U("d05");
    const deal = await seedDeal({
      id, stageId: ST_ESTIMATING, stageSlug: "estimating", stageOrder: 2, stageTerminal: false,
      contractSignedDate: "2026-03-15", bidBoardStatus: "Won",
    });

    await writeStageIfSafe(client as any, SCHEMA, deal, stage(ST_WON, "won", 7, true), row("Won"), USER);

    const d = await dealRow(id);
    expect(d.stage_id).toBe(ST_WON);
    expect(d.won_closed_date).toBe("2026-03-15");
  });

  it("uses contract_signed_at (timestamptz) as the won date when contract_signed_date is absent", async () => {
    const id = U("d07");
    const deal = await seedDeal({
      id, stageId: ST_ESTIMATING, stageSlug: "estimating", stageOrder: 2, stageTerminal: false,
      contractSignedAt: "2026-03-10T18:00:00Z", bidBoardStatus: "Won",
    });

    await writeStageIfSafe(client as any, SCHEMA, deal, stage(ST_WON, "won", 7, true), row("Won"), USER);

    const d = await dealRow(id);
    expect(d.stage_id).toBe(ST_WON);
    expect(d.won_closed_date).toBe("2026-03-10");
  });

  it("does NOT fill won_closed_date on a same-stage no-op (an already-Won NULL-date deal relies on the backfill)", async () => {
    const id = U("d06");
    const deal = await seedDeal({
      id, stageId: ST_WON, stageSlug: "won", stageOrder: 7, stageTerminal: true,
      wonClosedDate: null, bidBoardStatus: "Won",
    });

    // Bid Board still says Won and the deal is already at Won → no stage transition, so the forward
    // path does NOT stamp won_closed_date. Documents the exact gap the backfill exists to close.
    const result = await writeStageIfSafe(client as any, SCHEMA, deal, stage(ST_WON, "won", 7, true), row("Won"), USER);

    expect(result.skippedNoStageChange).toBe(true);
    expect(result.appliedTerminalExit).toBe(false);
    const d = await dealRow(id);
    expect(d.stage_id).toBe(ST_WON);
    expect(d.won_closed_date).toBeNull();
  });

  it("CLEARS won_closed_date and sets lost_at when a Won deal is mirrored to Lost", async () => {
    const id = U("d04");
    const deal = await seedDeal({
      id, stageId: ST_WON, stageSlug: "won", stageOrder: 7, stageTerminal: true,
      wonClosedDate: "2026-05-01", bidBoardStatus: "Lost",
    });

    await writeStageIfSafe(client as any, SCHEMA, deal, stage(ST_LOST, "lost", 7, true), row("Lost"), USER);

    const d = await dealRow(id);
    expect(d.stage_id).toBe(ST_LOST);
    expect(d.won_closed_date).toBeNull();
    expect(d.lost_at).not.toBeNull();
  });

  it("clears stale loss details (reason/notes/competitor) when a Lost deal is reopened to a non-Lost stage", async () => {
    const id = U("d08");
    const deal = await seedDeal({
      id, stageId: ST_LOST, stageSlug: "lost", stageOrder: 7, stageTerminal: true,
      bidBoardStatus: "Contract",
    });
    await client.query(
      `UPDATE office_test.deals
          SET lost_at = NOW(), lost_reason_id = $2, lost_notes = 'lost to X', lost_competitor = 'X'
        WHERE id = $1`,
      [id, U("105")]
    );

    await writeStageIfSafe(client as any, SCHEMA, deal, stage(ST_CONTRACT, "contract", 6, false), row("Contract"), USER);

    const { rows } = await client.query(
      `SELECT stage_id, lost_at, lost_reason_id, lost_notes, lost_competitor
         FROM office_test.deals WHERE id = $1`,
      [id]
    );
    expect(rows[0].stage_id).toBe(ST_CONTRACT);
    expect(rows[0].lost_at).toBeNull();
    expect(rows[0].lost_reason_id).toBeNull();
    expect(rows[0].lost_notes).toBeNull();
    expect(rows[0].lost_competitor).toBeNull();
  });
});

describe("Bid Board sync — awarded_amount seed on Won (runtime, only-if-empty)", () => {
  it("seeds awarded_amount from bid_estimate when a deal becomes Won with a NULL awarded_amount", async () => {
    const id = U("a01");
    const deal = await seedDeal({
      id, stageId: ST_ESTIMATING, stageSlug: "estimating", stageOrder: 2, stageTerminal: false,
      bidBoardStatus: "Won", awardedAmount: null, bidEstimate: "12345.67",
    });

    await writeStageIfSafe(client as any, SCHEMA, deal, stage(ST_WON, "won", 7, true), row("Won"), USER);

    const d = await dealRow(id);
    expect(d.stage_id).toBe(ST_WON);
    expect(Number(d.awarded_amount)).toBe(12345.67);
  });

  it("seeds from the LIVE bid_estimate when the same sync set the estimate then wins (in-memory deal is stale-NULL)", async () => {
    const id = U("a06");
    const deal = await seedDeal({
      id, stageId: ST_ESTIMATING, stageSlug: "estimating", stageOrder: 2, stageTerminal: false,
      bidBoardStatus: "Won", awardedAmount: null, bidEstimate: "8200.00",
    });
    // Reproduce the real ingest cycle: writeEstimateIfNeeded already wrote bid_estimate to the DB
    // row this cycle, but matches[0] was loaded BEFORE that write and still carries the stale NULL.
    // The seed must read the live DB column, not this stale in-memory value.
    deal.bid_estimate = null;

    await writeStageIfSafe(client as any, SCHEMA, deal, stage(ST_WON, "won", 7, true), row("Won"), USER);

    const d = await dealRow(id);
    expect(d.stage_id).toBe(ST_WON);
    expect(Number(d.awarded_amount)).toBe(8200);
  });

  it("NEVER overwrites a present awarded_amount on a Won transition (COALESCE no-op, even if bid differs)", async () => {
    const id = U("a02");
    const deal = await seedDeal({
      id, stageId: ST_ESTIMATING, stageSlug: "estimating", stageOrder: 2, stageTerminal: false,
      bidBoardStatus: "Won", awardedAmount: "99999", bidEstimate: "12345.67",
    });

    await writeStageIfSafe(client as any, SCHEMA, deal, stage(ST_WON, "won", 7, true), row("Won"), USER);

    const d = await dealRow(id);
    expect(d.stage_id).toBe(ST_WON);
    expect(Number(d.awarded_amount)).toBe(99999);
  });

  it("leaves awarded_amount NULL on a Won transition when bid_estimate is NULL", async () => {
    const id = U("a03");
    const deal = await seedDeal({
      id, stageId: ST_ESTIMATING, stageSlug: "estimating", stageOrder: 2, stageTerminal: false,
      bidBoardStatus: "Won", awardedAmount: null, bidEstimate: null,
    });

    await writeStageIfSafe(client as any, SCHEMA, deal, stage(ST_WON, "won", 7, true), row("Won"), USER);

    const d = await dealRow(id);
    expect(d.stage_id).toBe(ST_WON);
    expect(d.awarded_amount).toBeNull();
  });

  it("leaves awarded_amount NULL on a Won transition when bid_estimate is 0 (mirrors the <= 0 skip)", async () => {
    const id = U("a04");
    const deal = await seedDeal({
      id, stageId: ST_ESTIMATING, stageSlug: "estimating", stageOrder: 2, stageTerminal: false,
      bidBoardStatus: "Won", awardedAmount: null, bidEstimate: "0",
    });

    await writeStageIfSafe(client as any, SCHEMA, deal, stage(ST_WON, "won", 7, true), row("Won"), USER);

    const d = await dealRow(id);
    expect(d.stage_id).toBe(ST_WON);
    expect(d.awarded_amount).toBeNull();
  });

  it("does NOT seed awarded_amount on a NON-Won stage write even with a positive bid_estimate", async () => {
    const id = U("a05");
    const deal = await seedDeal({
      id, stageId: ST_WON, stageSlug: "won", stageOrder: 7, stageTerminal: true,
      wonClosedDate: "2026-05-01", actualCloseDate: "2026-05-01",
      bidBoardStatus: "Contract", awardedAmount: null, bidEstimate: "12345.67",
    });

    await writeStageIfSafe(client as any, SCHEMA, deal, stage(ST_CONTRACT, "contract", 6, false), row("Contract"), USER);

    const d = await dealRow(id);
    expect(d.stage_id).toBe(ST_CONTRACT);
    expect(d.awarded_amount).toBeNull();
  });
});
