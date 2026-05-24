import { describe, expect, it, vi } from "vitest";

const connectMock = vi.hoisted(() => vi.fn());

vi.mock("../db.js", () => ({
  pool: {
    connect: connectMock,
  },
}));

import { computeRepAtRiskCountsFromRows, runRepPerformanceRollup } from "./rep-performance-rollup.js";

const dayMs = 24 * 60 * 60 * 1000;

function atRiskRow(
  overrides: Partial<Parameters<typeof computeRepAtRiskCountsFromRows>[0][number]> = {}
) {
  return {
    rep_id: "rep-1",
    stage_slug: "estimating",
    workflow_route: "normal",
    stage_entered_at: "2026-04-23T00:00:00.000Z",
    on_hold: false,
    on_hold_started_at: null,
    on_hold_accumulated_seconds: 0,
    on_hold_accumulated_seconds_at_stage_entry: 0,
    ...overrides,
  };
}

describe("rep performance rollup at-risk count", () => {
  it("computes at_risk_count with the shared engine, excluding active on-hold deals", () => {
    const asOf = new Date("2026-05-08T00:00:00.000Z");

    const counts = computeRepAtRiskCountsFromRows(
      [
        atRiskRow({
          rep_id: "rep-1",
          stage_entered_at: new Date(asOf.getTime() - 15 * dayMs).toISOString(),
        }),
        atRiskRow({
          rep_id: "rep-1",
          stage_entered_at: new Date(asOf.getTime() - 40 * dayMs).toISOString(),
          on_hold: true,
          on_hold_started_at: new Date(asOf.getTime() - dayMs).toISOString(),
        }),
        atRiskRow({
          rep_id: "rep-2",
          stage_entered_at: new Date(asOf.getTime() - 14 * dayMs).toISOString(),
        }),
        atRiskRow({
          rep_id: "rep-2",
          stage_slug: "won",
          stage_entered_at: new Date(asOf.getTime() - 90 * dayMs).toISOString(),
        }),
      ],
      asOf
    );

    expect(counts).toEqual([
      { repId: "rep-1", atRiskCount: 1 },
      { repId: "rep-2", atRiskCount: 1 },
    ]);
  });

  it("subtracts completed hold time before evaluating the shared engine", () => {
    const asOf = new Date("2026-05-08T00:00:00.000Z");

    const counts = computeRepAtRiskCountsFromRows(
      [
        atRiskRow({
          rep_id: "rep-1",
          stage_entered_at: new Date(asOf.getTime() - 20 * dayMs).toISOString(),
          on_hold: false,
          on_hold_accumulated_seconds: 10 * 24 * 60 * 60,
          on_hold_accumulated_seconds_at_stage_entry: 0,
        }),
        atRiskRow({
          rep_id: "rep-1",
          stage_entered_at: new Date(asOf.getTime() - 20 * dayMs).toISOString(),
          on_hold: false,
          on_hold_accumulated_seconds: 5 * 24 * 60 * 60,
          on_hold_accumulated_seconds_at_stage_entry: 0,
        }),
      ],
      asOf
    );

    expect(counts).toEqual([{ repId: "rep-1", atRiskCount: 1 }]);
  });

  it("fetches engine input rows and injects the computed counts into the snapshot insert", async () => {
    const queries: string[] = [];
    const params: unknown[][] = [];
    const client = {
      query: vi.fn(async (sql: string, queryParams?: unknown[]) => {
        queries.push(`${sql}\n-- params: ${JSON.stringify(queryParams ?? [])}`);
        params.push(queryParams ?? []);
        if (sql.includes("SELECT id, slug, name FROM public.offices")) {
          return { rows: [{ id: "office-1", slug: "north", name: "North" }], rowCount: 1 };
        }
        if (sql.includes("AS stage_slug") && sql.includes("on_hold_accumulated_seconds")) {
          return {
            rows: [
              atRiskRow({ rep_id: "rep-1", stage_entered_at: "2026-04-23T00:00:00.000Z" }),
              atRiskRow({
                rep_id: "rep-1",
                stage_entered_at: "2026-04-01T00:00:00.000Z",
                on_hold: true,
                on_hold_started_at: "2026-05-01T00:00:00.000Z",
              }),
            ],
            rowCount: 2,
          };
        }
        return {
          rows: [],
          rowCount: sql.includes("INSERT INTO public.rep_performance_snapshots") ? 1 : 0,
        };
      }),
      release: vi.fn(),
    };
    connectMock.mockResolvedValue(client);

    await runRepPerformanceRollup(new Date("2026-05-07T12:00:00.000Z"));

    const atRiskInputSql = queries.find(
      (query) => query.includes("AS stage_slug") && query.includes("on_hold_accumulated_seconds")
    );
    const insertSql = queries.find((query) =>
      query.includes("INSERT INTO public.rep_performance_snapshots")
    );
    const insertIndex = queries.findIndex((query) =>
      query.includes("INSERT INTO public.rep_performance_snapshots")
    );
    const insertParams = params[insertIndex];

    expect(atRiskInputSql).toContain("COALESCE(d.bid_board_stage_slug, psc.slug) AS stage_slug");
    expect(atRiskInputSql).toContain("d.workflow_route");
    expect(atRiskInputSql).toContain("d.on_hold");
    expect(atRiskInputSql).toContain("d.on_hold_started_at");
    expect(atRiskInputSql).toContain("d.on_hold_accumulated_seconds");
    expect(atRiskInputSql).toContain("d.on_hold_accumulated_seconds_at_stage_entry");
    expect(atRiskInputSql).toContain("COALESCE(d.is_test_data, false) = false");
    expect(insertSql).toContain("at_risk_counts AS (");
    expect(insertSql).toContain("jsonb_to_recordset($7::jsonb)");
    expect(insertSql).toContain("COALESCE(arc.at_risk_count, 0)");
    expect(insertParams?.[6]).toBe(JSON.stringify([{ repId: "rep-1", atRiskCount: 1 }]));
    expect(insertSql).toContain("COALESCE(d.on_hold, false) = false");
    expect(insertSql).not.toMatch(/stale_threshold_days/);
    expect(insertSql).not.toMatch(/stage_entered_at < now\(\)/i);
  });

  it("evaluates persisted at_risk_count at period_end midnight, not the following day", async () => {
    const queries: string[] = [];
    const params: unknown[][] = [];
    const client = {
      query: vi.fn(async (sql: string, queryParams?: unknown[]) => {
        queries.push(sql);
        params.push(queryParams ?? []);
        if (sql.includes("SELECT id, slug, name FROM public.offices")) {
          return { rows: [{ id: "office-1", slug: "north", name: "North" }], rowCount: 1 };
        }
        if (sql.includes("AS stage_slug") && sql.includes("on_hold_accumulated_seconds")) {
          return {
            rows: [
              atRiskRow({
                rep_id: "rep-1",
                stage_entered_at: "2026-04-24T00:00:00.000Z",
              }),
            ],
            rowCount: 1,
          };
        }
        return {
          rows: [],
          rowCount: sql.includes("INSERT INTO public.rep_performance_snapshots") ? 1 : 0,
        };
      }),
      release: vi.fn(),
    };
    connectMock.mockResolvedValue(client);

    await runRepPerformanceRollup(new Date("2026-05-07T12:00:00.000Z"));

    const insertIndex = queries.findIndex((query) =>
      query.includes("INSERT INTO public.rep_performance_snapshots")
    );

    expect(params[insertIndex]?.[6]).toBe(JSON.stringify([]));
  });
});
