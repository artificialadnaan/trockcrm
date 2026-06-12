import { describe, expect, it } from "vitest";
import { shouldSendNow, resolveFrontendBaseUrl } from "../src/scripts/daily-summary-email.js";
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

describe("resolveFrontendBaseUrl — always absolute, never a relative CTA", () => {
  it("uses the live default when unset/empty/whitespace/slash-only or any non-absolute value", () => {
    // slash-only + relative + bare strings are NOT absolute → would build a broken relative CTA
    for (const v of [undefined, "", "   ", "/", "//", " / ", "/app", "foo", "daily-summary", "ftp://x.com"]) {
      expect(resolveFrontendBaseUrl(v)).toBe("https://trockcrm.com");
    }
  });
  it("honors an absolute http(s) FRONTEND_URL and strips trailing slashes (no '//daily-summary')", () => {
    expect(resolveFrontendBaseUrl("https://trockcrm.com")).toBe("https://trockcrm.com");
    expect(resolveFrontendBaseUrl("https://trockcrm.com/")).toBe("https://trockcrm.com");
    expect(resolveFrontendBaseUrl("  https://staging.trockcrm.com//  ")).toBe("https://staging.trockcrm.com");
    expect(resolveFrontendBaseUrl("http://localhost:5173")).toBe("http://localhost:5173");
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

const ZERO = { created: 0, edits: 0, stageMoves: 0, uploads: 0, reports: 0, activities: {} as Record<string, number> };
const ACTIVE: DailySummaryPayload = {
  date: "2026-06-12", office: "dallas", asOfLabel: AS_OF_LABEL,
  headline: { activeReps: 2, totalReps: 3, totalActions: 500, totalActiveMinutes: 150, totalSessions: 8, biggestMover: { name: "Kaleb", actions: 312 } },
  wonToday: [
    { dealName: "Anthem on Ashley", repName: "Kaleb Marshall", value: 186000 },
    { dealName: "2711 N Haskell", repName: "Sidney Monroe", value: 126000 },
  ],
  advancedToday: [
    { dealName: "The Hayward", repName: "Adnaan", fromStage: "Opportunity", toStage: "Estimating" },
  ],
  leaderboard: [
    { rank: 1, name: "Kaleb", actions: 312, activeMinutes: 56, breakdown: { ...ZERO, created: 50, edits: 15, stageMoves: 2, activities: { email: 22, call: 3 } } },
    // A worker with actions but NO browser session — must render "—", never "0m".
    { rank: 2, name: "Adnaan", actions: 188, activeMinutes: null, breakdown: { ...ZERO, created: 21, reports: 26 } },
    { rank: 3, name: "Zoe", actions: 0, activeMinutes: null, breakdown: { ...ZERO } },
  ],
  hourly: [{ hour: 8, reps: 4 }, { hour: 12, reps: 7 }],
  teamHealth: { active: 2, quiet: 1, quietNames: ["Zoe"] },
};
const QUIET: DailySummaryPayload = {
  date: "2026-06-13", office: "dallas", asOfLabel: AS_OF_LABEL,
  headline: { activeReps: 0, totalReps: 3, totalActions: 0, totalActiveMinutes: 0, totalSessions: 0, biggestMover: null },
  wonToday: [],
  advancedToday: [],
  leaderboard: [{ rank: 1, name: "Kaleb", actions: 0, activeMinutes: null, breakdown: { ...ZERO } }],
  hourly: [],
  teamHealth: { active: 0, quiet: 3, quietNames: ["Kaleb", "Adnaan", "Zoe"] },
};
const PAGE_URL = "https://trockcrm.com/daily-summary/2026-06-12?token=TESTTOKEN123";

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

  it("names the won deals and the Won header reconciles to their sum (no count/total drift)", () => {
    const html = renderDailySummaryEmail(ACTIVE, PAGE_URL);
    expect(html).toContain("Anthem on Ashley");
    expect(html).toContain("2711 N Haskell");
    expect(html).toContain("$186,000");
    expect(html).toContain("$126,000");
    // header = count · EXACT total (not compacted), both from the SAME wonToday array (186000 + 126000)
    expect(html).toContain("2 · $312,000");
    // subject keeps the compact teaser form of the same reconciled total
    expect(dailySummarySubject(ACTIVE)).toContain("2 won, $312K");
  });

  it("names the advances as From → To with the rep", () => {
    const html = renderDailySummaryEmail(ACTIVE, PAGE_URL);
    expect(html).toContain("The Hayward");
    expect(html).toContain("Opportunity");
    expect(html).toContain("Estimating");
    expect(html).toContain("Adnaan"); // the mover is named on the row
  });

  it("leaderboard shows the breakdown (the value), and enforces minutes/'—' (never 0m)", () => {
    const html = renderDailySummaryEmail(ACTIVE, PAGE_URL);
    expect(html).toContain("50 created"); // the breakdown IS the value, not a bar
    expect(html).toContain("3 calls"); // ALL activity types surface (not just email/note)
    expect(html).toContain("56m"); // Kaleb has a real session
    expect(html).not.toContain("0m"); // Adnaan (188 actions, no session) must be "—", never "0m idle"
  });

  it("surfaces team activity in the headline: time spent + actions, not just movement", () => {
    const html = renderDailySummaryEmail(ACTIVE, PAGE_URL);
    expect(html).toContain("2.5h"); // 150 team active minutes -> hours
    expect(html).toContain(">Time<"); // the Time stat label
    expect(html).toContain("500"); // total actions
  });
});
