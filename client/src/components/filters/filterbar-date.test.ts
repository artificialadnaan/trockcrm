import { describe, expect, it } from "vitest";
import { resolveDateWindow, dateFilterFromValue, withResolvedDateWindow } from "./filterbar-date";

// Wednesday 2026-05-27 (noon UTC for tz-robustness); the most recent Sunday is 2026-05-24.
const NOW = new Date(Date.UTC(2026, 4, 27, 12));

describe("resolveDateWindow (date control TerminalDateFilter -> contract dateFrom/dateTo/datePreset)", () => {
  it("all-time emits an EXPLICIT empty window so switching clears a prior window", () => {
    const window = resolveDateWindow({ preset: "all" }, NOW);
    expect(window.datePreset).toBe("all");
    // Keys must be PRESENT (undefined), not omitted, or mergeFilterParams' spread keeps stale bounds.
    expect("dateFrom" in window).toBe(true);
    expect("dateTo" in window).toBe(true);
    expect(window.dateFrom).toBeUndefined();
    expect(window.dateTo).toBeUndefined();
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

  it("omits customEnd (no undefined-valued key) when the custom range is open-ended", () => {
    const filter = dateFilterFromValue({ datePreset: "custom", dateFrom: "2026-05-01" });
    expect(filter).toEqual({ preset: "custom", customStart: "2026-05-01" });
    expect("customEnd" in filter).toBe(false);
  });

  it("falls back to all-time when there is no window at all", () => {
    expect(dateFilterFromValue({ datePreset: "custom" })).toEqual({ preset: "all" });
    expect(dateFilterFromValue({ datePreset: "bogus" })).toEqual({ preset: "all" });
    expect(dateFilterFromValue({})).toEqual({ preset: "all" });
  });

  it("shows a stale/unrecognized preset that still carries bounds as the custom window (not 'all')", () => {
    expect(dateFilterFromValue({ datePreset: "bogus", dateFrom: "2026-05-01", dateTo: "2026-05-10" })).toEqual({
      preset: "custom",
      customStart: "2026-05-01",
      customEnd: "2026-05-10",
    });
  });
});

describe("withResolvedDateWindow (re-resolve relative presets on read)", () => {
  it("re-resolves a relative preset to a fresh window, dropping stale bookmarked bounds", () => {
    expect(
      withResolvedDateWindow({ datePreset: "30", dateFrom: "2020-01-01", dateTo: "2020-01-02" }, NOW)
    ).toEqual({ datePreset: "30", dateFrom: "2026-04-27", dateTo: "2026-05-27" });
  });

  it("clears the window for an all-time preset", () => {
    expect(withResolvedDateWindow({ datePreset: "all", dateFrom: "2020-01-01", dateTo: "2020-01-02" }, NOW)).toEqual({
      datePreset: "all",
    });
  });

  it("leaves a custom window and a preset-less value untouched", () => {
    const custom = { datePreset: "custom", dateFrom: "2026-05-01", dateTo: "2026-05-10" };
    expect(withResolvedDateWindow(custom, NOW)).toEqual(custom);
    expect(withResolvedDateWindow({ search: "x" }, NOW)).toEqual({ search: "x" });
  });
});
