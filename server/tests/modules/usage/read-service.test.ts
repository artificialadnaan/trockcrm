import { describe, expect, it } from "vitest";
import { resolveRepScope, resolveReps, weekDates, sumDays, readUsageDaily, resolveDayKind, emptyUsageDay } from "../../../src/modules/usage/read-service.js";
import type { UsageDailyShape } from "../../../src/modules/usage/types.js";

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

describe("resolveReps roster (surfaces platform staff: reps + directors + admins)", () => {
  function mockClient(rows: Array<{ id: string; display_name: string }>) {
    const calls: Array<{ sql: string; params?: unknown[] }> = [];
    const client = {
      query: async (sql: string, params?: unknown[]) => {
        calls.push({ sql, params });
        return { rows };
      },
    };
    return { client, calls };
  }

  it("includes directors and admins in the all-staff (scope=null) roster, not just reps", async () => {
    const { client, calls } = mockClient([{ id: "adm-1", display_name: "Chase Kelly" }]);
    const reps = await resolveReps(client as any, null);
    expect(reps).toEqual([{ id: "adm-1", displayName: "Chase Kelly" }]);
    expect(calls[0].sql).toMatch(/role IN \('rep', 'director', 'admin'\)/);
    expect(calls[0].sql).not.toMatch(/role = 'rep'/);
  });

  it("applies the same staff-role filter on the targeted (scope) path", async () => {
    const { client, calls } = mockClient([{ id: "adm-1", display_name: "Chase Kelly" }]);
    await resolveReps(client as any, ["adm-1"]);
    expect(calls[0].sql).toMatch(/role IN \('rep', 'director', 'admin'\)/);
    expect(calls[0].sql).not.toMatch(/role = 'rep'/);
    expect(calls[0].params).toEqual(["adm-1"]);
  });

  it("still short-circuits an empty scope to [] without querying", async () => {
    const { client, calls } = mockClient([]);
    expect(await resolveReps(client as any, [])).toEqual([]);
    expect(calls.length).toBe(0);
  });
});

describe("weekDates", () => {
  it("returns the 7 ISO dates of the week containing the anchor (Sun-Sat, canonical business week)", () => {
    expect(weekDates("2026-06-10")).toEqual([
      "2026-06-07", "2026-06-08", "2026-06-09", "2026-06-10", "2026-06-11", "2026-06-12", "2026-06-13",
    ]);
  });
});

function day(over: Partial<UsageDailyShape>): UsageDailyShape {
  return {
    userId: "rep-1", date: "2026-06-01", activeSeconds: 0, sessionCount: 0, viewCount: 0, actionCount: 0,
    breakdown: { deal_views: 0, lead_views: 0, report_views: 0, page_views: 0, creates: 0, edits: 0, stage_moves: 0, uploads: 0, activities: {} },
    firstActiveAt: null, lastActiveAt: null, ...over,
  };
}

describe("sumDays", () => {
  it("merges activity keys (summing) with canonical sorted order", () => {
    const out = sumDays("rep-1", "week-x", [
      day({ breakdown: { ...day({}).breakdown, activities: { note: 1, email: 2 } } }),
      day({ breakdown: { ...day({}).breakdown, activities: { note: 3, call: 1 } } }),
    ]);
    expect(Object.keys(out.breakdown.activities)).toEqual(["call", "email", "note"]);
    expect(out.breakdown.activities).toEqual({ call: 1, email: 2, note: 4 });
  });

  it("picks earliest firstActiveAt and latest lastActiveAt across days", () => {
    const out = sumDays("rep-1", "week-x", [
      day({ firstActiveAt: "2026-06-02T10:00:00.000Z", lastActiveAt: "2026-06-02T11:00:00.000Z" }),
      day({ firstActiveAt: "2026-06-01T09:00:00.000Z", lastActiveAt: "2026-06-03T18:00:00.000Z" }),
    ]);
    expect(out.firstActiveAt).toBe("2026-06-01T09:00:00.000Z");
    expect(out.lastActiveAt).toBe("2026-06-03T18:00:00.000Z");
  });

  it("leaves firstActiveAt/lastActiveAt null when no day had active time", () => {
    const out = sumDays("rep-1", "week-x", [day({}), day({})]);
    expect(out.firstActiveAt).toBeNull();
    expect(out.lastActiveAt).toBeNull();
  });
});

describe("resolveDayKind", () => {
  it("classifies past/live/future", () => {
    expect(resolveDayKind("2026-06-08", "2026-06-10")).toBe("past");
    expect(resolveDayKind("2026-06-10", "2026-06-10")).toBe("live");
    expect(resolveDayKind("2026-06-12", "2026-06-10")).toBe("future");
  });
});
describe("emptyUsageDay", () => {
  it("is a fully zeroed shape", () => {
    const z = emptyUsageDay("rep-1", "2026-06-12");
    expect(z.activeSeconds).toBe(0);
    expect(z.actionCount).toBe(0);
    expect(z.firstActiveAt).toBeNull();
    expect(z.breakdown.activities).toEqual({});
  });
});
describe("readUsageDaily coercion", () => {
  it("coerces a pg Date timestamp to an ISO string (so sumDays comparisons are valid)", async () => {
    const client = {
      query: async () => ({ rows: [{
        active_seconds: 120, session_count: 1, view_count: 2, action_count: 3,
        breakdown: { deal_views: 0, lead_views: 0, report_views: 0, page_views: 0, creates: 0, edits: 0, stage_moves: 0, uploads: 0, activities: {} },
        first_active_at: new Date("2026-06-01T14:00:00.000Z"),
        last_active_at: new Date("2026-06-01T15:00:00.000Z"),
      }] }),
    } as any;
    const out = await readUsageDaily(client, "office_dallas", "rep-1", "2026-06-01");
    expect(typeof out.firstActiveAt).toBe("string");
    expect(out.firstActiveAt).toBe("2026-06-01T14:00:00.000Z");
    expect(out.activeSeconds).toBe(120);
  });

  it("returns a zeroed shape when no row exists", async () => {
    const client = { query: async () => ({ rows: [] }) } as any;
    const out = await readUsageDaily(client, "office_dallas", "rep-1", "2026-06-01");
    expect(out.activeSeconds).toBe(0);
    expect(out.firstActiveAt).toBeNull();
    expect(out.breakdown.activities).toEqual({});
  });
});
