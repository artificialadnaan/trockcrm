import { describe, expect, it } from "vitest";
import { resolveRepScope, classifyAction, isWithinDrilldownWindow, latestNonFutureDate, oldestInWindowDate, classifyViewsState } from "../src/modules/usage/read-service.js";

// The /platform-usage/detail route enforces the SAME rep-self scoping as the summary and /drilldown
// (it calls resolveRepScope, then resolves through the active-office rep roster). A rep can never
// load another rep's detail by editing the URL.
describe("platform-usage/detail — scoping", () => {
  it("forces a rep to themselves regardless of the requested rep id", () => {
    expect(resolveRepScope({ role: "rep", userId: "rep-1" }, "rep-2")).toEqual(["rep-1"]);
  });
  it("lets a director target a specific rep", () => {
    expect(resolveRepScope({ role: "director", userId: "dir-1" }, "rep-9")).toEqual(["rep-9"]);
  });
  it("lets an admin omit the rep (null), which the route rejects as 'rep required'", () => {
    expect(resolveRepScope({ role: "admin", userId: "adm-1" }, undefined)).toBeNull();
  });
});

describe("platform-usage/detail — action classification", () => {
  // classifyAction covers only the audit-sourced buckets (create/edit/stage). Notes and uploads are
  // sourced from the activities/files tables (their own crediting/dating), not from audit rows.
  it("classifies audit create/edit/stage rows", () => {
    expect(classifyAction("insert", false)).toBe("create");
    expect(classifyAction("update", false)).toBe("edit");
    expect(classifyAction("update", true)).toBe("stage_move"); // changes.stage_id/stageId
  });
});

describe("platform-usage/detail — views retention state", () => {
  it("treats a future date-picker selection as future (NOT expired)", () => {
    // Selecting tomorrow / next week: no data yet, but it is NOT expired (the opposite of the truth).
    expect(classifyViewsState(["2026-06-20"], "2026-06-10")).toEqual({ kind: "future" });
    const futureWeek = ["2026-06-21", "2026-06-22", "2026-06-23", "2026-06-24", "2026-06-25", "2026-06-26", "2026-06-27"];
    expect(classifyViewsState(futureWeek, "2026-06-10")).toEqual({ kind: "future" });
  });
  it("marks a fully-old period expired", () => {
    const oldWeek = ["2026-05-10", "2026-05-11", "2026-05-12", "2026-05-13", "2026-05-14", "2026-05-15", "2026-05-16"];
    expect(classifyViewsState(oldWeek, "2026-06-10")).toEqual({ kind: "expired" });
  });
  it("clamps a partial (straddling) period's query lower bound to the oldest in-window day", () => {
    // Week 05-24..05-30, today 06-11: 05-24..05-28 pruned, 05-29/05-30 in-window.
    const week = ["2026-05-24", "2026-05-25", "2026-05-26", "2026-05-27", "2026-05-28", "2026-05-29", "2026-05-30"];
    expect(classifyViewsState(week, "2026-06-11")).toEqual({ kind: "partial", queryFrom: "2026-05-29" });
  });
  it("returns available with the period start for a fully in-window period (incl. current week's future Saturday)", () => {
    expect(classifyViewsState(["2026-06-08", "2026-06-09"], "2026-06-10")).toEqual({ kind: "available", queryFrom: "2026-06-08" });
    const currentWeek = ["2026-06-07", "2026-06-08", "2026-06-09", "2026-06-10", "2026-06-11", "2026-06-12", "2026-06-13"];
    expect(classifyViewsState(currentWeek, "2026-06-10")).toEqual({ kind: "available", queryFrom: "2026-06-07" });
  });
});

describe("platform-usage/detail — actions-vs-views retention asymmetry", () => {
  it("views are within the window only for the last 14 days (actions are always available)", () => {
    expect(isWithinDrilldownWindow("2026-06-09", "2026-06-09")).toBe(true); // today
    expect(isWithinDrilldownWindow("2026-05-27", "2026-06-09")).toBe(true); // 13 days
    expect(isWithinDrilldownWindow("2026-05-20", "2026-06-09")).toBe(false); // 20 days -> views expired
  });

  it("clamps the retention check to a non-future day so the current week isn't falsely expired", () => {
    // Current week (Sun 06-07 .. Sat 06-13), today Wed 06-10 -> latest non-future is today, in-window.
    const week = ["2026-06-07", "2026-06-08", "2026-06-09", "2026-06-10", "2026-06-11", "2026-06-12", "2026-06-13"];
    const latest = latestNonFutureDate(week, "2026-06-10");
    expect(latest).toBe("2026-06-10");
    expect(isWithinDrilldownWindow(latest, "2026-06-10")).toBe(true); // NOT expired
    // An old week (all past, >14d) -> latest is its Saturday, out of window -> expired.
    const oldWeek = ["2026-05-10", "2026-05-11", "2026-05-12", "2026-05-13", "2026-05-14", "2026-05-15", "2026-05-16"];
    expect(isWithinDrilldownWindow(latestNonFutureDate(oldWeek, "2026-06-10"), "2026-06-10")).toBe(false);
  });

  it("clamps a partial week's view query lower bound to the oldest in-window date", () => {
    // Week Sun 05-24 .. Sat 05-30, today 06-11: 05-24..05-28 are >=14d (pruned), 05-29/05-30 in-window.
    const week = ["2026-05-24", "2026-05-25", "2026-05-26", "2026-05-27", "2026-05-28", "2026-05-29", "2026-05-30"];
    expect(oldestInWindowDate(week, "2026-06-11")).toBe("2026-05-29");
    // A fully in-window period clamps to its own first date (no change).
    expect(oldestInWindowDate(["2026-06-08", "2026-06-09"], "2026-06-10")).toBe("2026-06-08");
  });
});
