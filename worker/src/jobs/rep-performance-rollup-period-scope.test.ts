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
    // The aggregate contains TWO independent period CASEs — one selecting the VALUE expression, one inside
    // FILTER selecting the row predicate. Slice them apart first: searching the whole aggregate let the
    // value CASE satisfy assertions meant for the filter (so a filter selector regressed to `WHEN false`
    // still passed), and let the auto-park guard satisfy "present" from either arm (Codex P2 x2).
    const pipelineAggregate = (() => {
      const marker = ")::numeric AS pipeline_value";
      const end = (insertSql ?? "").indexOf(marker);
      if (end < 0) return undefined;
      const start = (insertSql ?? "").lastIndexOf("COALESCE(SUM(", end);
      return start < 0 ? undefined : (insertSql ?? "").slice(start, end);
    })();
    expect(pipelineAggregate).toBeDefined();

    const filterAt = pipelineAggregate!.indexOf("FILTER (");
    expect(filterAt).toBeGreaterThan(-1);
    const valueExpression = pipelineAggregate!.slice(0, filterAt);
    const filterClause = pipelineAggregate!.slice(filterAt);

    // --- the VALUE expression: which arm gets the auto-park guard --------------------------------
    // The nested value chain carries a CASE ... ELSE ... END of its own (the change-order branch), so
    // "the first ELSE after the period THEN" is NOT the period CASE's ELSE. Walk CASE/END depth and split
    // on the ELSE at depth 0 — the period CASE's own — instead of the first one textually.
    const periodSelector = "CASE WHEN $1::text IN ('last_month', 'last_quarter', 'last_year') THEN";
    const valueThenAt = valueExpression.indexOf(periodSelector);
    expect(valueThenAt).toBeGreaterThan(-1);
    const afterThen = valueExpression.slice(valueThenAt + periodSelector.length);
    const elseAt = (() => {
      const tokens = /\bCASE\b|\bEND\b|\bELSE\b/g;
      let depth = 0;
      let token: RegExpExecArray | null;
      while ((token = tokens.exec(afterThen)) !== null) {
        if (token[0] === "CASE") depth += 1;
        else if (token[0] === "END") depth -= 1;
        else if (depth === 0) return token.index;
      }
      return -1;
    })();
    expect(elseAt).toBeGreaterThan(-1);
    const historicalValueArm = afterThen.slice(0, elseAt);
    const currentValueArm = afterThen.slice(elseAt);

    // Both arms sum the real deal-value chain, never a constant or closed_value's awarded-first chain.
    for (const arm of [historicalValueArm, currentValueArm]) {
      expect(arm).toContain("d.bid_board_total_sales");
      expect(arm).toContain("d.bid_estimate");
      expect(arm).toContain("d.dd_estimate");
    }
    // THE INVARIANT: the auto-park guard belongs to the CURRENT arm ONLY. If it ever appears in the
    // historical arm, a closed snapshot would be recalculated against today's 90-day horizon — a deal won
    // early with a stale far-future target would silently drop out of a period that already reported it.
    expect(historicalValueArm).not.toContain("bid_board_stage_slug");
    expect(historicalValueArm).not.toContain("90 days");
    expect(currentValueArm).toContain("bid_board_stage_slug");
    expect(currentValueArm).toContain("90 days");

    // --- the FILTER: which rows each period counts ------------------------------------------------
    // Extracted from filterClause ONLY, so a regressed filter selector cannot be satisfied by the value
    // CASE above.
    const historicalPipelineValueBranch =
      /WHEN \$1::text IN \('last_month', 'last_quarter', 'last_year'\) THEN([\s\S]*?)ELSE d\.is_active = true AND NOT psc\.is_terminal AND psc\.is_active_pipeline/.exec(
        filterClause
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
