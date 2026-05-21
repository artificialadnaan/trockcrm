import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationPath = resolve(__dirname, "../../../../migrations/0131_on_hold_deals_foundation.sql");
const migrationSql = existsSync(migrationPath) ? readFileSync(migrationPath, "utf8") : "";
const dealsSchemaPath = resolve(__dirname, "../../../../shared/src/schema/tenant/deals.ts");
const dealsSchema = existsSync(dealsSchemaPath) ? readFileSync(dealsSchemaPath, "utf8") : "";

describe("on hold deals foundation migration", () => {
  it("replays against current and future tenant schemas", () => {
    expect(migrationSql).toContain("-- TENANT_SCHEMA_START");
    expect(migrationSql).toContain("-- TENANT_SCHEMA_END");
    expect(migrationSql).toContain("WHERE nspname LIKE 'office\\_%' ESCAPE '\\'");
  });

  it("adds the hold state columns to tenant deals", () => {
    expect(migrationSql).toContain("ALTER TABLE %I.deals");
    expect(migrationSql).toContain("ADD COLUMN IF NOT EXISTS on_hold boolean NOT NULL DEFAULT false");
    expect(migrationSql).toContain("ADD COLUMN IF NOT EXISTS on_hold_started_at timestamptz");
    expect(migrationSql).toContain(
      "ADD COLUMN IF NOT EXISTS on_hold_accumulated_seconds bigint NOT NULL DEFAULT 0"
    );
    expect(migrationSql).toContain(
      "ADD COLUMN IF NOT EXISTS on_hold_accumulated_seconds_at_stage_entry bigint NOT NULL DEFAULT 0"
    );
    expect(migrationSql).toContain(
      "SET on_hold_accumulated_seconds_at_stage_entry = on_hold_accumulated_seconds"
    );
    expect(migrationSql).toContain(
      "column_name = 'on_hold_accumulated_seconds_at_stage_entry'"
    );
  });

  it("keeps the Drizzle deals schema aligned with the hold columns", () => {
    expect(dealsSchema).toContain('onHold: boolean("on_hold").default(false).notNull()');
    expect(dealsSchema).toContain('onHoldStartedAt: timestamp("on_hold_started_at", { withTimezone: true })');
    expect(dealsSchema).toMatch(
      /onHoldAccumulatedSeconds: bigint\("on_hold_accumulated_seconds", \{ mode: "number" \}\)\s+\.default\(0\)\s+\.notNull\(\)/
    );
    expect(dealsSchema).toMatch(
      /onHoldAccumulatedSecondsAtStageEntry: bigint\("on_hold_accumulated_seconds_at_stage_entry", \{[\s\S]*mode: "number"[\s\S]*\}\)\s+\.default\(0\)\s+\.notNull\(\)/
    );
  });
});
