// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  getDashboardPeriodDateRange,
  getTerminalDateRange,
  getEstimateSentDateRange,
  getWonMetricTerminalLabel,
  readEstimateSentDateFilterFromSearchParams,
} from "./deal-list-page";

// D-7: ONE platform-wide week definition = Sunday->Saturday. The dashboard "week" period
// (rep-dashboard Week tab / drilldowns) must anchor to Sunday, never Monday.
describe("getDashboardPeriodDateRange week (Sunday-anchored, D-7)", () => {
  it("anchors the week period to the most recent Sunday from a midweek reference", () => {
    // 2026-05-27 is a Wednesday; Sunday-anchored start is 2026-05-24 (Monday-anchored would be 2026-05-25).
    const now = new Date(2026, 4, 27);
    expect(getDashboardPeriodDateRange("week", now)).toEqual({ from: "2026-05-24", to: "2026-05-27" });
  });

  it("returns the same day when the reference is already a Sunday", () => {
    const now = new Date(2026, 4, 24);
    expect(getDashboardPeriodDateRange("week", now)).toEqual({ from: "2026-05-24", to: "2026-05-24" });
  });
});

// Codex finding 1: a URL like ?won_preset=wtd now round-trips to {preset:"wtd"}; the
// terminal/estimate-sent range mappers must resolve it (not Number("wtd") -> NaN).
describe("terminal date-range mappers handle the wtd preset (no NaN)", () => {
  it("getTerminalDateRange resolves wtd to the Sunday-anchored window", () => {
    const now = new Date(Date.UTC(2026, 4, 27, 12)); // Wed (UTC); most recent Sunday = 2026-05-24
    expect(getTerminalDateRange({ preset: "wtd" }, now)).toEqual({ from: "2026-05-24", to: "2026-05-27" });
  });

  it("getEstimateSentDateRange resolves wtd to the Sunday-anchored window", () => {
    const now = new Date(Date.UTC(2026, 4, 27, 12));
    expect(getEstimateSentDateRange({ preset: "wtd" }, now)).toEqual({ from: "2026-05-24", to: "2026-05-27" });
  });
});

// Codex round-2: wtd must also be accepted by the estimate-sent preset allow-list and labeled
// correctly by the won-metric caption (not "Last wtd days").
describe("deal-list-page preset handling for wtd", () => {
  it("getWonMetricTerminalLabel labels wtd as WTD", () => {
    expect(getWonMetricTerminalLabel({ preset: "wtd" })).toBe("WTD");
  });

  it("readEstimateSentDateFilterFromSearchParams accepts estimate_sent_preset=wtd", () => {
    const params = new URLSearchParams("estimate_sent_preset=wtd");
    expect(readEstimateSentDateFilterFromSearchParams(params)).toEqual({ preset: "wtd" });
  });
});
