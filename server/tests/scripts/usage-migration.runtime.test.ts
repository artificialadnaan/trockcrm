// server/tests/scripts/usage-migration.runtime.test.ts
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`CREATE SCHEMA office_dallas;`);
  const sql = readFileSync(new URL("../../../migrations/0157_usage_tracking.sql", import.meta.url), "utf8");
  await db.exec(sql);
});

afterAll(async () => {
  await db?.close();
});

describe("0157_usage_tracking migration", () => {
  it("creates all four usage tables in office_dallas", async () => {
    const { rows } = await db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'office_dallas' AND table_name LIKE 'usage_%' ORDER BY table_name`,
    );
    expect(rows.map((r) => r.table_name)).toEqual([
      "usage_daily", "usage_heartbeat", "usage_session", "usage_view_event",
    ]);
  });

  it("usage_daily has a composite primary key on (user_id, date)", async () => {
    const { rows } = await db.query<{ column_name: string }>(
      `SELECT kcu.column_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema    = kcu.table_schema
       WHERE tc.table_schema = 'office_dallas'
         AND tc.table_name   = 'usage_daily'
         AND tc.constraint_type = 'PRIMARY KEY'
       ORDER BY kcu.ordinal_position`,
    );
    expect(rows.map((r) => r.column_name)).toEqual(["user_id", "date"]);
  });
});
