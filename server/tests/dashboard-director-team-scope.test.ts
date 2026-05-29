import { describe, it, expect } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { dealScopeFilterSql, leadScopeFilterSql } from "../src/modules/dashboard/service.js";

// Renders a Drizzle SQL fragment to parameterized text + params, so we can
// assert on the scope predicate without touching a database.
const dialect = new PgDialect();
const render = (fragment: ReturnType<typeof dealScopeFilterSql>) => dialect.sqlToQuery(fragment);

describe("director scope filters: Team scope (bug #9 part 2)", () => {
  it("Team scope filters deals to the team rep-ids, distinct from All", () => {
    const team = render(dealScopeFilterSql("d", { repIds: ["rep-1", "rep-2"] }));
    const all = render(dealScopeFilterSql("d", {}));

    // Team must produce an explicit assigned_rep_id IN (...) predicate bound to
    // the team rep-ids — NOT collapse to the empty (All) fragment.
    expect(team.sql.toLowerCase()).toContain("assigned_rep_id in");
    expect(team.params).toEqual(["rep-1", "rep-2"]);
    expect(all.sql.trim()).toBe("");
    expect(team.sql.trim()).not.toBe(all.sql.trim());
  });

  it("Team scope filters leads to the team rep-ids", () => {
    const team = render(leadScopeFilterSql("l", { repIds: ["rep-1"] }));
    expect(team.sql.toLowerCase()).toContain("assigned_rep_id in");
    expect(team.params).toEqual(["rep-1"]);
  });

  it("an empty team resolves to a no-rows filter, not All", () => {
    const emptyTeam = render(dealScopeFilterSql("d", { repIds: [] }));
    expect(emptyTeam.sql.trim()).not.toBe("");
    expect(emptyTeam.sql.toLowerCase()).toContain("false");
  });

  it("All scope (no scope fields) applies no rep filter — unchanged", () => {
    expect(render(dealScopeFilterSql("d", {})).sql.trim()).toBe("");
    expect(render(leadScopeFilterSql("l", {})).sql.trim()).toBe("");
  });
});
