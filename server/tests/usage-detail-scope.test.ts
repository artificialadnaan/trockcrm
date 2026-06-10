import { describe, expect, it } from "vitest";
import { resolveRepScope, classifyAction, isWithinDrilldownWindow } from "../src/modules/usage/read-service.js";

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
  it("classifies audit rows into the five detail buckets", () => {
    expect(classifyAction("deals", "insert", false)).toBe("create");
    expect(classifyAction("deals", "update", false)).toBe("edit");
    expect(classifyAction("deals", "update", true)).toBe("stage_move"); // changes.stage_id/stageId
    expect(classifyAction("files", "insert", false)).toBe("upload");
    expect(classifyAction("activities", "insert", false)).toBe("note");
  });
});

describe("platform-usage/detail — actions-vs-views retention asymmetry", () => {
  it("views are within the window only for the last 14 days (actions are always available)", () => {
    expect(isWithinDrilldownWindow("2026-06-09", "2026-06-09")).toBe(true); // today
    expect(isWithinDrilldownWindow("2026-05-27", "2026-06-09")).toBe(true); // 13 days
    expect(isWithinDrilldownWindow("2026-05-20", "2026-06-09")).toBe(false); // 20 days -> views expired
  });
});
