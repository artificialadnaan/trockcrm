import { describe, expect, it } from "vitest";
import { getWtdPeriod, sundayWeekBucketSql, BUSINESS_TIMEZONE } from "../../src/lib/period.js";

// F1 -- the single canonical Sunday-Saturday WTD period helper (#539), business-tz anchored. Two end
// modes in one helper: "to_date" (live dashboard) and "completed" (prior Sun-Sat box, Monday reports).
// Anchor reference (verified): 2026-05-24 and 2026-05-31 are Sundays; 2026-05-23 and 2026-05-30 Saturdays.
describe("getWtdPeriod -- canonical Sunday-Saturday WTD (America/Chicago)", () => {
  it("week-to-date: from = most-recent Sunday, to = today (CT)", () => {
    // Thursday 2026-05-28
    expect(getWtdPeriod("to_date", new Date("2026-05-28T18:00:00Z"))).toEqual({ from: "2026-05-24", to: "2026-05-28" });
    // on the Sunday itself, from == to == that Sunday
    expect(getWtdPeriod("to_date", new Date("2026-05-24T18:00:00Z"))).toEqual({ from: "2026-05-24", to: "2026-05-24" });
    // on the Saturday (week end), to = Saturday
    expect(getWtdPeriod("to_date", new Date("2026-05-30T18:00:00Z"))).toEqual({ from: "2026-05-24", to: "2026-05-30" });
  });

  it("completed: the full PRIOR Sun-Sat box", () => {
    // Thursday 2026-05-28 -> prior week is Sun 05-17 .. Sat 05-23
    expect(getWtdPeriod("completed", new Date("2026-05-28T18:00:00Z"))).toEqual({ from: "2026-05-17", to: "2026-05-23" });
    // on a Sunday (start of a new week), "completed" is the week that just ended
    expect(getWtdPeriod("completed", new Date("2026-05-24T18:00:00Z"))).toEqual({ from: "2026-05-17", to: "2026-05-23" });
  });

  it("anchors on the BUSINESS tz (CT), not the server/UTC date", () => {
    // 2026-05-31T02:00:00Z is Sunday in UTC but still Sat 2026-05-30 21:00 in CT. A UTC reading would
    // start a brand-new week (from==to==2026-05-31); CT-anchoring correctly stays in the current week.
    expect(getWtdPeriod("to_date", new Date("2026-05-31T02:00:00Z"))).toEqual({ from: "2026-05-24", to: "2026-05-30" });
  });
});

// RECONCILIATION: F1 must match the canonical platform week definition that #539 standardized on --
// the Sunday-anchored week-to-date (client toDatePresetRange("wtd"): walk back to the most-recent
// Sunday, run to today). This table is the canonical oracle; if F1 ever drifts off Sunday anchoring
// it breaks here. (The dashboard's OTHER "week" notions -- rep-activity rolling-7-day, reports-module
// Monday-ISO grouping, worker UTC snapshots -- intentionally DIVERGE and are flagged to align to F1,
// not the reverse. The protected Won aggregate is scoped by explicit won_closed_date {from,to}, not by
// any week anchor, so F1's week definition does not move 191 / $9,778,045.90.)
describe("reconciliation: F1 == canonical #539 Sunday-Saturday WTD", () => {
  // Week of Sun 2026-05-24 .. Sat 2026-05-30; the next Sunday (2026-05-31) starts a fresh week.
  const expectedSundayByCtDate: Record<string, string> = {
    "2026-05-24": "2026-05-24", // Sunday
    "2026-05-25": "2026-05-24", // Monday
    "2026-05-26": "2026-05-24", // Tuesday
    "2026-05-27": "2026-05-24", // Wednesday
    "2026-05-28": "2026-05-24", // Thursday
    "2026-05-29": "2026-05-24", // Friday
    "2026-05-30": "2026-05-24", // Saturday
    "2026-05-31": "2026-05-31", // next Sunday -> new week
  };

  it("to-date FROM lands on the most-recent Sunday for every day of the week", () => {
    for (const [ctDate, expectedSunday] of Object.entries(expectedSundayByCtDate)) {
      // 18:00Z = 13:00 CT, same calendar date as the UTC date in May -> isolates the Sunday rule.
      const { from, to } = getWtdPeriod("to_date", new Date(`${ctDate}T18:00:00Z`));
      expect({ ctDate, from, to }).toEqual({ ctDate, from: expectedSunday, to: ctDate });
    }
  });
});

// sql.raw(...) renders to a single string chunk; pull its text out for assertions.
function sqlFragmentText(frag: unknown): string {
  const chunks = (frag as { queryChunks?: Array<{ value?: unknown }> })?.queryChunks ?? [];
  return chunks
    .map((c) => (typeof c.value === "string" ? c.value : Array.isArray(c.value) ? c.value.join("") : ""))
    .join("");
}

describe("sundayWeekBucketSql -- Sunday-anchored CT week-start for trend grouping", () => {
  it("returns a Drizzle SQL fragment (NOT a bindable string) so interpolation emits SQL, not a param", () => {
    const frag = sundayWeekBucketSql("h.created_at");
    // a raw string would be bound as a parameter inside a sql`` template and silently break grouping
    expect(typeof frag).not.toBe("string");
    const text = sqlFragmentText(frag);
    expect(text).toContain(BUSINESS_TIMEZONE);
    expect(text).toContain("date_trunc('week'");
    expect(text).toContain("interval '1 day'");
    expect(text).toContain("h.created_at");
  });
});
