import { describe, expect, it } from "vitest";

const {
  TEST_DATA_MARKER,
  isMarkedTestDataRow,
  summarizeCleanupRows,
} = await import("../../../scripts/cleanupTestData.js");

describe("cleanup test data helpers", () => {
  it("identifies only explicit TEST DATA marker rows", () => {
    expect(TEST_DATA_MARKER).toBe("[TEST DATA]");
    expect(isMarkedTestDataRow({ is_test_data: true })).toBe(true);
    expect(isMarkedTestDataRow({ description: "[TEST DATA] seeded lead" })).toBe(true);
    expect(isMarkedTestDataRow({ notes: "[TEST DATA] seeded company" })).toBe(true);
    expect(isMarkedTestDataRow({ name: "Test Customer A" })).toBe(false);
    expect(isMarkedTestDataRow({ description: "ordinary production record" })).toBe(false);
  });

  it("summarizes cleanup rows without counting unmarked records", () => {
    const summary = summarizeCleanupRows([
      { table: "office_dallas.deals", id: "marked-deal", description: "[TEST DATA] deal" },
      { table: "office_dallas.deals", id: "real-deal", description: "real deal" },
      { table: "office_dallas.leads", id: "marked-lead", is_test_data: true },
      { table: "office_dallas.tasks", id: "marked-task", title: "[TEST DATA] follow up" },
    ]);

    expect(summary.total).toBe(3);
    expect(summary.byTable).toEqual({
      "office_dallas.deals": 1,
      "office_dallas.leads": 1,
      "office_dallas.tasks": 1,
    });
    expect(summary.ids).toEqual(["marked-deal", "marked-lead", "marked-task"]);
  });
});
