import { describe, it, expect } from "vitest";
import {
  applyBaseDealFilters,
  wonStageSlugFilterSql,
  WON_STAGE_SLUGS,
} from "../../../src/mcp/data/applyBaseDealFilters.js";
import { reportableDealSqlPredicate } from "@trock-crm/shared/types";

// Reuses the established drizzle SQL-text assertion pattern (see deals-contract-signed-filter.test.ts):
// walk the SQL object's queryChunks to a flat string and assert on it.
function extractSqlText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  if (Array.isArray((value as { queryChunks?: unknown[] }).queryChunks)) {
    return (value as { queryChunks: unknown[] }).queryChunks.map(extractSqlText).join("");
  }
  if ("value" in (value as Record<string, unknown>)) {
    const chunkValue = (value as { value: unknown }).value;
    if (Array.isArray(chunkValue)) return chunkValue.map(extractSqlText).join("");
    if (typeof chunkValue === "string") return chunkValue;
  }
  if ("name" in (value as Record<string, unknown>) && typeof (value as { name?: unknown }).name === "string") {
    return (value as { name: string }).name;
  }
  return "";
}

describe("applyBaseDealFilters — the single base WHERE for every demo deal query", () => {
  const sql = extractSqlText(applyBaseDealFilters("d"));

  it("rule 1: requires is_active = true", () => {
    expect(sql).toMatch(/d\.is_active = true/);
  });

  it("rule 2: requires is_test_data = false", () => {
    expect(sql).toMatch(/COALESCE\(d\.is_test_data, false\) = false/);
  });

  it("rule 3: excludes on-hold via the canonical reporting predicate (no drift)", () => {
    // Reuses reportableDealSqlPredicate — the SAME on-hold exclusion current reporting uses.
    expect(sql).toContain(reportableDealSqlPredicate("d"));
    expect(sql).toMatch(/COALESCE\(d\.on_hold, false\) = false/);
  });

  it("rule 4: Won is the canonical 6-slug family, not a stage-name match", () => {
    expect(WON_STAGE_SLUGS).toHaveLength(6);
    expect([...WON_STAGE_SLUGS].sort()).toEqual(
      ["closed_won", "service_complete", "service_scheduled", "service_sent_to_production", "sent_to_production", "won"].sort()
    );
    expect(extractSqlText(wonStageSlugFilterSql("psc.slug"))).toMatch(/psc\.slug IN \(/);
  });

  it("rule 5: never reads staged_* tables", () => {
    expect(sql).not.toMatch(/staged_/);
  });

  it("rule 6: never reads an unbounded audit_log", () => {
    expect(sql).not.toMatch(/audit_log/);
  });

  it("rejects an unsafe / non-identifier alias (no SQL injection vector)", () => {
    expect(() => applyBaseDealFilters("d; DROP TABLE deals")).toThrow();
    expect(() => applyBaseDealFilters("d.on_hold")).toThrow();
  });
});
