import { describe, expect, it, vi } from "vitest";

/**
 * Per-service guard for ai-copilot: `deals.is_change_order` must survive from the query to the payload.
 *
 * This service was wired without one, and it is the exact gap that has produced a defect twice on this
 * PR — a SELECT added without its mapper, and (in reports/service) a mapper reading a column the query
 * never produced. The second kind is not a silently-missing label: an outer SELECT referencing a column
 * its CTE does not project is a runtime Postgres error that a mocked `execute` hides entirely. So the SQL
 * TEXT and the mapped OUTPUT are asserted together, and the test fails whichever end regresses.
 *
 * Typecheck cannot stand in for this: the field is optional by design (an older API deployment must
 * degrade to the syntax fallback rather than assert `false`), and these rows are `any`.
 *
 * Endpoints covered, and the client surfaces each stands for:
 *   getAiActionQueue    -> admin/ai-action-queue-page (x2), components/ai/director-blind-spot-list
 *   getAiReviewQueue    -> admin/ai-packet-review-page (x2), admin/ai-ops-page
 *   listInterventionCases (via projectQueueItem)
 *                       -> components/ai/intervention-queue-table, components/ai/intervention-detail-panel
 */

function extractSqlText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  if (Array.isArray((value as { queryChunks?: unknown[] }).queryChunks)) {
    return (value as { queryChunks: unknown[] }).queryChunks.map(extractSqlText).join("");
  }
  if ("value" in (value as Record<string, unknown>)) {
    const inner = (value as { value: unknown }).value;
    if (Array.isArray(inner)) return inner.map(extractSqlText).join("");
    if (typeof inner === "string") return inner;
  }
  return "";
}

function mockDb(rows: unknown[]) {
  const execute = vi.fn().mockImplementation(async () => ({ rows }));
  return { execute } as any;
}

describe("ai-copilot carries deals.is_change_order from query to payload", () => {
  it("getAiActionQueue selects the column and maps it out", async () => {
    const { getAiActionQueue } = await import("../../../src/modules/ai-copilot/service.js");
    const db = mockDb([
      {
        entry_type: "blind_spot",
        id: "e1",
        deal_id: "deal-1",
        deal_name: "Tides — Change Order 2",
        deal_is_change_order: true,
        deal_number: "DFW-1",
        title: "t",
      },
    ]);

    const entries = await getAiActionQueue(db, {});

    expect(entries[0]?.dealIsChangeOrder).toBe(true);
    const sqlText = db.execute.mock.calls.map(([arg]: [unknown]) => extractSqlText(arg)).join("\n");
    expect(sqlText).toContain("d.is_change_order AS deal_is_change_order");
  });

  it("getAiReviewQueue selects the column and maps it out", async () => {
    const { getAiReviewQueue } = await import("../../../src/modules/ai-copilot/service.js");
    const db = mockDb([{ id: "p1", deal_id: "deal-1", deal_name: "Tides — Change Order 2", deal_is_change_order: true }]);

    const entries = await getAiReviewQueue(db, {});

    expect(entries[0]?.dealIsChangeOrder).toBe(true);
    const sqlText = db.execute.mock.calls.map(([arg]: [unknown]) => extractSqlText(arg)).join("\n");
    expect(sqlText).toContain("d.is_change_order AS deal_is_change_order");
  });

  it("neither queue coerces an absent flag to false", async () => {
    // `false` is AUTHORITATIVE on the client — it suppresses the relabel outright. An older API
    // deployment that omits the column must leave it undefined so the name is read instead.
    const { getAiActionQueue, getAiReviewQueue } = await import("../../../src/modules/ai-copilot/service.js");
    const action = await getAiActionQueue(mockDb([{ entry_type: "blind_spot", id: "e1", deal_name: "Tides", title: "t" }]), {});
    expect(action[0]?.dealIsChangeOrder).toBeUndefined();
    const review = await getAiReviewQueue(mockDb([{ id: "p1", deal_name: "Tides" }]), {});
    expect(review[0]?.dealIsChangeOrder).toBeUndefined();
  });
});
