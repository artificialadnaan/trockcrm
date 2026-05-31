import { PGlite } from "@electric-sql/pglite";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  aliasedDealDateScopeColumns,
  buildStageEntryDateWindow,
} from "../../../src/modules/shared/deal-date-scope.js";

/**
 * Real-SQL (PGlite) boundary proof for the D-11 open-column window helper used by
 * getDealsForPipeline's open ELSE branch. Locks the canonical convention against
 * an off-by-one: inclusive lower bound (`>= from::date`), exclusive next-day upper
 * bound (`< to::date + 1 day`) — so a deal entered ON `to` is IN and one entered
 * the day after `to` is OUT. (The mixed Won/Lost/open classifier is proven in
 * deal-date-scope.runtime.test.ts; this proves the standalone open-axis window the
 * board applies per open stage.)
 */

const dialect = new PgDialect();
let db: PGlite;

async function matchedIds(window: { from?: string; to?: string }): Promise<string[]> {
  const predicate = buildStageEntryDateWindow(window, aliasedDealDateScopeColumns("deals"));
  if (!predicate) {
    const { rows } = await db.query<{ id: string }>(`SELECT id FROM deals ORDER BY id`);
    return rows.map((r) => r.id);
  }
  const { sql, params } = dialect.sqlToQuery(predicate);
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM deals WHERE ${sql} ORDER BY id`,
    params as unknown[]
  );
  return rows.map((r) => r.id);
}

beforeAll(async () => {
  db = new PGlite();
  // Pin the session tz so timestamptz::date is deterministic regardless of the
  // host TZ (the canonical helper casts stage_entered_at::date without AT TIME ZONE).
  await db.exec(`SET TIME ZONE 'UTC';`);
  await db.exec(`
    CREATE TABLE deals ( id text PRIMARY KEY, stage_entered_at timestamptz );
    INSERT INTO deals (id, stage_entered_at) VALUES
      ('before',  '2026-04-30T23:59:59Z'),
      ('on_from', '2026-05-01T00:00:00Z'),
      ('mid',     '2026-05-15T12:00:00Z'),
      ('on_to',   '2026-05-31T23:59:59Z'),
      ('after',   '2026-06-01T00:00:00Z');
  `);
});

afterAll(async () => {
  await db?.close();
});

describe("buildStageEntryDateWindow — D-11 open-column window (real SQL boundary)", () => {
  it("includes rows entered from the inclusive lower bound through the inclusive upper day (exclusive next-day)", async () => {
    expect(await matchedIds({ from: "2026-05-01", to: "2026-05-31" })).toEqual(["mid", "on_from", "on_to"]);
  });

  it("excludes a row entered the day AFTER `to` and one entered before `from` (off-by-one guard)", async () => {
    const ids = await matchedIds({ from: "2026-05-01", to: "2026-05-31" });
    expect(ids).not.toContain("after");
    expect(ids).not.toContain("before");
  });

  it("a from-only window includes everything on/after `from`", async () => {
    expect(await matchedIds({ from: "2026-05-01" })).toEqual(["after", "mid", "on_from", "on_to"]);
  });

  it("an empty window returns undefined (caller omits it — no narrowing)", () => {
    expect(buildStageEntryDateWindow({})).toBeUndefined();
    expect(buildStageEntryDateWindow({ from: "  ", to: "" })).toBeUndefined();
  });
});
