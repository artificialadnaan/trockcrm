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

    // A row with no `grp` maps to "sales", not to undefined — the sales leg is the default so a shape the
    // mapper does not recognise still lands in a section the client renders.
    expect(result).toEqual([
      { id: "u1", displayName: "Colby Burling", group: "sales" },
      { id: "u2", displayName: "Derek Barr", group: "sales" },
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

    expect(sql).toContain("lower(display_name) asc");
  });

  it("wraps the UNION in a subquery so the ORDER BY may use an expression", async () => {
    // Postgres restricts a TOP-LEVEL ORDER BY on a UNION to bare result-column names: "ORDER BY grp DESC,
    // lower(display_name)" applied straight to the union fails with "Only result column names can be used,
    // not expressions or functions". The wrapper is what makes the ordering legal, and nothing else in the
    // suite would notice its removal — tsc cannot see inside the template and every other test here runs
    // against a MOCKED execute that never parses the SQL. This assertion is the only guard.
    const { sql } = await runRoster([], "office-1");

    // Adjacency is the point: the ORDER BY must sit outside the closing paren of the wrapper.
    expect(sql).toContain(") roster order by");
    expect(sql).toContain("select id, display_name, grp from (");
  });

  it("puts sales before estimators, then orders by name within each section", async () => {
    const { sql } = await runRoster([], "office-1");

    // 'sales' > 'estimator' lexically, so DESC is what places the sales block first. An ASC here would
    // silently invert the two sections.
    expect(sql).toContain("order by grp desc, lower(display_name) asc, id asc");
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
      { id: "u1", displayName: "Chase Kelly", group: "sales" },
    ]);
  });

  it("never emits undefined for a row missing a display name", async () => {
    const { result } = await runRoster([{ id: "u1", display_name: null }]);

    expect(result).toEqual([{ id: "u1", displayName: "", group: "sales" }]);
  });

  it("selects estimators by the flag and bounds the estimator CTE to this tenant", async () => {
    const { sql } = await runRoster([], "office-1");

    expect(sql).toContain("u.estimates_jobs = true");
    // The estimator equivalent of the owner CTE — deals is a TENANT table, so this is bounded by schema
    // isolation rather than by an office column that does not exist there.
    expect(sql).toContain("select distinct d.estimator_user_id");
    expect(sql).toContain("'estimator' as grp");
  });

  it("enforces SALES WINS in SQL — an estimator who also sells is excluded from the estimator leg", async () => {
    // Adnaan's decision: one person appears in exactly ONE section, and when both flags are ticked Sales
    // wins. Enforcing it here rather than de-duplicating in JS is deliberate — it means no caller can
    // reassemble a double listing. He accepted, knowing it makes Timothy Mitchell's 97 and Colby Burling's
    // 54 estimated-for-others deals unreachable through this control.
    const { sql } = await runRoster([], "office-1");

    // Adjacency again: asserting the operator is the whole point — "contains the flag test" alone passes
    // just as happily under an OR, which is the mutation that puts a sales rep in both sections at once.
    expect(sql).toContain("u.estimates_jobs = true and not (u.generates_sales = true");
    expect(sql).not.toContain("u.estimates_jobs = true or not (u.generates_sales = true");
  });

  it("applies Sales-wins against THIS OFFICE's sales leg, not the global flag (Codex #1067 P2)", async () => {
    // A bare `generates_sales = false` is STRICTER than "appears under Sales here", because the sales leg
    // also demands office membership or an owned deal in this tenant. A multi-office person flagged for
    // sales globally, with neither of those here but estimating a deal here, fell out of the sales leg for
    // want of membership AND out of this one for holding the flag — landing in NEITHER section, the exact
    // opposite of the one-person-one-section rule. Negating the sales leg's own predicate is what keeps
    // the two legs asking the same question.
    const { sql } = await runRoster([], "office-1");
    // Scoped to the ESTIMATOR ARM. Asserting against the whole statement is what made the first version of
    // this test vacuous: the SALES leg carries its own `left join deal_owners`, so a whole-SQL toContain
    // passed even with the join deleted from the estimator arm — which would leave that arm referencing an
    // unjoined owner_rows, i.e. a hard SQL error no mocked-execute test can see.
    const estimatorArm = sql.slice(sql.indexOf("'estimator' as grp"));

    // The negation must carry the MEMBERSHIP test with it, not just the flag.
    expect(estimatorArm).toContain("not (u.generates_sales = true and (");
    expect(estimatorArm).toContain("owner_rows.rep_id is not null");
    expect(estimatorArm).toContain("left join deal_owners owner_rows on owner_rows.rep_id = u.id");
  });

  it("widens estimator office membership by estimating here, mirroring the owner leg", async () => {
    // Membership still comes from the FLAG; this only lets someone estimating in this tenant qualify
    // without an office row, exactly as owner_rows does on the sales side.
    const { sql } = await runRoster([], "office-1");

    expect(sql).toContain("est_rows.rep_id is not null");
  });

  it("maps the estimator group through from the SQL, not from a JS re-derivation", async () => {
    const { result } = await runRoster([
      { id: "u1", display_name: "Timothy Mitchell", grp: "sales" },
      { id: "u2", display_name: "Sidney Gibson", grp: "estimator" },
    ]);

    expect(result).toEqual([
      { id: "u1", displayName: "Timothy Mitchell", group: "sales" },
      { id: "u2", displayName: "Sidney Gibson", group: "estimator" },
    ]);
  });

  it("treats an unrecognised grp as sales rather than dropping the person", async () => {
    // The client renders two sections; a group it does not know would put this row in neither.
    const { result } = await runRoster([{ id: "u1", display_name: "Alex Koch", grp: "something-else" }]);

    expect(result).toEqual([{ id: "u1", displayName: "Alex Koch", group: "sales" }]);
  });
});
