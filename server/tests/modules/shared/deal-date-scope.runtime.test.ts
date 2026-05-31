import { PGlite } from "@electric-sql/pglite";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildDealOutcomeDateScope } from "../../../src/modules/shared/deal-date-scope.js";

/**
 * RUNTIME coverage for the canonical outcome-aware date model, executed against a
 * real in-memory Postgres (PGlite) — not rendered-SQL mocks. This proves the
 * SEMANTICS the model exists to fix, the edge that DEFINES the platform-wide bug:
 *
 *   A deal whose CREATED date is in-window but whose WON date is OUT-of-window
 *   must NOT match (created date is irrelevant; the won date governs). And the
 *   converse: a deal whose won date is in-window matches even if it was created
 *   outside the window. Lost rows window on lost_at; open rows are current-state
 *   pre-flag (always included) and stage-entry-bounded post-flag.
 *
 * The predicate is built by buildDealOutcomeDateScope, rendered to parameterized
 * SQL via PgDialect, and run as the WHERE of a real SELECT so a runtime-only SQL
 * bug (casts, COALESCE, NOT/OR precedence) surfaces here — the class of bug that
 * mock tests missed on #538.
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
      contract_signed_at timestamptz,
      contract_signed_date date,
      lost_at timestamptz,
      stage_entered_at timestamptz,
      created_at timestamptz
    );
    INSERT INTO deals (id, stage_id, contract_signed_at, contract_signed_date, lost_at, stage_entered_at, created_at) VALUES
      -- WON, signed IN window, created OUT  -> MATCH (converse: created date irrelevant)
      ('won_signed_in',   'won',  '2026-02-15T12:00:00Z', NULL, NULL, NULL, '2025-01-01T00:00:00Z'),
      -- WON, signed OUT window, created IN  -> NO MATCH (THE bug edge: created in-window must not save it)
      ('won_signed_out',  'won',  '2026-05-15T12:00:00Z', NULL, NULL, NULL, '2026-02-10T00:00:00Z'),
      -- WON via legacy contract_signed_date fallback, IN window -> MATCH (COALESCE chain)
      ('won_legacy_in',   'won',  NULL, '2026-02-20', NULL, NULL, '2020-01-01T00:00:00Z'),
      -- LOST, lost_at IN window -> MATCH
      ('lost_in',         'lost', NULL, NULL, '2026-02-10T12:00:00Z', NULL, '2020-01-01T00:00:00Z'),
      -- LOST, lost_at OUT window, created IN -> NO MATCH
      ('lost_out',        'lost', NULL, NULL, '2026-05-10T12:00:00Z', NULL, '2026-02-02T00:00:00Z'),
      -- OPEN, stage entry IN window
      ('open_entry_in',   'open', NULL, NULL, NULL, '2026-02-05T12:00:00Z', '2020-01-01T00:00:00Z'),
      -- OPEN, stage entry OUT window
      ('open_entry_out',  'open', NULL, NULL, NULL, '2026-05-01T12:00:00Z', '2026-02-01T00:00:00Z');
  `);
});

afterAll(async () => {
  await db?.close();
});

describe("deal date scope (runtime, PGlite)", () => {
  it("THE bug edge: a Won deal created in-window but signed OUT-of-window does NOT match; the converse does", async () => {
    const ids = await matchedIds(CTX); // flag off
    // created-in-window does NOT save an out-of-window won date:
    expect(ids).not.toContain("won_signed_out");
    // won date in-window matches even though it was created out-of-window:
    expect(ids).toContain("won_signed_in");
  });

  it("flag OFF: Won/Lost window on their own dates; open rows are current-state (always included)", async () => {
    const ids = await matchedIds({ ...CTX, stageEntryDateEnabled: false });
    expect(ids).toEqual([
      "lost_in",
      "open_entry_in",
      "open_entry_out", // open, out-of-window stage entry, still included pre-flag (current-state)
      "won_legacy_in",
      "won_signed_in",
    ]);
  });

  it("flag ON: open rows become stage-entry-bounded; Won/Lost unchanged", async () => {
    const ids = await matchedIds({ ...CTX, stageEntryDateEnabled: true });
    expect(ids).toEqual([
      "lost_in",
      "open_entry_in", // entry in-window -> kept
      "won_legacy_in",
      "won_signed_in",
    ]);
    // out-of-window stage entry is now excluded:
    expect(ids).not.toContain("open_entry_out");
  });

  it("Lost rows window on lost_at, ignoring created date", async () => {
    const ids = await matchedIds(CTX);
    expect(ids).toContain("lost_in");
    expect(ids).not.toContain("lost_out"); // created in-window does not save an out-of-window lost date
  });

  it("partial config (only Won stages resolve) still runs and excludes out-of-window Won rows", async () => {
    // No throw (only BOTH-empty throws); lost rows fall to the open branch.
    const ids = await matchedIds({ wonStageIds: ["won"], lostStageIds: [] });
    expect(ids).toContain("won_signed_in");
    expect(ids).not.toContain("won_signed_out");
  });
});
