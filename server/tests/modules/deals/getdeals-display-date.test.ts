import { describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

/**
 * Batch A (server) Phase 0 — getDeals SELECTs an outcome-aware `displayDate` so
 * the date a surface DISPLAYS is the SAME axis it FILTERS on (filter-axis ==
 * display-axis). This is the server half RED's #554 `getDealDisplayDate` waits on
 * ("falls back to the close chain until the backend SELECTs displayDate").
 *
 * The CASE behavior (won->won_closed_date, lost->lost_at, open->stage_entered_at)
 * is row-proven in shared/deal-date-scope.runtime.test.ts. This proves the
 * WIRING: getDeals projects the display CASE built from the SAME Won/Lost stage
 * ids the filter uses, and emits NULL (client falls back to close) when no
 * outcome dimension is in play — so a plain list pays no extra listDealStages cost.
 */

// listDealStages() reads the module-level db (not the tenantDb arg). Stub it so
// the date path can resolve won/lost stage ids without a real database.
vi.mock("../../../src/db.js", () => {
  const stages = [
    { id: "won-1", slug: "won", workflowFamily: "standard_deal" },
    { id: "lost-1", slug: "lost", workflowFamily: "standard_deal" },
    { id: "op-1", slug: "opportunity", workflowFamily: "standard_deal" },
  ];
  const chain: Record<string, unknown> = {};
  chain.select = () => chain;
  chain.from = () => chain;
  chain.where = () => chain;
  chain.orderBy = () => Promise.resolve(stages);
  return { db: chain, pool: {} };
});

const dialect = new PgDialect();
const renderText = (value: unknown) => dialect.sqlToQuery(value as never).sql.toLowerCase();

// Capture each top-level tenantDb.select({...}) projection so we can inspect the
// dealRows query's `displayDate` expression (the count queries select {count}).
function createTenantDbCapturingSelect() {
  const capturedSelects: Array<Record<string, unknown>> = [];
  const dataChain: Record<string, unknown> = {};
  dataChain.from = () => dataChain;
  dataChain.leftJoin = () => dataChain;
  dataChain.where = () => dataChain;
  dataChain.orderBy = () => dataChain;
  dataChain.limit = () => dataChain;
  dataChain.offset = () => Promise.resolve([]);
  (dataChain as { then: unknown }).then = (resolve: (rows: unknown[]) => unknown) => resolve([{ count: 0 }]);
  const db = {
    select: (projection?: Record<string, unknown>) => {
      if (projection) capturedSelects.push(projection);
      return dataChain;
    },
  } as never;
  return { db, capturedSelects };
}

const displayDateProjection = (selects: Array<Record<string, unknown>>) =>
  selects.find((p) => "displayDate" in p);

describe("getDeals — outcome-aware display_date projection (filter-axis == display-axis)", () => {
  it("projects displayDate as the outcome CASE (won_closed_date / lost_at / stage_entered_at), classified by the same Won/Lost stage ids, when a date window is set", async () => {
    const { db, capturedSelects } = createTenantDbCapturingSelect();
    const { getDeals } = await import("../../../src/modules/deals/service.js");

    await getDeals(db, { dateFrom: "2026-01-01", dateTo: "2026-03-31", scope: "all" }, "director", "director-1");

    const projection = displayDateProjection(capturedSelects);
    expect(projection).toBeDefined();
    const sql = renderText(projection!.displayDate);
    expect(sql).toContain("case");
    expect(sql).toContain("won_closed_date"); // Won rows -> canonical won-close date
    expect(sql).toContain("lost_at"); // Lost rows -> lost date
    expect(sql).toContain("stage_entered_at"); // open rows -> entered-current-stage date
    expect(sql).toContain("stage_id"); // classified by the resolved Won/Lost stage ids
  });

  it("emits displayDate = NULL when no outcome dimension is set (no extra listDealStages cost; client falls back to the close chain)", async () => {
    const { db, capturedSelects } = createTenantDbCapturingSelect();
    const { getDeals } = await import("../../../src/modules/deals/service.js");

    await getDeals(db, { scope: "all" }, "director", "director-1");

    const projection = displayDateProjection(capturedSelects);
    expect(projection).toBeDefined();
    const sql = renderText(projection!.displayDate);
    expect(sql).toContain("null");
    expect(sql).not.toContain("case");
  });

  it("uses the SAME Won/Lost classification for the displayed date as for the filter (so the displayed axis cannot diverge from the filtered axis)", async () => {
    const { db, capturedSelects } = createTenantDbCapturingSelect();
    const { getDeals } = await import("../../../src/modules/deals/service.js");

    await getDeals(db, { dateFrom: "2026-01-01", dateTo: "2026-03-31", scope: "all" }, "director", "director-1");

    const projection = displayDateProjection(capturedSelects);
    const displaySql = renderText(projection!.displayDate);
    // The display CASE classifies on stage_id IN (...) exactly like the filter's
    // outcome scope — both built from the resolved won/lost stage ids.
    expect(displaySql).toContain('"stage_id" in');
  });
});
