import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  existingLockedReports: [] as Array<{ name: string }>,
  insertedValues: [] as any[],
}));

vi.mock("../../../src/db.js", () => {
  const selectChain = {
    from() {
      return this;
    },
    where() {
      return this;
    },
    then(resolve: (value: unknown) => void) {
      resolve(state.existingLockedReports);
    },
  };

  const insertChain = {
    values(values: any[]) {
      state.insertedValues = values;
      return {
        then(resolve: (value: unknown) => void) {
          resolve([]);
        },
      };
    },
  };

  return {
    db: {
      select: vi.fn(() => selectChain),
      insert: vi.fn(() => insertChain),
    },
  };
});

import { seedLockedReports } from "../../../src/modules/reports/saved-reports-service.js";

describe("seedLockedReports", () => {
  beforeEach(() => {
    state.existingLockedReports = [];
    state.insertedValues = [];
    vi.clearAllMocks();
  });

  it("inserts only missing locked presets when an office already has locked reports", async () => {
    state.existingLockedReports = [
      { name: "Pipeline Summary (Excluding DD)" },
      { name: "Activity Summary by Rep" },
    ];

    await seedLockedReports("office-1");

    expect(state.insertedValues).toHaveLength(10);
    expect(state.insertedValues.map((row) => row.name)).toContain("Unified Workflow Overview");
    expect(state.insertedValues.map((row) => row.name)).not.toContain("Pipeline Summary (Excluding DD)");
    expect(state.insertedValues.map((row) => row.name)).not.toContain("Activity Summary by Rep");
  });

  it("does not seed duplicates when all locked presets already exist", async () => {
    state.existingLockedReports = [
      { name: "Unified Workflow Overview" },
      { name: "Pipeline Summary (Excluding DD)" },
      { name: "Pipeline Summary (With DD)" },
      { name: "Weighted Pipeline Forecast" },
      { name: "Win/Loss Ratio by Rep" },
      { name: "Activity Summary by Rep" },
      { name: "Stale Deals Report" },
      { name: "Lost Deals by Reason" },
      { name: "Revenue by Project Type" },
      { name: "Lead Source ROI" },
      { name: "Closed-Won Summary" },
      { name: "Pipeline by Rep" },
    ];

    await seedLockedReports("office-1");

    expect(state.insertedValues).toHaveLength(0);
  });
});
