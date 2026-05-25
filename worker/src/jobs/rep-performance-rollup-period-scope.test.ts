import { describe, expect, it, vi } from "vitest";

const connectMock = vi.hoisted(() => vi.fn());

vi.mock("../db.js", () => ({
  pool: {
    connect: connectMock,
  },
}));

import { runRepPerformanceRollup } from "./rep-performance-rollup.js";

describe("rep performance rollup period scoping", () => {
  it("historical deals_count includes deals that were open during the period but are now terminal", async () => {
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
    expect(insertSql).toContain("WHEN $1::text IN ('last_month', 'last_quarter', 'last_year') THEN");
    expect(insertSql).toContain("d.created_at::date <= $3::date");
    expect(insertSql).toContain(
      "OR COALESCE(d.actual_close_date, d.contract_signed_date, d.contract_signed_at::date, d.lost_at::date) >= $2::date"
    );
    const dealsCountSql = /COUNT\(\*\) FILTER \(([\s\S]*?)\)::int AS deals_count/.exec(insertSql ?? "")?.[1];
    const historicalDealCountBranch =
      /WHEN \$1::text IN \('last_month', 'last_quarter', 'last_year'\) THEN([\s\S]*?)ELSE d\.is_active = true AND NOT psc\.is_terminal/.exec(
        dealsCountSql ?? ""
      )?.[1];

    expect(historicalDealCountBranch).toBeDefined();
    expect(historicalDealCountBranch).toContain("d.created_at::date <= $3::date");
    expect(historicalDealCountBranch).toContain(
      "OR COALESCE(d.actual_close_date, d.contract_signed_date, d.contract_signed_at::date, d.lost_at::date) >= $2::date"
    );
    const historicalDealCountPredicates = historicalDealCountBranch
      ?.split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n");
    expect(historicalDealCountPredicates).not.toContain("psc.is_terminal");
    expect(historicalDealCountPredicates).not.toContain("psc.is_active_pipeline");
  });

  it("historical pipeline_value includes deals that were open during the period but are now terminal", async () => {
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
    const pipelineValueSql =
      /COALESCE\(SUM\(COALESCE\(NULLIF\(d\.bid_board_total_sales, 0\), NULLIF\(d\.bid_estimate, 0\), NULLIF\(d\.dd_estimate, 0\), d\.awarded_amount, 0\)\)([\s\S]*?)\), 0\)::numeric AS pipeline_value/.exec(
        insertSql ?? ""
      )?.[1];
    const historicalPipelineValueBranch =
      /WHEN \$1::text IN \('last_month', 'last_quarter', 'last_year'\) THEN([\s\S]*?)ELSE d\.is_active = true AND NOT psc\.is_terminal AND psc\.is_active_pipeline/.exec(
        pipelineValueSql ?? ""
      )?.[1];

    expect(historicalPipelineValueBranch).toBeDefined();
    expect(historicalPipelineValueBranch).toContain("d.created_at::date <= $3::date");
    expect(historicalPipelineValueBranch).toContain(
      "OR COALESCE(d.actual_close_date, d.contract_signed_date, d.contract_signed_at::date, d.lost_at::date) >= $2::date"
    );
    const historicalPipelineValuePredicates = historicalPipelineValueBranch
      ?.split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n");
    expect(historicalPipelineValuePredicates).not.toContain("psc.is_terminal");
    expect(historicalPipelineValuePredicates).not.toContain("psc.is_active_pipeline");
  });

  it("keeps closed_value awarded-only while pipeline_value uses current deal value precedence", async () => {
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

    const insertSql = queries.find((query) => query.includes("INSERT INTO public.rep_performance_snapshots")) ?? "";
    expect(insertSql).toContain(
      "COALESCE(SUM(COALESCE(NULLIF(d.bid_board_total_sales, 0), NULLIF(d.bid_estimate, 0), NULLIF(d.dd_estimate, 0), d.awarded_amount, 0))"
    );
    expect(insertSql).toContain("COALESCE(SUM(COALESCE(d.awarded_amount, d.bid_estimate, d.dd_estimate, 0))");
  });
});
