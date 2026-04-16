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
      if (sql.includes("FROM information_schema.schemata")) {
        return { rows: [{ schema_name: "office_beta" }] };
      }
      if (sql.includes("SELECT pg_try_advisory_lock")) return { rows: [{ acquired: true }] };
      if (sql === "BEGIN" || sql === "COMMIT") return { rows: [] };
      if (sql === "SET LOCAL search_path TO office_beta, public") return { rows: [] };
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
            {
              deal_id: "deal-3",
              deal_number: "D-1003",
              deal_name: "Gamma Point",
              disconnect_type: "inbound_without_followup",
              disconnect_label: "Inbound with no follow-up",
              age_days: 3,
            },
            {
              deal_id: "deal-4",
              deal_number: "D-1004",
              deal_name: "Delta Square",
              disconnect_type: "missing_next_task",
              disconnect_label: "Missing next task",
              age_days: 3,
            },
          ],
        };
      }
      if (sql.startsWith("SELECT id\n             FROM office_beta.tasks")) {
        return { rows: [] };
      }
      if (sql.startsWith("INSERT INTO office_beta.tasks")) {
        return { rows: [{ id: "task-1" }] };
      }
      if (sql.includes("SELECT pg_advisory_unlock")) return { rows: [] };
      throw new Error(`Unexpected SQL: ${sql} :: ${JSON.stringify(params)}`);
    });

    await runAiDisconnectAdminTaskGeneration();

    const inserts = queryMock.mock.calls.filter(([sql]) => typeof sql === "string" && sql.startsWith("INSERT INTO office_beta.tasks"));
    expect(inserts).toHaveLength(4);
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
    expect(inserts[2]?.[1]).toEqual(
      expect.arrayContaining([
        "Resolve Inbound with no follow-up for D-1003",
        "inbound_without_followup",
      ])
    );
    expect(inserts[3]?.[1]).toEqual(
      expect.arrayContaining([
        "Resolve Missing next task for D-1004",
        "missing_next_task",
      ])
    );
  });

  it("skips inserting duplicate active tasks for the same business key", async () => {
    queryMock.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes("FROM public.offices WHERE is_active = true")) {
        return { rows: [{ id: "office-1", slug: "beta", name: "Beta" }] };
      }
      if (sql.includes("FROM information_schema.schemata")) {
        return { rows: [{ schema_name: "office_beta" }] };
      }
      if (sql.includes("SELECT pg_try_advisory_lock")) return { rows: [{ acquired: true }] };
      if (sql === "BEGIN" || sql === "COMMIT") return { rows: [] };
      if (sql === "SET LOCAL search_path TO office_beta, public") return { rows: [] };
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
          ],
        };
      }
      if (sql.startsWith("SELECT id\n             FROM office_beta.tasks")) {
        return { rows: [{ id: "existing-task" }] };
      }
      if (sql.startsWith("INSERT INTO office_beta.tasks")) {
        return { rows: [{ id: "task-1" }] };
      }
      if (sql.includes("SELECT pg_advisory_unlock")) return { rows: [] };
      throw new Error(`Unexpected SQL: ${sql} :: ${JSON.stringify(params)}`);
    });

    await runAiDisconnectAdminTaskGeneration();

    const inserts = queryMock.mock.calls.filter(([sql]) => typeof sql === "string" && sql.startsWith("INSERT INTO office_beta.tasks"));
    expect(inserts).toHaveLength(0);
  });

  it("skips offices whose tenant schema does not exist", async () => {
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM public.offices WHERE is_active = true")) {
        return { rows: [{ id: "office-1", slug: "dfw", name: "DFW" }] };
      }
      if (sql.includes("FROM information_schema.schemata")) {
        return { rows: [] };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });

    await runAiDisconnectAdminTaskGeneration();

    expect(
      queryMock.mock.calls.some(([sql]) => typeof sql === "string" && sql === "BEGIN")
    ).toBe(false);
  });
});
