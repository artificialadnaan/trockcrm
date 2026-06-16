import { describe, expect, it } from "vitest";
import { rollupTopN } from "./sales-report-ui";

// The Revenue-by-Region chart caps to the top-15 regions and rolls the long tail (~46 regions in prod after
// the server case-folds spelling variants) into a single "Other" bar. The data table keeps the full list, so
// the chart's bars + Other must reconcile EXACTLY to the table's total. These tests lock that arithmetic.
describe("rollupTopN (chart top-N + Other rollup)", () => {
  const regions = Array.from({ length: 20 }, (_, i) => ({
    regionName: `Region ${i + 1}`,
    totalRevenue: (20 - i) * 1000, // descending: 20000, 19000, ... 1000
  }));

  it("keeps the top-N rows and folds the remainder into one Other bucket", () => {
    const out = rollupTopN(regions, "regionName", "totalRevenue", 15);
    expect(out.length).toBe(16); // 15 + Other
    expect(out[15].regionName).toBe("Other (5)");
    // Tail = regions 16..20 -> revenue 5000+4000+3000+2000+1000 = 15000.
    expect(out[15].totalRevenue).toBe(15000);
  });

  it("reconciles: chart total equals the full-list total", () => {
    const fullTotal = regions.reduce((acc, r) => acc + r.totalRevenue, 0);
    const out = rollupTopN(regions, "regionName", "totalRevenue", 15);
    const chartTotal = out.reduce((acc, r) => acc + Number(r.totalRevenue), 0);
    expect(chartTotal).toBe(fullTotal);
  });

  it("sorts by value before capping, so the largest regions are the bars that survive", () => {
    const shuffled = [
      { regionName: "Small", totalRevenue: 10 },
      { regionName: "Big", totalRevenue: 1000 },
      { regionName: "Mid", totalRevenue: 100 },
    ];
    const out = rollupTopN(shuffled, "regionName", "totalRevenue", 2);
    expect(out.map((r) => r.regionName)).toEqual(["Big", "Mid", "Other (1)"]);
    expect(out[2].totalRevenue).toBe(10);
  });

  it("returns the data unchanged when there are <= N rows (no Other bar)", () => {
    const few = regions.slice(0, 5);
    const out = rollupTopN(few, "regionName", "totalRevenue", 15);
    expect(out).toBe(few);
    expect(out.some((r) => String(r.regionName).startsWith("Other"))).toBe(false);
  });
});
