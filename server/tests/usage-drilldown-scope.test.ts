// server/tests/usage-drilldown-scope.test.ts
import { describe, expect, it } from "vitest";
import { resolveRepScope, isWithinDrilldownWindow } from "../src/modules/usage/read-service.js";

describe("drilldown scoping + window", () => {
  it("applies the identical rep-self scope as the summary", () => {
    expect(resolveRepScope({ role: "rep", userId: "rep-1" }, "rep-2")).toEqual(["rep-1"]);
  });
  it("rejects dates older than the 14-day raw window", () => {
    expect(isWithinDrilldownWindow("2026-06-09", "2026-06-09")).toBe(true);
    expect(isWithinDrilldownWindow("2026-05-20", "2026-06-09")).toBe(false); // 20 days old
    expect(isWithinDrilldownWindow("2026-05-27", "2026-06-09")).toBe(true);  // 13 days old
  });
});
