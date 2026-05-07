import { describe, expect, it, vi } from "vitest";

vi.mock("../db.js", () => ({
  pool: {
    connect: vi.fn(),
    query: vi.fn(),
  },
}));

import { nextRunAt } from "./reports-execution.js";

describe("reports execution schedule math", () => {
  it("clamps monthly schedules to the target month's last day", () => {
    const next = nextRunAt(new Date("2026-01-31T09:00:00.000Z"), "monthly");

    expect(next.toISOString()).toBe("2026-02-28T09:00:00.000Z");
  });
});
