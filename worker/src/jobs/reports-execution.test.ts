import { describe, expect, it, vi } from "vitest";

vi.mock("../db.js", () => ({
  pool: {
    connect: vi.fn(),
    query: vi.fn(),
  },
}));

import { advanceNextRunAt, nextRunAt } from "./reports-execution.js";

describe("reports execution schedule math", () => {
  it("clamps monthly schedules to the target month's last day", () => {
    const next = nextRunAt(new Date("2026-01-31T09:00:00.000Z"), "monthly");

    expect(next.toISOString()).toBe("2026-02-28T09:00:00.000Z");
  });

  it("preserves daily cadence when the worker runs late", () => {
    const next = advanceNextRunAt(
      new Date("2026-05-07T09:00:00.000Z"),
      "daily",
      new Date("2026-05-07T09:05:00.000Z")
    );

    expect(next.toISOString()).toBe("2026-05-08T09:00:00.000Z");
  });

  it("catches up missed cycles to the next future cadence slot", () => {
    const next = advanceNextRunAt(
      new Date("2026-05-01T09:00:00.000Z"),
      "daily",
      new Date("2026-05-07T09:05:00.000Z")
    );

    expect(next.toISOString()).toBe("2026-05-08T09:00:00.000Z");
  });
});
