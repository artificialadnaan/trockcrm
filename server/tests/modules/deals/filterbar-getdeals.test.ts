import { describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

/**
 * Integration: the FilterBar params flow through getDeals into the WHERE and
 * ORDER BY. The predicate registry + date model are unit-tested separately
 * (filter-predicates.test, deal-date-scope.test); this proves the WIRING:
 *  - Status owns is_active (legacy isActive block skipped — no double predicate);
 *  - value sort uses the effective chain (sort == filter);
 *  - the Unassigned sentinel becomes IS NULL (never a literal in params);
 *  - the date window classifies Won/Lost by resolved stage ids.
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
const render = (value: unknown) => dialect.sqlToQuery(value as never);
const renderText = (value: unknown) => render(value).sql.toLowerCase();

function createTenantDbCapturingWhere() {
  const capturedWheres: unknown[] = [];
  const capturedOrderBys: unknown[][] = [];
  const dataChain: Record<string, unknown> = {};
  dataChain.select = () => dataChain;
  dataChain.from = () => dataChain;
  dataChain.leftJoin = () => dataChain;
  dataChain.where = (condition: unknown) => {
    capturedWheres.push(condition);
    return dataChain;
  };
  dataChain.orderBy = (...args: unknown[]) => {
    capturedOrderBys.push(args);
    return dataChain;
  };
  dataChain.limit = () => dataChain;
  dataChain.offset = () => Promise.resolve([]);
  // count(*) / activeCount / the running-total aggregate all await the chain directly (no
  // limit/offset). Carry a `total` alongside `count` so the value-total aggregate (#4) can be
  // asserted through the same harness without a real database.
  (dataChain as { then: unknown }).then = (resolve: (rows: unknown[]) => unknown) =>
    resolve([{ count: 0, total: 4242 }]);
  return { db: { select: () => dataChain } as never, capturedWheres, capturedOrderBys };
}

// The main dealRows query is the LAST captured WHERE.
const mainWhere = (wheres: unknown[]) => renderText(wheres[wheres.length - 1]);

describe("getDeals — FilterBar wiring", () => {
  it("status=inactive emits is_active exactly once (legacy isActive block skipped)", async () => {
    const { db, capturedWheres } = createTenantDbCapturingWhere();
    const { getDeals } = await import("../../../src/modules/deals/service.js");

    await getDeals(db, { status: "inactive", scope: "all" }, "director", "director-1");

    const sql = mainWhere(capturedWheres);
    expect(sql.split('"is_active"').length - 1).toBe(1);
  });

  it("status=active emits both is_active and on_hold", async () => {
    const { db, capturedWheres } = createTenantDbCapturingWhere();
    const { getDeals } = await import("../../../src/modules/deals/service.js");

    await getDeals(db, { status: "active", scope: "all" }, "director", "director-1");

    const sql = mainWhere(capturedWheres);
    expect(sql).toContain('"is_active"');
    expect(sql).toContain("on_hold");
  });

  it("status=any behaves like unset: keeps the default active visibility (is_active), not all rows", async () => {
    // Codex #546: status=any must NOT skip the legacy is_active=true default, or
    // /api/deals?status=any leaks inactive/soft-deleted rows. "any" == omitted.
    const { db, capturedWheres } = createTenantDbCapturingWhere();
    const { getDeals } = await import("../../../src/modules/deals/service.js");

    await getDeals(db, { status: "any", scope: "all" }, "director", "director-1");

    const sql = mainWhere(capturedWheres);
    expect(sql).toContain('"is_active"'); // default active filter still applied
  });

  it("an unrecognized status passed through from the route becomes a no-match (sql false), never widened", async () => {
    // Codex #546: the route must pass raw values to the registry so a bad param
    // hits the predicate's no-match, instead of being normalized to undefined
    // (which would fall back to the active default and silently widen results).
    const { db, capturedWheres } = createTenantDbCapturingWhere();
    const { getDeals } = await import("../../../src/modules/deals/service.js");

    await getDeals(db, { status: "bogus" as never, scope: "all" }, "director", "director-1");

    const sql = mainWhere(capturedWheres);
    expect(sql).toContain("false"); // no-match sentinel from buildStatusPredicate
  });

  it("an unrecognized workflowRoute becomes a no-match (sql false), never widened", async () => {
    const { db, capturedWheres } = createTenantDbCapturingWhere();
    const { getDeals } = await import("../../../src/modules/deals/service.js");

    await getDeals(db, { workflowRoute: "bogus" as never, scope: "all" }, "director", "director-1");

    const sql = mainWhere(capturedWheres);
    expect(sql).toContain("false");
  });

  it("value range emits BETWEEN on the on-hold-zeroed effective chain", async () => {
    const { db, capturedWheres } = createTenantDbCapturingWhere();
    const { getDeals } = await import("../../../src/modules/deals/service.js");

    await getDeals(db, { valueMin: 100000, valueMax: 500000, scope: "all" }, "director", "director-1");

    const sql = mainWhere(capturedWheres);
    expect(sql).toContain("between");
    expect(sql).toContain("on_hold");
    expect(sql).toContain("bid_estimate");
  });

  it("assignedRepId Unassigned sentinel becomes IS NULL (sentinel never a bound param)", async () => {
    const { db, capturedWheres } = createTenantDbCapturingWhere();
    const { getDeals } = await import("../../../src/modules/deals/service.js");
    const { UNASSIGNED_FILTER_SENTINEL } = await import("../../../src/modules/deals/deal-filter-predicates.js");

    await getDeals(db, { assignedRepId: UNASSIGNED_FILTER_SENTINEL, scope: "all" }, "director", "director-1");

    const query = render(capturedWheres[capturedWheres.length - 1]);
    expect(query.sql.toLowerCase()).toContain("assigned_rep_id");
    expect(query.sql.toLowerCase()).toContain("is null");
    expect(query.params).not.toContain(UNASSIGNED_FILTER_SENTINEL);
  });

  it("value sort uses the effective value chain (on_hold), not raw awarded_amount", async () => {
    const { db, capturedOrderBys } = createTenantDbCapturingWhere();
    const { getDeals } = await import("../../../src/modules/deals/service.js");

    await getDeals(db, { sortBy: "awarded_amount", sortDir: "desc", scope: "all" }, "director", "director-1");

    const orderText = capturedOrderBys.flat().map(renderText).join(" ");
    expect(orderText).toContain("on_hold");
  });

  it("default-sort active/non-zero TIER is terminal-aware via the joined slug — far-out won/lost not sunk (Codex P2)", async () => {
    // A plain created-sort list never resolves the stage-id sets, so the always-running sort tier reads the
    // JOINED pipeline_stage_config.slug (+ the Bid Board mirror) to keep a realized far-out won/lost deal in
    // the top tier instead of sinking it as $0/on-hold.
    const { db, capturedOrderBys } = createTenantDbCapturingWhere();
    const { getDeals } = await import("../../../src/modules/deals/service.js");

    await getDeals(db, { scope: "all" }, "director", "director-1");

    const orderText = capturedOrderBys.flat().map(renderText).join(" ").toLowerCase();
    expect(orderText).toContain("pipeline_stage_config.slug");
    expect(orderText).toContain("bid_board_stage_slug");
  });

  it("returns pagination.valueTotal when includeValueTotal is requested — SUM over the SAME filtered set (#4)", async () => {
    // The running-total card needs the summed value of the ENTIRE filtered set (all pages),
    // not just the visible page, so it rides on getDeals' response. The harness resolves every
    // aggregate query to { count, total }, so a returned valueTotal proves getDeals issues the
    // value aggregate and surfaces it (the SUM math itself is proven against real SQL in
    // value-total-sql.runtime.test.ts).
    const { db } = createTenantDbCapturingWhere();
    const { getDeals } = await import("../../../src/modules/deals/service.js");

    const result = await getDeals(db, { includeValueTotal: true, scope: "all" }, "director", "director-1");

    expect(result.pagination.valueTotal).toBe(4242);
  });

  it("does NOT compute valueTotal unless requested — no extra aggregate on plain list calls (#4)", async () => {
    // Opt-in gating: /deals base, pipeline and stage drill-downs call getDeals constantly but don't
    // show the Total card, so the value aggregate must NOT run for them. Captured WHEREs without the
    // flag: [count(*), activeCount, dealRows] — exactly 3, no value-total query.
    const { db, capturedWheres } = createTenantDbCapturingWhere();
    const { getDeals } = await import("../../../src/modules/deals/service.js");

    const result = await getDeals(db, { scope: "all" }, "director", "director-1");

    expect(result.pagination.valueTotal).toBeUndefined();
    expect(capturedWheres.length).toBe(3);
  });

  it("sums the running total over the full WHERE (same set as count(*) total), so the list and total can't diverge (#4)", async () => {
    // The value aggregate must use the SAME `where` as the count(*) total — never the
    // active-only WHERE — so on-hold rows (counted, shown as $0) and every other row in the
    // list are in the summed set. Captured: count(*) WHERE, activeCount WHERE, value-total
    // WHERE, then the dealRows WHERE. The total's WHERE must equal the count(*) WHERE.
    const { db, capturedWheres } = createTenantDbCapturingWhere();
    const { getDeals } = await import("../../../src/modules/deals/service.js");

    await getDeals(db, { includeValueTotal: true, valueMin: 100000, scope: "all" }, "director", "director-1");

    // capturedWheres order: [count(*), activeCount, valueTotal, dealRows]
    expect(capturedWheres.length).toBeGreaterThanOrEqual(4);
    const countWhere = renderText(capturedWheres[0]);
    const valueTotalWhere = renderText(capturedWheres[2]);
    const activeCountWhere = renderText(capturedWheres[1]);
    expect(valueTotalWhere).toBe(countWhere);
    // The value-total WHERE is the full set, NOT the active-only WHERE (which adds on_hold=false).
    expect(valueTotalWhere).not.toBe(activeCountWhere);
  });

  it("date window classifies Won/Lost by stage id; open rows current-state when the flag is OFF", async () => {
    const prev = process.env.ENABLE_STAGE_ENTRY_DATE_FILTER;
    delete process.env.ENABLE_STAGE_ENTRY_DATE_FILTER;
    try {
      const { db, capturedWheres } = createTenantDbCapturingWhere();
      const { getDeals } = await import("../../../src/modules/deals/service.js");

      await getDeals(db, { dateFrom: "2026-01-01", dateTo: "2026-03-31", scope: "all" }, "director", "director-1");

      const sql = mainWhere(capturedWheres);
      expect(sql).toContain("stage_id");
      expect(sql).toContain("won_closed_date");
      expect(sql).toContain("lost_at");
      // Flag OFF → open rows are NOT bounded by stage entry (current-state).
      expect(sql).not.toContain("stage_entered_at");
    } finally {
      if (prev === undefined) delete process.env.ENABLE_STAGE_ENTRY_DATE_FILTER;
      else process.env.ENABLE_STAGE_ENTRY_DATE_FILTER = prev;
    }
  });

  it("bounds open rows by stage_entered_at when the flag is ON", async () => {
    const prev = process.env.ENABLE_STAGE_ENTRY_DATE_FILTER;
    process.env.ENABLE_STAGE_ENTRY_DATE_FILTER = "true";
    try {
      const { db, capturedWheres } = createTenantDbCapturingWhere();
      const { getDeals } = await import("../../../src/modules/deals/service.js");

      await getDeals(db, { dateFrom: "2026-01-01", dateTo: "2026-03-31", scope: "all" }, "director", "director-1");

      const sql = mainWhere(capturedWheres);
      expect(sql).toContain("stage_entered_at");
    } finally {
      if (prev === undefined) delete process.env.ENABLE_STAGE_ENTRY_DATE_FILTER;
      else process.env.ENABLE_STAGE_ENTRY_DATE_FILTER = prev;
    }
  });

  // D-15 (Codex #564): the outcome-windowed rep drill-down must bound open rows even
  // with the flag OFF (its prod default), and sort by the SAME outcome axis it displays.
  it("stageEntryDateWindow forces open-row stage_entered_at bounding even when the flag is OFF", async () => {
    const prev = process.env.ENABLE_STAGE_ENTRY_DATE_FILTER;
    delete process.env.ENABLE_STAGE_ENTRY_DATE_FILTER;
    try {
      const { db, capturedWheres } = createTenantDbCapturingWhere();
      const { getDeals } = await import("../../../src/modules/deals/service.js");

      await getDeals(
        db,
        { dateFrom: "2026-01-01", dateTo: "2026-03-31", stageEntryDateWindow: true, scope: "all" },
        "director",
        "director-1"
      );

      // Open rows are bounded by stage_entered_at despite the flag being OFF (no longer
      // returning EVERY open deal under an outcome-window claim).
      expect(mainWhere(capturedWheres)).toContain("stage_entered_at");
    } finally {
      if (prev === undefined) delete process.env.ENABLE_STAGE_ENTRY_DATE_FILTER;
      else process.env.ENABLE_STAGE_ENTRY_DATE_FILTER = prev;
    }
  });

  it("sortBy=display_date orders by the outcome display CASE (sort == display: Won/Lost/open dates)", async () => {
    const { db, capturedOrderBys } = createTenantDbCapturingWhere();
    const { getDeals } = await import("../../../src/modules/deals/service.js");

    await getDeals(db, { sortBy: "display_date", scope: "all" }, "director", "director-1");

    const orderText = capturedOrderBys.flat().map(renderText).join(" ");
    expect(orderText).toContain("case");
    expect(orderText).toContain("won_closed_date"); // Won rows sort by the won-close date
    expect(orderText).toContain("lost_at"); // Lost rows by the lost date
    expect(orderText).toContain("stage_entered_at"); // open rows by the entered-stage date
  });
});
