// The runner's CONCURRENTLY pre-step for 0237.
//
// The pre-step exists so API boot never holds a write-blocking lock on `tasks` across every office at
// once (see task-source-index.ts). Two things about it are worth a test rather than a reading: the
// statement it builds must actually say CONCURRENTLY on the right columns, and the schema name it
// interpolates must be validated — it is the one value in the file that comes from the database rather
// than from source, and it lands in a string that cannot be parameterised.
import { describe, expect, it } from "vitest";
import {
  TASK_SOURCE_INDEX_MIGRATION,
  TASK_SOURCE_INDEX_NAME,
  buildTaskSourceIndexStatement,
} from "../../src/migrations/task-source-index.js";

describe("0237 task-source index pre-step", () => {
  // If this drifts the runner silently stops intercepting and the plain CREATE INDEX in the file runs
  // inline again — the exact lock-on-boot this pre-step was added to avoid, with nothing to signal it.
  it("names the migration file the runner dispatches on", () => {
    expect(TASK_SOURCE_INDEX_MIGRATION).toBe("0237_tasks_assigned_source_status_index.sql");
  });

  it("builds the index CONCURRENTLY, on the columns the file declares", () => {
    const statement = buildTaskSourceIndexStatement("office_dallas");

    expect(statement).toContain("CREATE INDEX CONCURRENTLY IF NOT EXISTS");
    expect(statement).toContain(TASK_SOURCE_INDEX_NAME);
    expect(statement).toContain('"office_dallas".tasks (assigned_to, source, status, due_date)');
  });

  it("rejects a schema name that is not a well-formed office schema", () => {
    for (const bad of [
      'office_dallas"; DROP TABLE tasks; --',
      "public",
      "office_",
      "Office_Dallas",
      "office_dallas; SELECT 1",
    ]) {
      expect(() => buildTaskSourceIndexStatement(bad), bad).toThrow(/Invalid office schema name/);
    }
  });

  it("accepts the office schema shapes that really exist", () => {
    for (const good of ["office_dallas", "office_fort_worth", "office_a1"]) {
      expect(() => buildTaskSourceIndexStatement(good), good).not.toThrow();
    }
  });
});
