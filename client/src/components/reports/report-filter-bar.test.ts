import { describe, expect, it } from "vitest";
import { subtractMonthsClamped } from "./report-filter-bar";

describe("report filter date math", () => {
  it("clamps the day of month when subtracting months", () => {
    const result = subtractMonthsClamped(new Date(2026, 9, 31), 6);

    expect(result.getFullYear()).toBe(2026);
    expect(result.getMonth()).toBe(3);
    expect(result.getDate()).toBe(30);
  });
});
