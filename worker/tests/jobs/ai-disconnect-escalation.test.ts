import { beforeEach, describe, expect, it, vi } from "vitest";

const queryMock = vi.fn();

vi.mock("../../src/db.js", () => ({
  pool: {
    connect: async () => ({
      query: queryMock,
      release: vi.fn(),
    }),
  },
}));

const { runAiDisconnectEscalationScan } = await import("../../src/jobs/ai-disconnect-escalation.js");

describe("ai disconnect escalation worker", () => {
  beforeEach(() => {
    queryMock.mockReset();
  });

  it("notifies admins/directors about critical persistent disconnects", async () => {
    queryMock.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes("FROM public.offices WHERE is_active = true")) {
        return { rows: [{ id: "office-1", slug: "beta", name: "Beta" }] };
      }

      if (sql.includes("SELECT pg_try_advisory_lock")) {
        return { rows: [{ acquired: true }] };
      }

      if (sql === "BEGIN" || sql === "COMMIT") {
        return { rows: [] };
      }

      if (sql.includes("disconnect_type")) {
        return {
          rows: [
            {
              deal_id: "deal-1",
              deal_number: "D-1001",
              deal_name: "Alpha Plaza",
              disconnect_type: "procore_bid_board_drift",
              disconnect_label: "Bid board sync drift",
              age_days: 5,
            },
            {
              deal_id: "deal-2",
              deal_number: "D-1002",
              deal_name: "Beta Tower",
              disconnect_type: "inbound_without_followup",
              disconnect_label: "Inbound with no follow-up",
              age_days: 4,
            },
          ],
        };
      }

      if (sql.includes("FROM public.users") && sql.includes("role IN ('director', 'admin')")) {
        return { rows: [{ id: "director-1" }] };
      }

      if (sql.includes("INSERT INTO office_beta.notifications")) {
        return { rows: [{ id: "notification-1" }] };
      }

      if (sql.includes("SELECT pg_advisory_unlock")) {
        return { rows: [] };
      }

      throw new Error(`Unexpected SQL: ${sql} :: ${JSON.stringify(params)}`);
    });

    await runAiDisconnectEscalationScan();

    const inserts = queryMock.mock.calls.filter(([sql]) => typeof sql === "string" && sql.includes("INSERT INTO office_beta.notifications"));
    expect(inserts).toHaveLength(1);
    expect(inserts[0]?.[1]).toEqual([
      "director-1",
      "system",
      "AI Escalation: 2 critical disconnects need intervention",
      "Bid board sync drift: D-1001 Alpha Plaza (5d); Inbound with no follow-up: D-1002 Beta Tower (4d)",
      "/admin/sales-process-disconnects",
    ]);
  });
});
