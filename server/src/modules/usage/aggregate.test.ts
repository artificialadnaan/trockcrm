// server/src/modules/usage/aggregate.test.ts
import { describe, expect, it } from "vitest";
import { computeUsageDaily } from "./aggregate.js";
import type { UsageRawInput } from "./types.js";

const t = (sec: number) => new Date(Date.UTC(2026, 5, 9, 12, 0, sec));

function baseInput(overrides: Partial<UsageRawInput> = {}): UsageRawInput {
  return {
    userId: "rep-1",
    date: "2026-06-09",
    sessions: [{ id: "s1", impersonatorId: null }],
    heartbeats: [],
    viewEvents: [],
    auditRows: [],
    stageMoves: [],
    activities: [],
    uploads: [],
    ...overrides,
  };
}

describe("computeUsageDaily", () => {
  it("returns an all-zero shape for an empty day", () => {
    const out = computeUsageDaily(baseInput({ sessions: [] }));
    expect(out).toEqual({
      userId: "rep-1",
      date: "2026-06-09",
      activeSeconds: 0,
      sessionCount: 0,
      viewCount: 0,
      actionCount: 0,
      breakdown: {
        deal_views: 0, lead_views: 0, report_views: 0, page_views: 0,
        creates: 0, edits: 0, stage_moves: 0, uploads: 0, activities: {},
      },
      firstActiveAt: null,
      lastActiveAt: null,
    });
  });

  it("counts sessions started, views by type, and active time", () => {
    const out = computeUsageDaily(baseInput({
      sessions: [{ id: "s1", impersonatorId: null }, { id: "s2", impersonatorId: null }],
      heartbeats: [{ sessionId: "s1", at: t(30) }, { sessionId: "s1", at: t(60) }],
      viewEvents: [
        { sessionId: "s1", at: t(31), entityType: "deal" },
        { sessionId: "s1", at: t(32), entityType: "deal" },
        { sessionId: "s1", at: t(33), entityType: "lead" },
        { sessionId: "s1", at: t(34), entityType: "report" },
        { sessionId: "s1", at: t(35), entityType: "page" },
      ],
    }));
    expect(out.sessionCount).toBe(2);
    expect(out.activeSeconds).toBe(60);
    expect(out.viewCount).toBe(5);
    expect(out.breakdown.deal_views).toBe(2);
    expect(out.breakdown.lead_views).toBe(1);
    expect(out.breakdown.report_views).toBe(1);
    expect(out.breakdown.page_views).toBe(1);
    expect(out.firstActiveAt).toBe(t(30).toISOString());
    expect(out.lastActiveAt).toBe(t(60).toISOString());
  });

  it("counts actions from all four sources and sums action_count", () => {
    const out = computeUsageDaily(baseInput({
      auditRows: [
        { action: "insert", tableName: "deals", createdAt: t(10), impersonatorId: null },
        { action: "update", tableName: "deals", createdAt: t(20), impersonatorId: null },
        { action: "update", tableName: "leads", createdAt: t(21), impersonatorId: null },
      ],
      stageMoves: [{ createdAt: t(40) }, { createdAt: t(41) }],
      uploads: [{ at: t(50) }],
      activities: [{ type: "note", at: t(60) }, { type: "call", at: t(61) }, { type: "note", at: t(62) }],
    }));
    expect(out.breakdown.creates).toBe(1);
    expect(out.breakdown.edits).toBe(2);
    expect(out.breakdown.stage_moves).toBe(2);
    expect(out.breakdown.uploads).toBe(1);
    expect(out.breakdown.activities).toEqual({ note: 2, call: 1 });
    expect(out.actionCount).toBe(9);
  });

  it("excludes impersonated sessions from time and views, and impersonated audit rows from creates/edits", () => {
    const out = computeUsageDaily(baseInput({
      sessions: [
        { id: "s1", impersonatorId: null },
        { id: "imp", impersonatorId: "admin-9" },
      ],
      heartbeats: [
        { sessionId: "s1", at: t(30) },
        { sessionId: "imp", at: t(300) },
      ],
      viewEvents: [
        { sessionId: "s1", at: t(31), entityType: "deal" },
        { sessionId: "imp", at: t(301), entityType: "deal" },
      ],
      auditRows: [
        { action: "insert", tableName: "deals", createdAt: t(10), impersonatorId: null },
        { action: "insert", tableName: "deals", createdAt: t(11), impersonatorId: "admin-9" },
      ],
      stageMoves: [{ createdAt: t(40) }],
    }));
    expect(out.activeSeconds).toBe(30);
    expect(out.viewCount).toBe(1);
    expect(out.breakdown.creates).toBe(1);
    expect(out.breakdown.stage_moves).toBe(1);
  });
});
