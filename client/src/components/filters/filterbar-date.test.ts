import { describe, expect, it } from "vitest";
import { resolveDateWindow, dateFilterFromValue } from "./filterbar-date";

// Wednesday 2026-05-27 (noon UTC for tz-robustness); the most recent Sunday is 2026-05-24.
const NOW = new Date(Date.UTC(2026, 4, 27, 12));

describe("resolveDateWindow (date control TerminalDateFilter -> contract dateFrom/dateTo/datePreset)", () => {
  it("all-time emits no window (just the preset, so no date param is sent)", () => {
    expect(resolveDateWindow({ preset: "all" }, NOW)).toEqual({ datePreset: "all" });
  });

  it("wtd resolves to the Sunday-anchored window", () => {
    expect(resolveDateWindow({ preset: "wtd" }, NOW)).toEqual({
      datePreset: "wtd",
      dateFrom: "2026-05-24",
      dateTo: "2026-05-27",
    });
  });

  it("a rolling preset resolves to daysAgo(N)..today", () => {
    expect(resolveDateWindow({ preset: "30" }, NOW)).toEqual({
      datePreset: "30",
      dateFrom: "2026-04-27",
      dateTo: "2026-05-27",
    });
  });

  it("custom passes the explicit bounds through", () => {
    expect(
      resolveDateWindow({ preset: "custom", customStart: "2026-05-01", customEnd: "2026-05-10" }, NOW)
    ).toEqual({ datePreset: "custom", dateFrom: "2026-05-01", dateTo: "2026-05-10" });
  });
});

describe("dateFilterFromValue (FilterBar value -> date control filter)", () => {
  it("maps an absent preset to all-time", () => {
    expect(dateFilterFromValue({})).toEqual({ preset: "all" });
  });
  it("maps a named preset back to {preset}", () => {
    expect(dateFilterFromValue({ datePreset: "mtd", dateFrom: "2026-05-01", dateTo: "2026-05-27" })).toEqual({
      preset: "mtd",
    });
  });
  it("reconstructs a custom range from the bounds", () => {
    expect(dateFilterFromValue({ datePreset: "custom", dateFrom: "2026-05-01", dateTo: "2026-05-10" })).toEqual({
      preset: "custom",
      customStart: "2026-05-01",
      customEnd: "2026-05-10",
    });
  });
});
