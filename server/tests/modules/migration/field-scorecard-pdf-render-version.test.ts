import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migrationSql = readFileSync(
  resolve(import.meta.dirname, "../../../../migrations/0184_field_scorecard_pdf_render_version.sql"),
  "utf8",
);

describe("migration 0184: field scorecard PDF render version", () => {
  it("backfills every existing tenant artifact to legacy version 1 idempotently", () => {
    expect(migrationSql).toContain("nspname ~ '^office_'");
    expect(migrationSql).toContain(
      "ADD COLUMN IF NOT EXISTS pdf_render_version smallint NOT NULL DEFAULT 1",
    );
  });

  it("includes the tenant provisioner template block for future offices", () => {
    expect(migrationSql).toContain("-- TENANT_SCHEMA_START");
    expect(migrationSql).toContain("ALTER TABLE office_dallas.field_scorecards");
    expect(migrationSql).toContain("-- TENANT_SCHEMA_END");
  });
});
