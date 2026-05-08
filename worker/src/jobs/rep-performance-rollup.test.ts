import { describe, expect, it, vi } from "vitest";

vi.mock("../db.js", () => ({
  pool: {
    connect: vi.fn(),
  },
}));

import { buildRepPerformancePeriodRanges } from "./rep-performance-rollup.js";

describe("rep performance rollup period ranges", () => {
  it("uses UTC month boundaries without overflowing end-of-month dates", () => {
    const ranges = buildRepPerformancePeriodRanges(new Date("2026-03-31T23:30:00.000Z"));
    const lastMonth = ranges.find((range) => range.kind === "last_month");

    expect(lastMonth).toEqual({
      kind: "last_month",
      start: "2026-02-01",
      end: "2026-02-28",
    });
  });

  it("uses UTC quarter boundaries across year changes", () => {
    const ranges = buildRepPerformancePeriodRanges(new Date("2026-01-31T09:00:00.000Z"));
    const qtd = ranges.find((range) => range.kind === "qtd");
    const lastQuarter = ranges.find((range) => range.kind === "last_quarter");

    expect(qtd).toEqual({
      kind: "qtd",
      start: "2026-01-01",
      end: "2026-01-31",
    });
    expect(lastQuarter).toEqual({
      kind: "last_quarter",
      start: "2025-10-01",
      end: "2025-12-31",
    });
  });
});
