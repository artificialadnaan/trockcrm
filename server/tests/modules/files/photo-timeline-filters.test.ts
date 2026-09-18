import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  buildDealPhotoTimelineConditions,
  describeDealPhotoTimelineFilters,
  latestActiveVersionCondition,
} from "../../../src/modules/files/photo-timeline-filters.js";

const dialect = new PgDialect();

function tenantDb() {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [{ sourceLeadId: null }],
        }),
      }),
    }),
  };
}

describe("deal photo timeline filters", () => {
  it("excludes soft-deleted photos by default and includes them when requested", async () => {
    await expect(buildDealPhotoTimelineConditions(tenantDb() as any, "deal-1", {})).resolves.toBeTruthy();

    expect(describeDealPhotoTimelineFilters({})).toContain("deleted_at");
    expect(describeDealPhotoTimelineFilters({ includeDeleted: true })).not.toContain("deleted_at");
  });

  it("adds category, uploader, and taken-at date filters", async () => {
    const filters = {
      categories: ["damage", "uncategorized"],
      tags: ["roofing"],
      uploaderIds: ["user-1", "user-2"],
      from: "2026-01-01",
      to: "2026-05-04",
    };
    await expect(buildDealPhotoTimelineConditions(tenantDb() as any, "deal-1", filters)).resolves.toBeTruthy();
    const keys = describeDealPhotoTimelineFilters(filters);

    expect(keys).toContain("photo_category");
    expect(keys).toContain("tags");
    expect(keys).toContain("uploaded_by");
    expect(keys).toContain("taken_at");
    expect(keys).toContain("created_at");
  });

  it("adds the photo_ids key only when a non-empty photoIds whitelist is provided", () => {
    expect(describeDealPhotoTimelineFilters({})).not.toContain("photo_ids");
    expect(describeDealPhotoTimelineFilters({ photoIds: [] })).not.toContain("photo_ids");
    expect(describeDealPhotoTimelineFilters({ photoIds: ["  "] })).not.toContain("photo_ids");
    expect(describeDealPhotoTimelineFilters({ photoIds: ["photo-1"] })).toContain("photo_ids");
  });
});

describe("latestActiveVersionCondition", () => {
  // WHAT IS AND IS NOT ASSERTED HERE. The SEMANTICS of this predicate — which rows survive, for flat,
  // nested, tied, inactive and self-parent version families — are proven by EXECUTING it against a real
  // Postgres in latest-version-predicate-equivalence.runtime.test.ts. Those belong there; a regex over
  // generated SQL cannot tell a correct predicate from a broken one (the assertion this replaced matched
  // `f2.version > files.version` and so failed on nothing worse than renaming an alias).
  //
  // What survives here is the one property that is INVISIBLE to a result-set test: the predicate must
  // stay INDEXABLE. Comparing two COALESCE expressions to each other returns exactly the same rows as
  // the two correlated lookups do — so every semantic test still passes — while forcing Postgres to hash
  // the entire files table, which is the regression this whole change exists to remove. Nothing but the
  // shape of the SQL can catch that, so it is pinned as shape.
  it("keeps the family lookup indexable — no COALESCE compared against another COALESCE", () => {
    const sqlText = dialect.sqlToQuery(latestActiveVersionCondition()).sql;
    // The unindexable shape: an expression on the INNER side equated to one on the outer side. No index
    // can serve it, so this must never come back.
    expect(sqlText).not.toMatch(/COALESCE\([^)]*\)\s*=\s*COALESCE\(/i);
    // Each half must key on a BARE inner column, which is what lets files_version_chain_idx and
    // files_pkey drive correlated lookups instead of a whole-table hash.
    expect(sqlText).toMatch(/\bnewer_child\.parent_file_id\s*=\s*COALESCE\(files\.parent_file_id, files\.id\)/);
    expect(sqlText).toMatch(/\bfamily_root\.id\s*=\s*COALESCE\(files\.parent_file_id, files\.id\)/);
    // The root half is only equivalent to the old expression for rows whose own parent is NULL; see the
    // NESTED_MID case in the equivalence suite for what this guard prevents.
    expect(sqlText).toContain("family_root.parent_file_id IS NULL");
    // Must NOT be the pre-2026-06 single-level check, which only ever excluded the family root.
    expect(sqlText).not.toMatch(/parent_file_id\s*=\s*files\.id\b/);
  });

  it("is parenthesized as one unit so callers can compose it with or()", () => {
    const sqlText = dialect.sqlToQuery(latestActiveVersionCondition()).sql.trim();
    // Two AND-ed NOT EXISTS clauses returned unwrapped would re-associate the first time this is dropped
    // into an or(...) branch, silently widening whatever it was OR-ed with.
    expect(sqlText.startsWith("(")).toBe(true);
    expect(sqlText.endsWith(")")).toBe(true);
  });
});
