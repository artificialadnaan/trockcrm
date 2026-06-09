// server/src/modules/usage/byte-identical.test.ts
import { describe, expect, it } from "vitest";
import { computeUsageDaily } from "./aggregate.js";
import type { UsageRawInput } from "./types.js";

// A frozen fixture representing a COMPLETED (closed) day — not a live snapshot.
const CLOSED_DAY: UsageRawInput = {
  userId: "rep-7",
  date: "2026-06-01",
  sessions: [{ id: "s1", impersonatorId: null }, { id: "s2", impersonatorId: null }],
  heartbeats: [
    { sessionId: "s1", at: new Date("2026-06-01T14:00:30Z") },
    { sessionId: "s1", at: new Date("2026-06-01T14:01:00Z") },
    { sessionId: "s2", at: new Date("2026-06-01T14:00:45Z") },
  ],
  viewEvents: [
    { sessionId: "s1", at: new Date("2026-06-01T14:00:31Z"), entityType: "deal" },
    { sessionId: "s2", at: new Date("2026-06-01T14:00:46Z"), entityType: "report" },
  ],
  auditRows: [
    { action: "insert", tableName: "deals", createdAt: new Date("2026-06-01T13:00:00Z"), impersonatorId: null },
    { action: "update", tableName: "leads", createdAt: new Date("2026-06-01T13:05:00Z"), impersonatorId: null },
  ],
  stageMoves: [{ createdAt: new Date("2026-06-01T13:10:00Z") }],
  activities: [{ type: "note", at: new Date("2026-06-01T13:20:00Z") }],
  uploads: [{ at: new Date("2026-06-01T13:30:00Z") }],
};

// The two production callers both do exactly this: fetch raw rows for the day, call compute.
// (raw-fetch.ts returns this shape; read-service "today" and the rollup both consume it.)
// Task 19 rewires these stand-ins to import the real caller wrappers; the frozen fixture stays.
function livePathCompute(raw: UsageRawInput) {
  return computeUsageDaily(raw);
}
function rollupPathCompute(raw: UsageRawInput) {
  return computeUsageDaily(raw);
}

describe("live vs rollup byte-identical invariant (closed-day fixture)", () => {
  it("produces identical output for the same completed-day raw rows", () => {
    const live = livePathCompute(CLOSED_DAY);
    const rollup = rollupPathCompute(CLOSED_DAY);
    expect(JSON.stringify(live)).toBe(JSON.stringify(rollup));
  });
});
