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
    // Pin the FILTER semantics, not the shape of the value expression. The old matcher inlined the
    // awarded-amount CASE, so when pipeline_value moved to a composed `periodAwarePipelineValueSql`
    // (the effective-value/auto-park work) it silently matched NOTHING and the assertions below became
    // vacuous — the failure only surfaced once these files were actually wired into a runner.
    const pipelineValueSql = (() => {
      const marker = ")::numeric AS pipeline_value";
      const end = (insertSql ?? "").indexOf(marker);
      if (end < 0) return undefined;
      const start = (insertSql ?? "").lastIndexOf("COALESCE(SUM(", end);
      return start < 0 ? undefined : (insertSql ?? "").slice(start, end);
    })();
    const historicalPipelineValueBranch =
      /WHEN \$1::text IN \('last_month', 'last_quarter', 'last_year'\) THEN([\s\S]*?)ELSE d\.is_active = true AND NOT psc\.is_terminal AND psc\.is_active_pipeline/.exec(
        pipelineValueSql ?? ""
      )?.[1];

    // Guard the VALUE expression too, not just the FILTER. The extracted slice contains both; asserting
    // only the filter would let a regression that summed a constant (or the wrong value chain) pass, and
    // the later precedence assertions cannot cover it because the same expressions also appear in
    // closed_value's awardedFirstDealValueSql (Codex P2).
    expect(pipelineValueSql).toBeDefined();
    // pipeline_value is period-aware: HISTORICAL periods sum the RAW current value, so a closed snapshot
    // is never re-zeroed by today's 90-day auto-park horizon; current periods sum the effective value.
    expect(pipelineValueSql).toMatch(
      /CASE WHEN \$1::text IN \('last_month', 'last_quarter', 'last_year'\) THEN[\s\S]*?ELSE[\s\S]*?END/
    );
    const valueExpression = pipelineValueSql?.slice(0, pipelineValueSql.indexOf("FILTER ("));
    // The real deal-value chain is summed, not a constant or the awarded-first chain used by closed_value.
    expect(valueExpression).toContain("d.bid_board_total_sales");
    expect(valueExpression).toContain("d.bid_estimate");
    expect(valueExpression).toContain("d.dd_estimate");
    // ...and the CURRENT-period leg carries the auto-park guard (Bid Board mirror + the 90-day horizon),
    // which is precisely what historical periods must NOT apply.
    expect(valueExpression).toContain("bid_board_stage_slug");
    expect(valueExpression).toContain("90 days");

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

  it("keeps closed_value awarded-first while pipeline_value uses current deal value precedence", async () => {
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
    expect(insertSql).toContain("CASE WHEN d.bid_board_total_sales > 0 THEN d.bid_board_total_sales END");
    expect(insertSql).toContain("CASE WHEN d.awarded_amount > 0 THEN d.awarded_amount END");
    expect(insertSql).not.toContain("NULLIF(d.bid_board_total_sales, 0)");
    expect(insertSql).toContain("'won'");
    expect(insertSql).toContain("'sent_to_production'");
    expect(insertSql).toContain("'service_sent_to_production'");
    expect(insertSql).toContain("'service_scheduled'");
    expect(insertSql).toContain("'service_complete'");
    expect(insertSql).toContain("'closed_won'");
    expect(insertSql).not.toContain("'in_production'");
    expect(insertSql).not.toContain("'close_out'");
  });
});
