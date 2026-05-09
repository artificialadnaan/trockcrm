import { describe, expect, it, vi } from "vitest";
import { presetToDateRange } from "./use-director-dashboard";

describe("presetToDateRange", () => {
  it("derives commission date presets from UTC calendar boundaries", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-01T01:00:00.000Z"));

    expect(presetToDateRange("mtd")).toEqual({ from: "2026-03-01", to: "2026-03-01" });
    expect(presetToDateRange("qtd")).toEqual({ from: "2026-01-01", to: "2026-03-01" });
    expect(presetToDateRange("ytd")).toEqual({ from: "2026-01-01", to: "2026-03-01" });
    expect(presetToDateRange("last_month")).toEqual({ from: "2026-02-01", to: "2026-02-28" });

    vi.useRealTimers();
  });
});
