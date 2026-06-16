import { describe, expect, it } from "vitest";
import { getWtdPeriod } from "../../src/lib/period.js";

// MTD / YTD showcase-toggle windows (Item 3). The CRITICAL reconciliation requirement is that the new
// server-side bounds are BYTE-IDENTICAL to the client's resolveDatePreset
// (client/src/lib/pipeline-terminal-filters.ts), so the B2 Leaderboard's Won numbers tie to the Deals
// Dashboard for the same preset. Rather than import client code into the server test (different vitest
// project / alias), this `oracle` reproduces resolveDatePreset's mtd/ytd math EXACTLY (copied line for
// line). The sweep below asserts getWtdPeriod equals that oracle for many instants, including the CT
// cross-tz boundary. If F1 ever drifts off the client definition, this fails.

const BUSINESS_TIMEZONE = "America/Chicago";

// --- byte-for-byte copy of resolveDatePreset's helpers + mtd/ytd branches ---
function oracleBusinessToday(now: Date): string {
  return now.toLocaleDateString("en-CA", { timeZone: BUSINESS_TIMEZONE });
}
function oracleYmdParts(isoDate: string): { year: number; month: number } {
  const d = new Date(`${isoDate}T12:00:00Z`);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() };
}
function oracleYmdToParam(year: number, month: number, day: number): string {
  return new Date(Date.UTC(year, month, day, 12)).toISOString().slice(0, 10);
}
function oracleResolve(preset: "mtd" | "ytd", now: Date): { from: string; to: string } {
  const today = oracleBusinessToday(now);
  const { year, month } = oracleYmdParts(today);
  if (preset === "mtd") return { from: oracleYmdToParam(year, month, 1), to: today };
  return { from: `${year}-01-01`, to: today };
}

describe("getWtdPeriod — MTD / YTD (America/Chicago), byte-identical to client resolveDatePreset", () => {
  it("mtd: from = first-of-month (CT), to = today (CT)", () => {
    // Thursday 2026-06-11 13:00 CT
    expect(getWtdPeriod("mtd", new Date("2026-06-11T18:00:00Z"))).toEqual({ from: "2026-06-01", to: "2026-06-11" });
    // on the 1st itself, from == to
    expect(getWtdPeriod("mtd", new Date("2026-06-01T18:00:00Z"))).toEqual({ from: "2026-06-01", to: "2026-06-01" });
    // January (single-digit month padding)
    expect(getWtdPeriod("mtd", new Date("2026-01-15T18:00:00Z"))).toEqual({ from: "2026-01-01", to: "2026-01-15" });
  });

  it("ytd: from = Jan-1 (CT), to = today (CT)", () => {
    expect(getWtdPeriod("ytd", new Date("2026-06-11T18:00:00Z"))).toEqual({ from: "2026-01-01", to: "2026-06-11" });
    expect(getWtdPeriod("ytd", new Date("2026-01-01T18:00:00Z"))).toEqual({ from: "2026-01-01", to: "2026-01-01" });
  });

  it("anchors on the BUSINESS tz (CT), not UTC — cross-tz boundary", () => {
    // 2026-06-01T02:00:00Z is June 1 in UTC but still May 31 21:00 in CT. CT-anchoring keeps mtd in May.
    expect(getWtdPeriod("mtd", new Date("2026-06-01T02:00:00Z"))).toEqual({ from: "2026-05-01", to: "2026-05-31" });
    // First instant of a new YEAR in CT vs UTC: 2026-01-01T02:00:00Z is still 2025-12-31 in CT.
    expect(getWtdPeriod("ytd", new Date("2026-01-01T02:00:00Z"))).toEqual({ from: "2025-01-01", to: "2025-12-31" });
  });

  it("equals the client resolveDatePreset oracle across a date sweep (incl. month/year/tz boundaries)", () => {
    const instants = [
      "2026-01-01T02:00:00Z", // CT 2025-12-31
      "2026-01-01T18:00:00Z",
      "2026-02-28T18:00:00Z",
      "2026-03-01T05:30:00Z",
      "2026-06-11T18:00:00Z",
      "2026-06-30T18:00:00Z",
      "2026-07-01T02:00:00Z", // CT 2026-06-30
      "2026-12-31T18:00:00Z",
    ];
    for (const iso of instants) {
      const now = new Date(iso);
      expect({ iso, ...getWtdPeriod("mtd", now) }).toEqual({ iso, ...oracleResolve("mtd", now) });
      expect({ iso, ...getWtdPeriod("ytd", now) }).toEqual({ iso, ...oracleResolve("ytd", now) });
    }
  });
});
