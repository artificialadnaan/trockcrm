import { describe, expect, it } from "vitest";
import { resolveRepScope, weekDates } from "./read-service.js";

describe("resolveRepScope (server-enforced)", () => {
  it("forces a rep to themselves regardless of requested rep", () => {
    expect(resolveRepScope({ role: "rep", userId: "rep-1" }, "rep-9")).toEqual(["rep-1"]);
  });
  it("lets a director request a specific rep", () => {
    expect(resolveRepScope({ role: "director", userId: "dir-1" }, "rep-9")).toEqual(["rep-9"]);
  });
  it("lets an admin request all reps (null filter)", () => {
    expect(resolveRepScope({ role: "admin", userId: "adm-1" }, undefined)).toBeNull();
  });
});

describe("weekDates", () => {
  it("returns the 7 ISO dates of the week containing the anchor (Mon-Sun)", () => {
    expect(weekDates("2026-06-10")).toEqual([
      "2026-06-08", "2026-06-09", "2026-06-10", "2026-06-11", "2026-06-12", "2026-06-13", "2026-06-14",
    ]);
  });
});
