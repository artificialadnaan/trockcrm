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

const { runAiDisconnectAdminTaskGeneration } = await import("../../src/jobs/ai-disconnect-admin-tasks.js");

describe("ai disconnect admin task worker", () => {
  beforeEach(() => {
    queryMock.mockReset();
  });

  it("creates deterministic office/admin tasks for high-confidence disconnects", async () => {
    queryMock.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes("FROM public.offices WHERE is_active = true")) {
        return { rows: [{ id: "office-1", slug: "beta", name: "Beta" }] };
      }
      if (sql.includes("SELECT pg_try_advisory_lock")) return { rows: [{ acquired: true }] };
      if (sql === "BEGIN" || sql === "COMMIT") return { rows: [] };
      if (sql.includes("FROM public.users") && sql.includes("role IN ('director', 'admin')")) {
        return { rows: [{ id: "director-1" }] };
      }
      if (sql.includes("'procore_bid_board_drift'::text")) {
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
              disconnect_type: "estimating_gate_gap",
              disconnect_label: "Estimating gate gap",
              age_days: 4,
            },
          ],
        };
      }
      if (sql.startsWith("INSERT INTO office_beta.tasks")) {
        return { rows: [{ id: "task-1" }] };
      }
      if (sql.includes("SELECT pg_advisory_unlock")) return { rows: [] };
      throw new Error(`Unexpected SQL: ${sql} :: ${JSON.stringify(params)}`);
    });

    await runAiDisconnectAdminTaskGeneration();

    const inserts = queryMock.mock.calls.filter(([sql]) => typeof sql === "string" && sql.startsWith("INSERT INTO office_beta.tasks"));
    expect(inserts).toHaveLength(2);
    expect(inserts[0]?.[1]).toEqual(
      expect.arrayContaining([
        "Resolve Bid board sync drift for D-1001",
        "manual",
        "high",
        "pending",
        "director-1",
        "office-1",
        "ai_disconnect_admin_task",
        "cron.ai_disconnect_admin_tasks",
      ])
    );
  });
});
