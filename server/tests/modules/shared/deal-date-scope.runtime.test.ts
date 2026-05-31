import { PGlite } from "@electric-sql/pglite";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildDealOutcomeDateScope, dealDisplayDateExpr } from "../../../src/modules/shared/deal-date-scope.js";

/**
 * RUNTIME coverage for the canonical outcome-aware date model, executed against a
 * real in-memory Postgres (PGlite) — not rendered-SQL mocks. Proves the semantics
 * the model exists to fix, the edge that DEFINES the platform-wide bug:
 *
 *   A deal whose CREATED date is in-window but whose WON date is OUT-of-window
 *   must NOT match (created date is irrelevant; the won date governs), and the
 *   converse matches. Lost rows window on lost_at; open rows are current-state
 *   pre-flag and stage-entry-bounded post-flag.
 *
 * The Won axis is the CANONICAL basis (canonicalWonCloseDateSql):
 *   COALESCE(NULLIF(hubspot_extra_properties->>'hs_closed_won_date','')::date,
 *            contract_signed_at::date, contract_signed_date)
 * — the same expression the getDeals Won drill-down / getWonCloseSummary use (the
 * protected 191 / $9,778,045.90 basis); the hs_closed_won_date PRIMARY is what
 * makes it canonical. We seed both the jsonb primary and the contract_signed
 * fallback so the COALESCE/NULLIF/::date casts run for real (the runtime-only bug
 * class mocks miss, #538).
 */

const dialect = new PgDialect();
const WINDOW = { from: "2026-02-01", to: "2026-02-28" }; // February 2026
const CTX = { wonStageIds: ["won"], lostStageIds: ["lost"] };

let db: PGlite;

async function matchedIds(
  ctx: { wonStageIds: string[]; lostStageIds: string[]; stageEntryDateEnabled?: boolean }
): Promise<string[]> {
  const predicate = buildDealOutcomeDateScope(WINDOW, ctx);
  if (!predicate) throw new Error("expected a predicate for a non-empty window");
  const { sql, params } = dialect.sqlToQuery(predicate);
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM deals WHERE ${sql} ORDER BY id`,
    params as unknown[]
  );
  return rows.map((r) => r.id);
}

beforeAll(async () => {
  db = new PGlite();
  // Unqualified `deals` in the default (public) schema — the predicate's default
  // column source renders "deals"."stage_id" etc.
  await db.exec(`
    CREATE TABLE deals (
      id text PRIMARY KEY,
      stage_id text NOT NULL,
      hubspot_extra_properties jsonb,
      contract_signed_at timestamptz,
      contract_signed_date date,
      lost_at timestamptz,
      stage_entered_at timestamptz,
      created_at timestamptz
    );
    INSERT INTO deals (id, stage_id, hubspot_extra_properties, contract_signed_at, contract_signed_date, lost_at, stage_entered_at, created_at) VALUES
      -- WON via hs_closed_won_date (jsonb primary), IN window, created OUT -> MATCH
      ('won_hs_in',       'won',  '{"hs_closed_won_date":"2026-02-15"}'::jsonb, NULL, NULL, NULL, NULL, '2025-01-01T00:00:00Z'),
      -- WON via hs_closed_won_date OUT window, created IN -> NO MATCH (THE bug edge)
      ('won_hs_out',      'won',  '{"hs_closed_won_date":"2026-05-15"}'::jsonb, NULL, NULL, NULL, NULL, '2026-02-10T00:00:00Z'),
      -- WON via contract_signed fallback (jsonb empty), IN window -> MATCH (COALESCE/NULLIF path)
      ('won_fallback_in', 'won',  '{}'::jsonb, NULL, '2026-02-20', NULL, NULL, '2020-01-01T00:00:00Z'),
      -- LOST, lost_at IN window -> MATCH
      ('lost_in',         'lost', NULL, NULL, NULL, '2026-02-10T12:00:00Z', NULL, '2020-01-01T00:00:00Z'),
      -- LOST, lost_at OUT window, created IN -> NO MATCH
      ('lost_out',        'lost', NULL, NULL, NULL, '2026-05-10T12:00:00Z', NULL, '2026-02-02T00:00:00Z'),
      -- OPEN, stage entry IN window
      ('open_entry_in',   'open', NULL, NULL, NULL, NULL, '2026-02-05T12:00:00Z', '2020-01-01T00:00:00Z'),
      -- OPEN, stage entry OUT window
      ('open_entry_out',  'open', NULL, NULL, NULL, NULL, '2026-05-01T12:00:00Z', '2026-02-01T00:00:00Z');
  `);
});

afterAll(async () => {
  await db?.close();
});

describe("deal date scope (runtime, PGlite)", () => {
  it("THE bug edge: a Won deal created in-window but won-closed OUT-of-window does NOT match; the converse does", async () => {
    const ids = await matchedIds(CTX); // flag off
    expect(ids).not.toContain("won_hs_out"); // created-in-window does not save an out-of-window won date
    expect(ids).toContain("won_hs_in"); // won date in-window matches despite out-of-window created date
  });

  it("flag OFF: Won/Lost window on their own dates; open rows are current-state (always included)", async () => {
    const ids = await matchedIds({ ...CTX, stageEntryDateEnabled: false });
    expect(ids).toEqual([
      "lost_in",
      "open_entry_in",
      "open_entry_out", // open, out-of-window stage entry, still included pre-flag (current-state)
      "won_fallback_in",
      "won_hs_in",
    ]);
  });

  it("flag ON: open rows become stage-entry-bounded; Won/Lost unchanged", async () => {
    const ids = await matchedIds({ ...CTX, stageEntryDateEnabled: true });
    expect(ids).toEqual([
      "lost_in",
      "open_entry_in", // entry in-window -> kept
      "won_fallback_in",
      "won_hs_in",
    ]);
    expect(ids).not.toContain("open_entry_out"); // out-of-window stage entry now excluded
  });

  it("Lost rows window on lost_at, ignoring created date", async () => {
    const ids = await matchedIds(CTX);
    expect(ids).toContain("lost_in");
    expect(ids).not.toContain("lost_out");
  });

  it("Won uses the canonical basis: jsonb hs_closed_won_date primary, won_closed_date fallback (both match in-window)", async () => {
    const ids = await matchedIds(CTX);
    expect(ids).toContain("won_hs_in"); // jsonb primary
    expect(ids).toContain("won_fallback_in"); // won_closed_date fallback via COALESCE
  });

  it("partial config (only Won stages resolve) still runs and excludes out-of-window Won rows", async () => {
    const ids = await matchedIds({ wonStageIds: ["won"], lostStageIds: [] });
    expect(ids).toContain("won_hs_in");
    expect(ids).not.toContain("won_hs_out");
  });

  it("dealDisplayDateExpr returns, per row, exactly the date the FILTER windows on (filter-axis == display-axis)", async () => {
    const expr = dealDisplayDateExpr(CTX);
    const { sql, params } = dialect.sqlToQuery(expr);
    const { rows } = await db.query<{ id: string; display_date: string | null }>(
      // to_char(...) so PGlite returns a 'YYYY-MM-DD' string, not a JS Date object.
      `SELECT id, to_char((${sql})::date, 'YYYY-MM-DD') AS display_date FROM deals ORDER BY id`,
      params as unknown[]
    );
    const byId = Object.fromEntries(rows.map((r) => [r.id, r.display_date]));
    // Won rows -> canonical won-close date (jsonb primary + won_closed_date fallback)
    expect(byId.won_hs_in).toBe("2026-02-15");
    expect(byId.won_hs_out).toBe("2026-05-15");
    expect(byId.won_fallback_in).toBe("2026-02-20");
    // Lost rows -> lost_at date
    expect(byId.lost_in).toBe("2026-02-10");
    expect(byId.lost_out).toBe("2026-05-10");
    // open rows -> stage entry date
    expect(byId.open_entry_in).toBe("2026-02-05");
    expect(byId.open_entry_out).toBe("2026-05-01");
    // Every row IN the filter result displays a date inside the window — the
    // structural proof the two axes agree.
    const matched = await matchedIds({ ...CTX, stageEntryDateEnabled: true });
    for (const id of matched) {
      const d = byId[id]!;
      expect(d >= "2026-02-01" && d <= "2026-02-28").toBe(true);
    }
  });
});
