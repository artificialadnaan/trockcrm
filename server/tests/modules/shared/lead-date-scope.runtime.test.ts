import { PGlite } from "@electric-sql/pglite";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  aliasedLeadDateScopeColumns,
  buildLeadOutcomeDateScope,
  leadDisplayDateExpr,
  type LeadDateScopeContext,
} from "../../../src/modules/shared/lead-date-scope.js";

const dialect = new PgDialect();
const WINDOW = { from: "2026-02-01", to: "2026-02-28" };

async function matchedIds(db: PGlite, ctx: LeadDateScopeContext = {}): Promise<string[]> {
  const predicate = buildLeadOutcomeDateScope(WINDOW, ctx);
  if (!predicate) throw new Error("expected predicate");
  const { sql: text, params } = dialect.sqlToQuery(predicate);
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM leads WHERE ${text} ORDER BY id`,
    params as unknown[]
  );
  return rows.map((row) => row.id);
}

async function displayDates(db: PGlite, ctx: LeadDateScopeContext = {}): Promise<Record<string, string | null>> {
  const expr = leadDisplayDateExpr(ctx);
  const { sql: text, params } = dialect.sqlToQuery(expr);
  const { rows } = await db.query<{ id: string; d: string | null }>(
    `SELECT id, to_char((${text}), 'YYYY-MM-DD') AS d FROM leads ORDER BY id`,
    params as unknown[]
  );
  return Object.fromEntries(rows.map((row) => [row.id, row.d]));
}

describe("buildLeadOutcomeDateScope (runtime PGlite)", () => {
  let db: PGlite;

  beforeAll(async () => {
    db = new PGlite();
    // stage_entered_at is nullable in the probe table on purpose: the contract
    // wants `open` to fall back to created_at when stage-entry is null/unreliable,
    // and we must be able to exercise that fallback even though the real column
    // is currently NOT NULL.
    await db.exec(`
      CREATE TABLE leads (
        id text PRIMARY KEY,
        status text NOT NULL,
        converted_at timestamptz,
        disqualified_at timestamptz,
        stage_entered_at timestamptz,
        created_at timestamptz NOT NULL
      );
      INSERT INTO leads (id, status, converted_at, disqualified_at, stage_entered_at, created_at) VALUES
        -- converted: windowed on converted_at
        ('converted_in',     'converted',    '2026-02-15T12:00:00Z', NULL, '2026-05-01T12:00:00Z', '2025-01-01T12:00:00Z'),
        ('converted_out',    'converted',    '2026-05-15T12:00:00Z', NULL, '2026-02-10T12:00:00Z', '2026-02-05T12:00:00Z'),
        ('converted_on_from','converted',    '2026-02-01T12:00:00Z', NULL, NULL,                   '2025-01-01T12:00:00Z'),
        ('converted_on_to',  'converted',    '2026-02-28T12:00:00Z', NULL, NULL,                   '2025-01-01T12:00:00Z'),
        ('converted_after',  'converted',    '2026-03-01T12:00:00Z', NULL, NULL,                   '2025-01-01T12:00:00Z'),
        -- disqualified: windowed on disqualified_at (NO coalesce to stage_entered_at)
        ('disq_in',          'disqualified', NULL, '2026-02-20T12:00:00Z', '2026-05-01T12:00:00Z', '2024-01-01T12:00:00Z'),
        ('disq_out',         'disqualified', NULL, '2026-05-20T12:00:00Z', '2026-02-03T12:00:00Z', '2026-02-01T12:00:00Z'),
        ('disq_null',        'disqualified', NULL, NULL,                   '2026-02-15T12:00:00Z', '2026-02-10T12:00:00Z'),
        -- open: windowed on stage_entered_at, fallback created_at when null
        ('open_entry_in',    'open',         NULL, NULL, '2026-02-05T12:00:00Z', '2020-01-01T12:00:00Z'),
        ('open_entry_out',   'open',         NULL, NULL, '2026-05-01T12:00:00Z', '2026-02-01T12:00:00Z'),
        ('open_fallback_in', 'open',         NULL, NULL, NULL,                   '2026-02-12T12:00:00Z'),
        ('open_fallback_out','open',         NULL, NULL, NULL,                   '2026-05-12T12:00:00Z');
    `);
  });

  afterAll(async () => {
    await db?.close();
  });

  it("windows converted rows on converted_at (the bug: stage-entered in-window but converted-out stays out)", async () => {
    const ids = await matchedIds(db);
    expect(ids).toContain("converted_in");
    // converted_out has stage_entered_at AND created_at in-window, but converted_at is out -> excluded
    expect(ids).not.toContain("converted_out");
  });

  it("windows disqualified rows on disqualified_at", async () => {
    const ids = await matchedIds(db);
    expect(ids).toContain("disq_in");
    expect(ids).not.toContain("disq_out");
  });

  it("does NOT widen disqualified rows with a null disqualified_at to stage_entered_at (never widen)", async () => {
    const ids = await matchedIds(db);
    // disq_null has stage_entered_at + created_at in-window, but disqualified_at is null -> excluded, not widened
    expect(ids).not.toContain("disq_null");
  });

  it("windows open rows on stage_entered_at", async () => {
    const ids = await matchedIds(db);
    expect(ids).toContain("open_entry_in");
    // open_entry_out has created_at in-window, but stage_entered_at (the open axis) is out -> excluded
    expect(ids).not.toContain("open_entry_out");
  });

  it("falls back to created_at for open rows when stage_entered_at is null", async () => {
    const ids = await matchedIds(db);
    expect(ids).toContain("open_fallback_in");
    expect(ids).not.toContain("open_fallback_out");
  });

  it("uses an inclusive-from / inclusive-to-day (exclusive next day) boundary", async () => {
    const ids = await matchedIds(db);
    expect(ids).toContain("converted_on_from"); // 2026-02-01 (== from) included
    expect(ids).toContain("converted_on_to"); // 2026-02-28 (== to) included
    expect(ids).not.toContain("converted_after"); // 2026-03-01 excluded
  });

  it("matches exactly the in-window set across all three outcomes", async () => {
    const ids = await matchedIds(db);
    expect(ids).toEqual([
      "converted_in",
      "converted_on_from",
      "converted_on_to",
      "disq_in",
      "open_entry_in",
      "open_fallback_in",
    ]);
  });

  it("displayDate == the per-row filter axis (filter-axis == display-axis)", async () => {
    const dates = await displayDates(db);
    // converted -> converted_at
    expect(dates.converted_in).toBe("2026-02-15");
    expect(dates.converted_out).toBe("2026-05-15");
    // disqualified -> disqualified_at; null disqualified_at -> null display (never the stage date)
    expect(dates.disq_in).toBe("2026-02-20");
    expect(dates.disq_null).toBeNull();
    // open -> stage_entered_at, fallback created_at
    expect(dates.open_entry_in).toBe("2026-02-05");
    expect(dates.open_entry_out).toBe("2026-05-01");
    expect(dates.open_fallback_in).toBe("2026-02-12");
  });

  it("works against an aliased lead table (raw-SQL queries)", async () => {
    const ctx: LeadDateScopeContext = { columns: aliasedLeadDateScopeColumns("l") };
    const predicate = buildLeadOutcomeDateScope(WINDOW, ctx);
    if (!predicate) throw new Error("expected predicate");
    const { sql: text, params } = dialect.sqlToQuery(predicate);
    const { rows } = await db.query<{ id: string }>(
      `SELECT l.id FROM leads l WHERE ${text} ORDER BY l.id`,
      params as unknown[]
    );
    expect(rows.map((row) => row.id)).toContain("converted_in");
    expect(rows.map((row) => row.id)).not.toContain("converted_out");
  });
});
