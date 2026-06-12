import { describe, expect, it } from "vitest";
import { shouldSendNow } from "../src/scripts/daily-summary-email.js";
import { summarizeReps, AS_OF_LABEL, type DailySummaryPayload } from "../src/modules/daily-summary/service.js";
import { renderDailySummaryEmail, dailySummarySubject } from "../src/modules/daily-summary/email-template.js";

describe("shouldSendNow — 5pm CT, Mon–Sat, DST-safe", () => {
  it("sends at 17:00 CDT (summer) = 22:00 UTC, not at 23:00 UTC", () => {
    expect(shouldSendNow(new Date("2026-06-12T22:00:00Z"))).toBe(true); // 17:00 CDT (Fri)
    expect(shouldSendNow(new Date("2026-06-12T23:00:00Z"))).toBe(false); // 18:00 CDT
  });
  it("sends at 17:00 CST (winter) = 23:00 UTC, not at 22:00 UTC", () => {
    expect(shouldSendNow(new Date("2026-01-15T23:00:00Z"))).toBe(true); // 17:00 CST (Thu)
    expect(shouldSendNow(new Date("2026-01-15T22:00:00Z"))).toBe(false); // 16:00 CST
  });
  it("skips Sunday (gated on CT weekday, not UTC) and any non-17:00 hour", () => {
    expect(shouldSendNow(new Date("2026-06-14T22:00:00Z"))).toBe(false); // 17:00 CDT but Sunday
    expect(shouldSendNow(new Date("2026-06-12T20:00:00Z"))).toBe(false); // 15:00 CDT
  });
});

describe("summarizeReps — deterministic tiebreak + zero-guard + quiet day", () => {
  it("breaks ties by name A→Z (no rank flicker run-to-run)", () => {
    const s = summarizeReps([{ name: "Bob", actions: 5 }, { name: "Ann", actions: 5 }]);
    expect(s.leaderboard.map((r) => r.name)).toEqual(["Ann", "Bob"]);
    expect(s.biggestMover).toEqual({ name: "Ann", actions: 5 });
  });
  it("zero-guards the biggest mover when nobody worked (→ null, never NaN)", () => {
    const s = summarizeReps([{ name: "Ann", actions: 0 }, { name: "Bob", actions: 0 }]);
    expect(s.biggestMover).toBeNull();
    expect(s.totalActions).toBe(0);
    expect(s.activeReps).toBe(0);
    expect(s.quietNames).toEqual(["Ann", "Bob"]);
  });
  it("ranks workers and lists quiet reps", () => {
    const s = summarizeReps([{ name: "Adnaan", actions: 188 }, { name: "Kaleb", actions: 312 }, { name: "Zoe", actions: 0 }]);
    expect(s.biggestMover).toEqual({ name: "Kaleb", actions: 312 });
    expect(s.activeReps).toBe(2);
    expect(s.quietNames).toEqual(["Zoe"]);
  });
});

const ACTIVE: DailySummaryPayload = {
  date: "2026-06-12", office: "dallas", asOfLabel: AS_OF_LABEL,
  headline: { activeReps: 2, totalReps: 3, totalActions: 500, biggestMover: { name: "Kaleb", actions: 312 } },
  leaderboard: [{ rank: 1, name: "Kaleb", actions: 312 }, { rank: 2, name: "Adnaan", actions: 188 }, { rank: 3, name: "Zoe", actions: 0 }],
  majorMoves: [{ kind: "won", label: "Anthem on Ashley: Estimating → Won" }, { kind: "advanced", label: "The hayward: Opportunity → Estimating" }],
  teamHealth: { active: 2, quiet: 1, quietNames: ["Zoe"] },
};
const QUIET: DailySummaryPayload = {
  date: "2026-06-13", office: "dallas", asOfLabel: AS_OF_LABEL,
  headline: { activeReps: 0, totalReps: 3, totalActions: 0, biggestMover: null },
  leaderboard: [{ rank: 1, name: "Kaleb", actions: 0 }],
  majorMoves: [],
  teamHealth: { active: 0, quiet: 3, quietNames: ["Kaleb", "Adnaan", "Zoe"] },
};
const PAGE_URL = "https://crm.trockconstruction.com/daily-summary/2026-06-12?token=TESTTOKEN123";

describe("renderDailySummaryEmail", () => {
  it("states 'as of 5:00 PM CT' so it isn't read as a complete daily total", () => {
    expect(renderDailySummaryEmail(ACTIVE, PAGE_URL)).toContain(AS_OF_LABEL);
    expect(AS_OF_LABEL).toBe("as of 5:00 PM CT");
  });
  it("is email-client-safe: tables + inline styles only (no <style>, no flexbox)", () => {
    const html = renderDailySummaryEmail(ACTIVE, PAGE_URL);
    expect(html).not.toContain("<style");
    expect(html).not.toContain("flex");
    expect(html).toContain("<table");
  });
  it("links the 'See full summary' button to the token-guarded page", () => {
    expect(renderDailySummaryEmail(ACTIVE, PAGE_URL)).toContain("TESTTOKEN123");
  });
  it("renders the quiet-day state, not an empty/broken section", () => {
    const html = renderDailySummaryEmail(QUIET, PAGE_URL);
    expect(html).toContain("Quiet day — no major moves");
    expect(html).toContain("—"); // biggest mover zero-guard
  });
  it("is NaN-safe: never emits 'NaN' or 'undefined'", () => {
    const html = renderDailySummaryEmail(QUIET, PAGE_URL);
    expect(html).not.toContain("NaN");
    expect(html).not.toContain("undefined");
  });
  it("subject carries the date + as-of framing", () => {
    expect(dailySummarySubject(ACTIVE)).toContain("Daily Pulse");
    expect(dailySummarySubject(ACTIVE)).toContain(AS_OF_LABEL);
  });
});
