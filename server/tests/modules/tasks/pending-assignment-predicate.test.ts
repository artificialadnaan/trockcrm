// Properties of the shared predicate that are about the TEXT it renders, not the rows it selects.
//
// The row behaviour is proved against real SQL in pending-assignment-acknowledgement.runtime.test.ts
// (tenant side) and pending-task-assignment-flag.runtime.test.ts (auth side). What is left here is the
// pair of hazards that only exist because this one fragment is rendered into two different execution
// paths — a Drizzle tenant connection and a raw node-postgres pool.
import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { buildPendingAssignmentPredicate } from "../../../src/modules/tasks/pending-assignment-predicate.js";

const dialect = new PgDialect();
const USER = "11111111-1111-1111-1111-111111111111";

function render(schema?: string) {
  return dialect.sqlToQuery(
    buildPendingAssignmentPredicate({ userId: USER, todayCt: "2026-08-24", schema })
  );
}

describe("buildPendingAssignmentPredicate", () => {
  // A `--` comment survives only as long as the newline after it. This fragment is concatenated into a
  // larger query on the auth side; anything that collapsed it to one line would comment out everything
  // after the first `--`, and a predicate that silently disappears means a modal listing every task in
  // the office. Line comments are therefore banned outright rather than relied upon to keep a newline.
  it("renders no line comments, so collapsing the SQL to one line cannot neuter it", () => {
    expect(render().sql).not.toContain("--");
    expect(render("office_dallas").sql).not.toContain("--");
  });

  it("binds every value rather than interpolating it", () => {
    const { sql, params } = render();
    expect(params).toContain(USER);
    expect(params).toContain("2026-08-24");
    expect(sql).not.toContain(USER);
    expect(sql).not.toContain("2026-08-24");
  });

  // The relation must stay named `tasks`, unaliased: taskPriorityRankSql() renders its CASE over
  // `"tasks"."priority"`, so an alias here would break the ORDER BY of the query that uses it.
  it("references the tasks relation unaliased, so the shared priority rank still resolves", () => {
    expect(render().sql).toContain('"tasks"."assigned_to"');
    expect(render().sql).toContain('"tasks"."priority"');
  });

  it("qualifies ONLY the acknowledgement table when given a schema", () => {
    const qualified = render("office_atlanta").sql;
    expect(qualified).toContain('"office_atlanta".task_assignment_acknowledgements');
    // The tasks relation is qualified by the CALLER's FROM clause, not here — the auth side says
    // `FROM "office_atlanta".tasks` and the tenant side relies on search_path.
    expect(qualified).not.toContain('"office_atlanta".tasks');
  });

  it("leaves the acknowledgement table unqualified when no schema is given", () => {
    const unqualified = render().sql;
    expect(unqualified).toContain("FROM task_assignment_acknowledgements");
    expect(unqualified).not.toContain('".task_assignment_acknowledgements');
  });

  // The schema name cannot be a bound parameter — an identifier never can — so it is the one value in
  // the fragment that is interpolated. Today it comes from public.offices.slug and is not user input;
  // the day somebody adds an office-creation form, this is the guard that has to already be there.
  it("refuses a schema name that is not a well-formed office schema", () => {
    for (const bad of [
      "public",
      "office_dallas; DROP TABLE tasks",
      'office_"dallas',
      "office_Dallas",
      "",
    ]) {
      expect(() => render(bad), bad).toThrow(/Refusing to build a tenant predicate/);
    }
  });

  it("accepts the schema names offices actually get", () => {
    expect(() => render("office_dallas")).not.toThrow();
    expect(() => render("office_fort_worth2")).not.toThrow();
  });
});
