import { describe, expect, it, vi } from "vitest";

vi.mock("../db.js", () => ({
  pool: {
    connect: vi.fn(),
    query: vi.fn(),
  },
}));

import { advanceNextRunAt } from "./reports-execution.js";

describe("reports execution month-end anchors", () => {
  it("restores the original monthly anchor after a clamped February run", () => {
    const february = advanceNextRunAt(
      new Date("2026-01-31T09:00:00.000Z"),
      "monthly",
      new Date("2026-01-31T09:05:00.000Z"),
      31
    );
    const march = advanceNextRunAt(
      february,
      "monthly",
      new Date("2026-02-28T09:05:00.000Z"),
      31
    );

    expect(february.toISOString()).toBe("2026-02-28T09:00:00.000Z");
    expect(march.toISOString()).toBe("2026-03-31T09:00:00.000Z");
  });

  it("keeps a 31st monthly schedule anchored through a full year", () => {
    const expected = [
      "2026-02-28T09:00:00.000Z",
      "2026-03-31T09:00:00.000Z",
      "2026-04-30T09:00:00.000Z",
      "2026-05-31T09:00:00.000Z",
      "2026-06-30T09:00:00.000Z",
      "2026-07-31T09:00:00.000Z",
      "2026-08-31T09:00:00.000Z",
      "2026-09-30T09:00:00.000Z",
      "2026-10-31T09:00:00.000Z",
      "2026-11-30T09:00:00.000Z",
      "2026-12-31T09:00:00.000Z",
      "2027-01-31T09:00:00.000Z",
    ];
    const actual: string[] = [];
    let nextRun = new Date("2026-01-31T09:00:00.000Z");

    for (const expectedIso of expected) {
      nextRun = advanceNextRunAt(nextRun, "monthly", new Date(nextRun.getTime() + 60_000), 31);
      actual.push(nextRun.toISOString());
      expect(nextRun.toISOString()).toBe(expectedIso);
    }

    expect(actual).toEqual(expected);
  });

  it("restores the original quarterly anchor after a clamped February run", () => {
    const next = advanceNextRunAt(
      new Date("2026-02-28T09:00:00.000Z"),
      "quarterly",
      new Date("2026-02-28T09:05:00.000Z"),
      31
    );

    expect(next.toISOString()).toBe("2026-05-31T09:00:00.000Z");
  });
});
