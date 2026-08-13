import { describe, expect, it, vi } from "vitest";

vi.mock("../../../src/db.js", () => ({
  db: {},
}));

vi.mock("../../../src/modules/admin/cleanup-queue-service.js", () => ({
  getMyCleanupQueue: vi.fn(),
}));

vi.mock("../../../src/modules/migration/service.js", () => ({
  getMigrationSummary: vi.fn(),
}));

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

/**
 * The executable SQL, with `--` comments stripped and whitespace collapsed.
 *
 * BOTH steps are load-bearing. The comments travel inside the template literal, so a naive `toContain`
 * can match prose ABOUT the query instead of the query — an assertion that passes while the SQL says the
 * opposite. And the raw text carries the template's own newlines and indentation, which is how the first
 * draft of the "flag is ANDed" assertion below ended up matching nothing at all: it survived an AND→OR
 * mutation of the shared predicate and proved only that a string with that exact whitespace was absent.
 */
function normalizeSql(value: unknown): string {
  return extractSqlText(value)
    .replace(/--[^\n]*/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

async function runRoster(rows: unknown[], officeId?: string) {
  const { getRepRosterOptions } = await import("../../../src/modules/dashboard/service.js");
  const tenantDb = { execute: vi.fn().mockResolvedValue({ rows }) } as any;
  const result = await getRepRosterOptions(tenantDb, officeId);
  return {
    result,
    sql: normalizeSql(tenantDb.execute.mock.calls[0][0]),
  };
}

describe("getRepRosterOptions", () => {
  it("returns the roster as picker options", async () => {
    const { result } = await runRoster([
      { id: "u1", display_name: "Colby Burling" },
      { id: "u2", display_name: "Derek Barr" },
    ]);

    expect(result).toEqual([
      { id: "u1", displayName: "Colby Burling" },
      { id: "u2", displayName: "Derek Barr" },
    ]);
  });

  it("applies the roster flag ABSOLUTELY — the same rule as the cards and funnel", async () => {
    // The decision this endpoint exists to enforce: unticking "Generates Sales" removes someone from the
    // filter even while they still own live deals. If this predicate ever softened to "flagged OR owns a
    // deal", the admin control would silently stop working, which is the exact regression the director
    // dashboard already shipped once and had to fix.
    const { sql } = await runRoster([], "office-1");

    // The flag must be ANDed to what follows. Asserting the ADJACENCY is the whole point — "contains
    // generates_sales = true" alone passes just as happily when the operator is OR, which is the mutation
    // that turns an absolute roster flag into a suggestion.
    expect(sql).toContain("u.generates_sales = true and (");
    expect(sql).not.toContain("u.generates_sales = true or (");
    // The owner leg must remain a widener for OFFICE MEMBERSHIP, never an alternative to the flag: it sits
    // inside the parenthesised office test, ANDed to the flag above it.
    expect(sql).toContain("owner_rows.rep_id is not null");
  });

  it("excludes deactivated and test-data accounts", async () => {
    const { sql } = await runRoster([], "office-1");

    expect(sql).toContain("u.is_active = true");
    expect(sql).toContain("coalesce(u.is_test_data, false) = false");
  });

  it("scopes to the office by primary office OR an access grant", async () => {
    // Dropping the grant leg would strip exactly the multi-office users the reassignment backends accept,
    // leaving valid reps un-pickable — the same trap documented on /users/sales-reps.
    const { sql } = await runRoster([], "office-1");

    expect(sql).toContain("u.office_id =");
    expect(sql).toContain("user_office_access");
  });

  it("orders case-insensitively so a badly-cased row cannot form its own block", async () => {
    const { sql } = await runRoster([]);

    expect(sql).toContain("order by lower(u.display_name)");
  });

  it("bounds the owner leg to this tenant's deals only", async () => {
    // deals is a TENANT table; the CTE must not reach for an office column that does not exist there.
    const { sql } = await runRoster([], "office-1");

    expect(sql).toContain("select distinct d.assigned_rep_id");
    expect(sql).toContain("from deals d");
  });

  it("tolerates a driver that returns a bare array instead of { rows }", async () => {
    const { getRepRosterOptions } = await import("../../../src/modules/dashboard/service.js");
    const tenantDb = {
      execute: vi.fn().mockResolvedValue([{ id: "u1", display_name: "Chase Kelly" }]),
    } as any;

    await expect(getRepRosterOptions(tenantDb, "office-1")).resolves.toEqual([
      { id: "u1", displayName: "Chase Kelly" },
    ]);
  });

  it("never emits undefined for a row missing a display name", async () => {
    const { result } = await runRoster([{ id: "u1", display_name: null }]);

    expect(result).toEqual([{ id: "u1", displayName: "" }]);
  });
});
