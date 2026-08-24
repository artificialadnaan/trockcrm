// The decide UPDATE's still-undecided guard, asserted on the SQL that actually reaches the database.
//
// WHY THIS IS A SQL-TEXT TEST AND NOT A BEHAVIOUR TEST. `decideMarketingExpenseRequest` reads the approval
// rows, works out which step is actionable, and only then issues the UPDATE. In a sequential test that
// pre-check answers every case, so DELETING `isNull(decision)` from the UPDATE leaves all 55 behaviour
// assertions in service.runtime.test.ts green — verified by mutation. The clause only does anything when a
// second transaction commits BETWEEN this one's read and its write, and this repo has no harness that can
// produce that: all 264 PGlite suites share one in-process connection, and not one uses a real pg.Pool.
//
// So the honest test is of the artifact: the predicate handed to Postgres still carries the guard. That
// cannot prove the race is handled, and it is not claimed to. It can prove the guard was not quietly
// dropped, which is the failure mode that would otherwise ship green.
import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { undecidedStepWhere } from "../../../src/modules/marketing-expense/service.js";

const dialect = new PgDialect();
const rendered = () => dialect.sqlToQuery(undecidedStepWhere("req-1", 2));

describe("undecidedStepWhere", () => {
  it("keeps the still-undecided clause in the predicate", () => {
    expect(rendered().sql).toMatch(/"decision" is null/i);
  });

  it("scopes to the request, not to the approval row's own id — `:id` is the REQUEST", () => {
    const { sql, params } = rendered();
    expect(sql).toContain('"request_id"');
    expect(sql).not.toContain('"marketing_expense_request_approvals"."id"');
    expect(params).toContain("req-1");
  });

  it("scopes to ONE step, so a decision cannot land on every open step at once", () => {
    const { sql, params } = rendered();
    expect(sql).toContain('"step_order"');
    expect(params).toContain(2);
  });

  it("ANDs all three — an OR would make the guard decorative", () => {
    const { sql } = rendered();
    expect(sql).toContain("and");
    expect(sql).not.toContain(" or ");
  });
});
