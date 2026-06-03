import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";

import { canonicalProjectNumberSql } from "../../../src/modules/bid-board-sync/project-number.js";

const migrationPath = resolve(
  import.meta.dirname,
  "../../../../migrations/0149_bid_board_project_number_canonical_index.sql"
);
const sql = readFileSync(migrationPath, "utf8");

// Compare representation-independently: fold any \uXXXX escapes to their characters so a
// glyph-form file and an escape-form expression (or vice versa) still compare equal.
function toChars(s: string): string {
  return s.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

describe("migration 0149: canonical bid_board_project_number unique index", () => {
  it("drops the old raw unique index", () => {
    expect(sql).toContain("DROP INDEX IF EXISTS");
    expect(sql).toContain("deals_bid_board_project_number_uidx");
  });

  it("creates a canonical unique index, partial on non-null values", () => {
    expect(sql).toContain("CREATE UNIQUE INDEX");
    expect(sql).toContain("deals_bid_board_project_number_canonical_uidx");
    expect(sql).toContain("WHERE bid_board_project_number IS NOT NULL");
  });

  it("indexes the EXACT canonical expression the matcher uses (lockstep with service.ts)", () => {
    expect(toChars(sql)).toContain(toChars(canonicalProjectNumberSql("bid_board_project_number")));
  });

  it("adds (non-unique) canonical indexes for the other two Tier-2 match columns so the matcher stays index-backed", () => {
    expect(sql).toContain("deals_project_number_canonical_idx");
    expect(sql).toContain("deals_deal_number_canonical_idx");
    expect(toChars(sql)).toContain(toChars(canonicalProjectNumberSql("project_number")));
    expect(toChars(sql)).toContain(toChars(canonicalProjectNumberSql("deal_number")));
    // these two are NOT unique (project_number / deal_number have their own uniqueness rules)
    expect(sql).not.toContain("CREATE UNIQUE INDEX IF NOT EXISTS deals_project_number_canonical_idx");
    expect(sql).not.toContain("CREATE UNIQUE INDEX IF NOT EXISTS deals_deal_number_canonical_idx");
  });

  it("pre-detects canonical collisions and fails loudly instead of a cryptic unique violation", () => {
    expect(sql).toContain("RAISE EXCEPTION");
    expect(sql.toLowerCase()).toContain("collision");
  });

  it("applies per-tenant via dynamic schema discovery", () => {
    expect(sql).toContain("information_schema.schemata");
    expect(sql).toContain("%I.deals");
  });
});
