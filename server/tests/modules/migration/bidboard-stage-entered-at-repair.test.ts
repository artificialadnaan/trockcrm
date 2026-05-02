import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migrationSql = readFileSync(
  new URL("../../../../migrations/0074_repair_bidboard_stage_entered_at.sql", import.meta.url),
  "utf8"
);

describe("0074_repair_bidboard_stage_entered_at migration", () => {
  it("repairs tenant stage_entered_at values reset by the stage-v2 active deal backfill", () => {
    expect(migrationSql).toContain("FOR tenant_schema IN");
    expect(migrationSql).toContain("deal_stage_history");
    expect(migrationSql).toContain("bid_board_stage_entered_at");
    expect(migrationSql).toContain("created_at");
    expect(migrationSql).toContain("2026-05-01T19:00:00Z");
    expect(migrationSql).toContain("stage_entered_at IS DISTINCT FROM");
  });
});
