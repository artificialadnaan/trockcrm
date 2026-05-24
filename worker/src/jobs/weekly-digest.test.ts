import { describe, expect, it, vi } from "vitest";

const connectMock = vi.hoisted(() => vi.fn());

vi.mock("../db.js", () => ({
  pool: {
    connect: connectMock,
  },
}));

import { runWeeklyDigest } from "./weekly-digest.js";

describe("weekly digest reportability", () => {
  it("excludes active on-hold deals from weekly digest report aggregates", async () => {
    const queries: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        if (sql.includes("SELECT id, slug, name FROM public.offices")) {
          return {
            rows: [{ id: "00000000-0000-4000-8000-000000000001", slug: "north", name: "North" }],
            rowCount: 1,
          };
        }
        if (sql.includes("pg_try_advisory_lock")) return { rows: [{ acquired: true }], rowCount: 1 };
        if (sql.includes("FROM public.users")) return { rows: [], rowCount: 0 };
        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn(),
    };
    connectMock.mockResolvedValue(client);

    await runWeeklyDigest();

    const staleSql = queries.find((query) => query.includes("AS stage_entered_at"));
    const approachingSql = queries.find((query) => query.includes("expected_close_date BETWEEN"));
    const newDealsSql = queries.find((query) => query.includes("created_at >= NOW() - interval '7 days'"));
    const pipelineValueSql = queries.find((query) => query.includes("AS total_value"));

    expect(staleSql).toContain("COALESCE(d.on_hold, false) = false");
    expect(approachingSql).toContain("COALESCE(d.on_hold, false) = false");
    expect(newDealsSql).toContain("COALESCE(d.on_hold, false) = false");
    expect(pipelineValueSql).toContain("COALESCE(d.on_hold, false) = false");
  });
});
