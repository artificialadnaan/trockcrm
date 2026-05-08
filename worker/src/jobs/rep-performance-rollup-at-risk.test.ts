import { describe, expect, it, vi } from "vitest";

const connectMock = vi.hoisted(() => vi.fn());

vi.mock("../db.js", () => ({
  pool: {
    connect: connectMock,
  },
}));

import { runRepPerformanceRollup } from "./rep-performance-rollup.js";

describe("rep performance rollup at-risk period boundary", () => {
  it("scopes at_risk_count to period_end instead of wall-clock time", async () => {
    const queries: string[] = [];
    const client = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        queries.push(`${sql}\n-- params: ${JSON.stringify(params ?? [])}`);
        if (sql.includes("SELECT id, slug, name FROM public.offices")) {
          return { rows: [{ id: "office-1", slug: "north", name: "North" }], rowCount: 1 };
        }
        return { rows: [], rowCount: sql.includes("INSERT INTO public.rep_performance_snapshots") ? 1 : 0 };
      }),
      release: vi.fn(),
    };
    connectMock.mockResolvedValue(client);

    await runRepPerformanceRollup(new Date("2026-05-07T12:00:00.000Z"));

    const insertSql = queries.find((query) => query.includes("INSERT INTO public.rep_performance_snapshots"));
    expect(insertSql).toContain(
      "d.stage_entered_at < $3::timestamptz - (psc.stale_threshold_days || ' days')::interval"
    );
    expect(insertSql).not.toContain(
      "d.stage_entered_at < NOW() - (psc.stale_threshold_days || ' days')::interval"
    );
  });
});
