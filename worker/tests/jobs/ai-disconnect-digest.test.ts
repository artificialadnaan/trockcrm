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

const { runAiDisconnectDigest } = await import("../../src/jobs/ai-disconnect-digest.js");

describe("ai disconnect digest worker", () => {
  beforeEach(() => {
    queryMock.mockReset();
  });

  it("creates admin notifications with disconnect summary, weekly focus, and recommended action", async () => {
    queryMock.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes("FROM public.offices WHERE is_active = true")) {
        return { rows: [{ id: "office-1", slug: "beta", name: "Beta" }] };
      }
      if (sql.includes("FROM information_schema.schemata")) {
        return { rows: [{ schema_name: "office_beta" }] };
      }

      if (sql.includes("SELECT pg_try_advisory_lock")) {
        return { rows: [{ acquired: true }] };
      }

      if (sql === "BEGIN" || sql === "COMMIT") {
        return { rows: [] };
      }
      if (sql === "SELECT NOW() AS digest_now") {
        return { rows: [{ digest_now: "2026-04-15T00:00:00.000Z" }] };
      }

      if (sql.includes("AS stage_slug") && sql.includes("on_hold_accumulated_seconds")) {
        return { rows: [] };
      }

      if (sql.includes("AS total_disconnects")) {
        return {
          rows: [
            {
              total_disconnects: 7,
              critical_disconnects: 3,
              bid_board_sync_drifts: 2,
              follow_through_gaps: 1,
            },
          ],
        };
      }

      if (sql.includes("bid_board_sync_break")) {
        return {
          rows: [
            {
              cluster_key: "bid_board_sync_break",
              title: "Bid board / CRM stage drift",
              deal_count: 2,
            },
          ],
        };
      }

      if (sql.includes("AS hotspot_key")) {
        return {
          rows: [
            {
              hotspot_key: "Morgan Rep",
              hotspot_label: "Morgan Rep",
              disconnect_count: 3,
              critical_count: 2,
            },
          ],
        };
      }

      if (sql.includes("FROM public.users") && sql.includes("role IN ('director', 'admin')")) {
        return { rows: [{ id: "director-1" }, { id: "admin-1" }] };
      }

      if (sql.includes("FROM office_beta.notifications") && sql.includes("AI Disconnect Digest:%")) {
        return { rows: [] };
      }

      if (sql.includes("INSERT INTO office_beta.notifications")) {
        return { rows: [{ id: "notification-1" }] };
      }

      if (sql.includes("SELECT pg_advisory_unlock")) {
        return { rows: [] };
      }

      throw new Error(`Unexpected SQL: ${sql} :: ${JSON.stringify(params)}`);
    });

    await runAiDisconnectDigest();

    const inserts = queryMock.mock.calls.filter(([sql]) => typeof sql === "string" && sql.includes("INSERT INTO office_beta.notifications"));
    expect(inserts).toHaveLength(2);
    expect(inserts[0]?.[1]).toEqual([
      "director-1",
      "system",
      "AI Disconnect Digest: 7 open issues in Beta",
      "3 critical disconnects. Top cluster: Bid board / CRM stage drift (2 deals). Main hotspot: Morgan Rep (3 disconnects, 2 critical). Admin focus: prioritize bid board reconciliation before follow-through gaps spread. Recommended action: escalate bid board drift items first, then clear missing-next-step follow-through gaps. Bid board drifts: 2. Follow-through gaps: 1.",
      "/admin/sales-process-disconnects",
    ]);
  });

  it("skips duplicate digest notifications for the same day", async () => {
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM public.offices WHERE is_active = true")) {
        return { rows: [{ id: "office-1", slug: "beta", name: "Beta" }] };
      }
      if (sql.includes("FROM information_schema.schemata")) return { rows: [{ schema_name: "office_beta" }] };
      if (sql.includes("SELECT pg_try_advisory_lock")) return { rows: [{ acquired: true }] };
      if (sql === "BEGIN" || sql === "COMMIT") return { rows: [] };
      if (sql === "SELECT NOW() AS digest_now") return { rows: [{ digest_now: "2026-04-15T00:00:00.000Z" }] };
      if (sql.includes("AS stage_slug") && sql.includes("on_hold_accumulated_seconds")) return { rows: [] };
      if (sql.includes("AS total_disconnects")) {
        return { rows: [{ total_disconnects: 7, critical_disconnects: 3, bid_board_sync_drifts: 2, follow_through_gaps: 1 }] };
      }
      if (sql.includes("bid_board_sync_break")) {
        return { rows: [{ cluster_key: "bid_board_sync_break", title: "Bid board / CRM stage drift", deal_count: 2 }] };
      }
      if (sql.includes("AS hotspot_key")) {
        return { rows: [{ hotspot_key: "Morgan Rep", hotspot_label: "Morgan Rep", disconnect_count: 3, critical_count: 2 }] };
      }
      if (sql.includes("FROM public.users") && sql.includes("role IN ('director', 'admin')")) {
        return { rows: [{ id: "director-1" }] };
      }
      if (sql.includes("FROM office_beta.notifications") && sql.includes("AI Disconnect Digest:%")) {
        return { rows: [{ id: "notification-1" }] };
      }
      if (sql.includes("SELECT pg_advisory_unlock")) return { rows: [] };
      if (sql.includes("INSERT INTO office_beta.notifications")) {
        throw new Error("should not insert duplicate digest");
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });

    await runAiDisconnectDigest();
  });

  it("counts stale-stage disconnects with the hold-aware At Risk engine", async () => {
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM public.offices WHERE is_active = true")) {
        return { rows: [{ id: "office-1", slug: "beta", name: "Beta" }] };
      }
      if (sql.includes("FROM information_schema.schemata")) return { rows: [{ schema_name: "office_beta" }] };
      if (sql.includes("SELECT pg_try_advisory_lock")) return { rows: [{ acquired: true }] };
      if (sql === "BEGIN" || sql === "COMMIT") return { rows: [] };
      if (sql === "SELECT NOW() AS digest_now") return { rows: [{ digest_now: "2026-04-15T00:00:00.000Z" }] };
      if (sql.includes("AS stage_slug") && sql.includes("on_hold_accumulated_seconds")) {
        return {
          rows: [
            {
              id: "deal-held",
              assigned_rep_name: "Morgan Rep",
              stage_slug: "estimating",
              workflow_route: "normal",
              stage_entered_at: "2026-03-01T00:00:00.000Z",
              on_hold: true,
              on_hold_started_at: "2026-04-10T00:00:00.000Z",
              on_hold_accumulated_seconds: 0,
              on_hold_accumulated_seconds_at_stage_entry: 0,
            },
            {
              id: "deal-risk",
              assigned_rep_name: "Morgan Rep",
              stage_slug: "estimating",
              workflow_route: "normal",
              stage_entered_at: "2026-03-01T00:00:00.000Z",
              on_hold: false,
              on_hold_started_at: null,
              on_hold_accumulated_seconds: 0,
              on_hold_accumulated_seconds_at_stage_entry: 0,
            },
          ],
        };
      }
      if (sql.includes("AS total_disconnects")) {
        return {
          rows: [
            {
              total_disconnects: 0,
              critical_disconnects: 0,
              bid_board_sync_drifts: 0,
              follow_through_gaps: 0,
            },
          ],
        };
      }
      if (sql.includes("bid_board_sync_break")) {
        return { rows: [{ cluster_key: "stale_stage", title: "Stale stage", deal_count: 1 }] };
      }
      if (sql.includes("AS hotspot_key")) {
        return { rows: [{ hotspot_key: "Morgan Rep", hotspot_label: "Morgan Rep", disconnect_count: 1, critical_count: 0 }] };
      }
      if (sql.includes("FROM public.users") && sql.includes("role IN ('director', 'admin')")) {
        return { rows: [{ id: "director-1" }] };
      }
      if (sql.includes("FROM office_beta.notifications") && sql.includes("AI Disconnect Digest:%")) {
        return { rows: [] };
      }
      if (sql.includes("INSERT INTO office_beta.notifications")) {
        return { rows: [{ id: "notification-1" }] };
      }
      if (sql.includes("SELECT pg_advisory_unlock")) return { rows: [] };
      throw new Error(`Unexpected SQL: ${sql}`);
    });

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-15T00:00:00.000Z"));

    await runAiDisconnectDigest();

    const atRiskSql = queryMock.mock.calls
      .map(([sql]) => sql)
      .find((sql) => typeof sql === "string" && sql.includes("AS stage_slug"));
    expect(atRiskSql).toContain("on_hold");
    expect(atRiskSql).not.toContain("stale_threshold_days");
    const insert = queryMock.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("INSERT INTO office_beta.notifications")
    );
    expect(insert?.[1]?.[2]).toBe("AI Disconnect Digest: 1 open issues in Beta");
    expect(insert?.[1]?.[3]).toContain("Main hotspot: Morgan Rep (1 disconnects, 0 critical).");

    vi.useRealTimers();
  });

  it("uses the transaction DB clock for stale-stage calculations", async () => {
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM public.offices WHERE is_active = true")) {
        return { rows: [{ id: "office-1", slug: "beta", name: "Beta" }] };
      }
      if (sql.includes("FROM information_schema.schemata")) return { rows: [{ schema_name: "office_beta" }] };
      if (sql.includes("SELECT pg_try_advisory_lock")) return { rows: [{ acquired: true }] };
      if (sql === "BEGIN" || sql === "COMMIT") return { rows: [] };
      if (sql === "SELECT NOW() AS digest_now") return { rows: [{ digest_now: "2026-04-15T00:00:00.000Z" }] };
      if (sql.includes("AS stage_slug") && sql.includes("on_hold_accumulated_seconds")) {
        return {
          rows: [
            {
              id: "deal-not-yet-risk-by-db-clock",
              assigned_rep_name: "Morgan Rep",
              stage_slug: "estimating",
              workflow_route: "normal",
              stage_entered_at: "2026-04-05T00:00:00.000Z",
              on_hold: false,
              on_hold_started_at: null,
              on_hold_accumulated_seconds: 0,
              on_hold_accumulated_seconds_at_stage_entry: 0,
            },
          ],
        };
      }
      if (sql.includes("AS total_disconnects")) {
        return {
          rows: [
            {
              total_disconnects: 0,
              critical_disconnects: 0,
              bid_board_sync_drifts: 0,
              follow_through_gaps: 0,
            },
          ],
        };
      }
      if (sql.includes("SELECT pg_advisory_unlock")) return { rows: [] };
      if (sql.includes("INSERT INTO office_beta.notifications")) {
        throw new Error("should not count stale-stage rows using app wall clock");
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-15T00:00:00.000Z"));

    await runAiDisconnectDigest();

    const clockCallIndex = queryMock.mock.calls.findIndex(([sql]) => sql === "SELECT NOW() AS digest_now");
    const atRiskCallIndex = queryMock.mock.calls.findIndex(
      ([sql]) => typeof sql === "string" && sql.includes("AS stage_slug")
    );
    expect(clockCallIndex).toBeGreaterThan(-1);
    expect(atRiskCallIndex).toBeGreaterThan(clockCallIndex);
    expect(
      queryMock.mock.calls.some(([sql]) => typeof sql === "string" && sql.includes("INSERT INTO office_beta.notifications"))
    ).toBe(false);

    vi.useRealTimers();
  });

  it("ranks engine stale-stage clusters and SQL hotspots together", async () => {
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM public.offices WHERE is_active = true")) {
        return { rows: [{ id: "office-1", slug: "beta", name: "Beta" }] };
      }
      if (sql.includes("FROM information_schema.schemata")) return { rows: [{ schema_name: "office_beta" }] };
      if (sql.includes("SELECT pg_try_advisory_lock")) return { rows: [{ acquired: true }] };
      if (sql === "BEGIN" || sql === "COMMIT") return { rows: [] };
      if (sql === "SELECT NOW() AS digest_now") return { rows: [{ digest_now: "2026-04-15T00:00:00.000Z" }] };
      if (sql.includes("AS stage_slug") && sql.includes("on_hold_accumulated_seconds")) {
        return {
          rows: Array.from({ length: 4 }, (_, index) => ({
            id: `deal-risk-${index}`,
            assigned_rep_name: "Morgan Rep",
            stage_slug: "estimating",
            workflow_route: "normal",
            stage_entered_at: "2026-03-01T00:00:00.000Z",
            on_hold: false,
            on_hold_started_at: null,
            on_hold_accumulated_seconds: 0,
            on_hold_accumulated_seconds_at_stage_entry: 0,
          })),
        };
      }
      if (sql.includes("AS total_disconnects")) {
        return {
          rows: [
            {
              total_disconnects: 2,
              critical_disconnects: 2,
              bid_board_sync_drifts: 0,
              follow_through_gaps: 2,
            },
          ],
        };
      }
      if (sql.includes("bid_board_sync_break")) {
        return { rows: [{ cluster_key: "follow_through_gap", title: "Customer follow-through gap", deal_count: 2 }] };
      }
      if (sql.includes("AS hotspot_key")) {
        return { rows: [{ hotspot_key: "Jordan Rep", hotspot_label: "Jordan Rep", disconnect_count: 2, critical_count: 2 }] };
      }
      if (sql.includes("FROM public.users") && sql.includes("role IN ('director', 'admin')")) {
        return { rows: [{ id: "director-1" }] };
      }
      if (sql.includes("FROM office_beta.notifications") && sql.includes("AI Disconnect Digest:%")) {
        return { rows: [] };
      }
      if (sql.includes("INSERT INTO office_beta.notifications")) {
        return { rows: [{ id: "notification-1" }] };
      }
      if (sql.includes("SELECT pg_advisory_unlock")) return { rows: [] };
      throw new Error(`Unexpected SQL: ${sql}`);
    });

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-15T00:00:00.000Z"));

    await runAiDisconnectDigest();

    const insert = queryMock.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("INSERT INTO office_beta.notifications")
    );
    expect(insert?.[1]?.[3]).toContain("Top cluster: SLA / stage momentum (4 deals).");
    expect(insert?.[1]?.[3]).toContain("Main hotspot: Jordan Rep (2 disconnects, 2 critical).");

    vi.useRealTimers();
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

    await runAiDisconnectDigest();

    expect(
      queryMock.mock.calls.some(([sql]) => typeof sql === "string" && sql === "BEGIN")
    ).toBe(false);
  });
});
