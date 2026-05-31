import { PGlite } from "@electric-sql/pglite";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildDealOutcomeDateScope, dealDisplayDateExpr } from "../../../src/modules/shared/deal-date-scope.js";

/**
 * RUNTIME coverage for the canonical outcome-aware date model against a real
 * in-memory Postgres (PGlite). Proves the edge that DEFINES the platform-wide bug:
 * a deal CREATED in-window but WON out-of-window must NOT match (the won date
 * governs), and the converse. Won axis = canonical deals.won_closed_date.
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
  await db.exec(`
    CREATE TABLE deals (
      id text PRIMARY KEY,
      stage_id text NOT NULL,
      won_closed_date date,
      lost_at timestamptz,
      stage_entered_at timestamptz,
      created_at timestamptz
    );
    INSERT INTO deals (id, stage_id, won_closed_date, lost_at, stage_entered_at, created_at) VALUES
      ('won_in',         'won',  '2026-02-15', NULL, NULL, '2025-01-01T00:00:00Z'),
      ('won_out',        'won',  '2026-05-15', NULL, NULL, '2026-02-10T00:00:00Z'),
      ('lost_in',        'lost', NULL, '2026-02-10T12:00:00Z', NULL, '2020-01-01T00:00:00Z'),
      ('lost_out',       'lost', NULL, '2026-05-10T12:00:00Z', NULL, '2026-02-02T00:00:00Z'),
      ('open_entry_in',  'open', NULL, NULL, '2026-02-05T12:00:00Z', '2020-01-01T00:00:00Z'),
      ('open_entry_out', 'open', NULL, NULL, '2026-05-01T12:00:00Z', '2026-02-01T00:00:00Z');
  `);
});

afterAll(async () => {
  await db?.close();
});

describe("deal date scope (runtime, PGlite)", () => {
  it("THE bug edge: a Won deal created in-window but won-closed OUT-of-window does NOT match; the converse does", async () => {
    const ids = await matchedIds(CTX);
    expect(ids).not.toContain("won_out");
    expect(ids).toContain("won_in");
  });

  it("flag OFF: Won/Lost window on their own dates; open rows are current-state (always included)", async () => {
    const ids = await matchedIds({ ...CTX, stageEntryDateEnabled: false });
    expect(ids).toEqual(["lost_in", "open_entry_in", "open_entry_out", "won_in"]);
  });

  it("flag ON: open rows become stage-entry-bounded; Won/Lost unchanged", async () => {
    const ids = await matchedIds({ ...CTX, stageEntryDateEnabled: true });
    expect(ids).toEqual(["lost_in", "open_entry_in", "won_in"]);
    expect(ids).not.toContain("open_entry_out");
  });

  it("Lost rows window on lost_at, ignoring created date", async () => {
    const ids = await matchedIds(CTX);
    expect(ids).toContain("lost_in");
    expect(ids).not.toContain("lost_out");
  });

  it("Won uses the canonical deals.won_closed_date basis", async () => {
    const ids = await matchedIds(CTX);
    expect(ids).toContain("won_in");
    expect(ids).not.toContain("won_out");
  });

  it("partial classification (only Won stages resolve) keeps windowing Won and excludes the rest", async () => {
    // Codex #546: Won windowed on won_closed_date; Lost + open rows excluded (not
    // folded into open, and the predicate is NOT dropped to all-rows).
    const ids = await matchedIds({ wonStageIds: ["won"], lostStageIds: [] });
    expect(ids).toEqual(["won_in"]);
  });

  it("dealDisplayDateExpr returns, per row, exactly the date the FILTER windows on (filter-axis == display-axis)", async () => {
    const expr = dealDisplayDateExpr(CTX);
    const { sql, params } = dialect.sqlToQuery(expr);
    const { rows } = await db.query<{ id: string; display_date: string | null }>(
      `SELECT id, to_char((${sql})::date, 'YYYY-MM-DD') AS display_date FROM deals ORDER BY id`,
      params as unknown[]
    );
    const byId = Object.fromEntries(rows.map((r) => [r.id, r.display_date]));
    expect(byId.won_in).toBe("2026-02-15");
    expect(byId.won_out).toBe("2026-05-15");
    expect(byId.lost_in).toBe("2026-02-10");
    expect(byId.lost_out).toBe("2026-05-10");
    expect(byId.open_entry_in).toBe("2026-02-05");
    expect(byId.open_entry_out).toBe("2026-05-01");
    const matched = await matchedIds({ ...CTX, stageEntryDateEnabled: true });
    for (const id of matched) {
      const d = byId[id]!;
      expect(d >= "2026-02-01" && d <= "2026-02-28").toBe(true);
    }
  });
});
