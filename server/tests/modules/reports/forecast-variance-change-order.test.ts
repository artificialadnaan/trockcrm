import { describe, expect, it, vi } from "vitest";

/**
 * One test for the forecast-variance reader, asserting BOTH halves of the change together.
 *
 * This PR has shipped the select/mapper pair out of step three times, in both directions: a SELECT added
 * without its mapper (pending-rfp, project photo stats), and — in this very reader — a mapper reading a
 * column the query never produced. That last one was worse than a silent `undefined`: the outer SELECT
 * referenced `deal_is_change_order` from a CTE that did not project it, which is a Postgres error, and a
 * mocked `execute` hides it completely.
 *
 * Typecheck cannot see either direction (the field is optional by design, the row is `any`), so the SQL
 * TEXT and the mapped OUTPUT have to be asserted side by side.
 *
 * Its own file rather than forecast-variance.test.ts: that file mocks rbac and imports the route module,
 * and a `tenantDb` handed to the service there never receives the calls.
 */
describe("forecast variance carries deals.is_change_order end to end", () => {
  function extractSqlText(value: unknown): string {
    if (typeof value === "string") return value;
    if (!value || typeof value !== "object") return "";
    if (Array.isArray((value as { queryChunks?: unknown[] }).queryChunks)) {
      return (value as { queryChunks: unknown[] }).queryChunks.map(extractSqlText).join("");
    }
    if ("value" in (value as Record<string, unknown>)) {
      const inner = (value as { value: unknown }).value;
      if (Array.isArray(inner)) return inner.map(extractSqlText).join("");
      if (typeof inner === "string") return inner;
    }
    return "";
  }

  /** summary, rep rollups, deals — in that order. */
  function dealsQueryDb(dealRows: unknown[]) {
    const queue: unknown[][] = [[], [], dealRows];
    const execute = vi.fn().mockImplementation(async () => ({ rows: queue.shift() ?? [] }));
    return { execute } as any;
  }

  it("selects the column in the deals CTE, projects it through the outer SELECT, and maps it out", async () => {
    const { getForecastVarianceOverview } = await import("../../../src/modules/reports/service.js");
    const tenantDb = dealsQueryDb([
      { deal_id: "deal-1", deal_name: "Tides — Change Order 2", deal_is_change_order: true, rep_name: "Alice", workflow_route: "normal" },
    ]);

    const result = await getForecastVarianceOverview(tenantDb, {});

    // The MAPPER's half.
    expect(result.deals[0]?.dealIsChangeOrder).toBe(true);

    // The QUERY's half — both hops, or the mapper reads something that never arrives.
    const sqlText = tenantDb.execute.mock.calls.map(([arg]: [unknown]) => extractSqlText(arg)).join("\n");
    expect(sqlText).toContain("d.is_change_order AS deal_is_change_order");
    expect(sqlText).toMatch(/SELECT\s+deal_id,\s+deal_name,[\s\S]{0,400}?deal_is_change_order,/);
  });

  it("does not coerce an absent flag to false", async () => {
    const { getForecastVarianceOverview } = await import("../../../src/modules/reports/service.js");
    const tenantDb = dealsQueryDb([{ deal_id: "d", deal_name: "Tides", rep_name: "A", workflow_route: "normal" }]);
    const result = await getForecastVarianceOverview(tenantDb, {});
    expect(result.deals[0]?.dealIsChangeOrder).toBeUndefined();
  });
});
