import { describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

/**
 * SQL-shape proof that the two Won-showing LIST surfaces now require is_active=true, so a
 * soft-deleted (is_active=false) Won deal is excluded — while a LIVE Won deal (is_active=true)
 * stays visible. We render the captured WHERE rather than execute, because getDeals /
 * getDealsForPipeline carry many joins; the data-integrity half (open/edit + cascade) is proven
 * behaviorally in soft-deleted-won-hidden.runtime.test.ts.
 *
 *  - getDealsForPipeline Won column (§6.3/§6.7): the Won-stage WHERE used the on_hold-only
 *    reportable filter and intentionally omitted is_active. It must now also require is_active=true.
 *  - getDeals pipeline / Won-period drill-down: the or(is_active=true, stage_id IN terminalInactive)
 *    re-admitted inactive (=soft-deleted) terminal rows. It must collapse to is_active=true.
 */

const WON = "00000000-0000-0000-0000-0000000057a1";
const OPP = "00000000-0000-0000-0000-0000000057a2";

// listDealStages() + getDealsForPipeline's stage read both hit the module-level db (not tenantDb).
vi.mock("../../../src/db.js", () => {
  const stages = [
    { id: OPP, slug: "opportunity", name: "Opportunity", workflowFamily: "standard_deal", displayOrder: 1, isActivePipeline: true, isTerminal: false },
    { id: WON, slug: "won", name: "Won", workflowFamily: "standard_deal", displayOrder: 9, isActivePipeline: true, isTerminal: true },
  ];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chain: any = {};
  chain.select = () => chain;
  chain.from = () => chain;
  chain.where = () => chain;
  chain.orderBy = () => Promise.resolve(stages);
  chain.then = (resolve: (v: unknown) => unknown) => resolve(stages);
  return { db: chain, pool: {} };
});

const dialect = new PgDialect();
const render = (v: unknown) => dialect.sqlToQuery(v as never).sql.toLowerCase();

// A tenantDb stub that captures every .where() arg and resolves all queries to [] (no execution).
// A Proxy returns the chain for any builder method, so it survives both builders' query shapes.
function capturingTenantDb() {
  const wheres: unknown[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chain: any = new Proxy(
    function () {
      /* callable so apply traps never throw */
    },
    {
      apply: () => chain,
      get(_t, prop) {
        if (prop === "then") return (resolve: (rows: unknown[]) => unknown) => resolve([]);
        if (prop === "where") return (arg: unknown) => { wheres.push(arg); return chain; };
        if (prop === "offset") return () => Promise.resolve([]);
        return () => chain;
      },
    }
  );
  return { db: chain as never, wheres };
}

describe("getDeals pipeline / Won-period drill-down — excludes soft-deleted Won", () => {
  it("collapses to is_active=true and no longer re-admits inactive terminal rows by stage_id", async () => {
    const { db, wheres } = capturingTenantDb();
    const { getDeals } = await import("../../../src/modules/deals/service.js");

    await getDeals(
      // isActive:"pipeline" + inactiveStageIds=[WON] is the board path that previously re-admitted
      // inactive terminal (soft-deleted) Won rows via the or(... stage_id IN ...) branch.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db, { isActive: "pipeline", inactiveStageIds: [WON], scope: "all", sortBy: "created_at", sortDir: "desc" } as any,
      "director", "dir-1"
    );

    // Select the visibility predicate by content (not by call index) so the assertion can't bind to the
    // wrong .where() if query order changes.
    const visibilityWhere = wheres.map(render).find((w) => w.includes("is_active"));
    expect(visibilityWhere).toBeTruthy();
    // The re-admission OR-branch is gone: no stage_id membership in the visibility clause.
    expect(visibilityWhere).not.toContain("stage_id");
  });
});

describe("getDealsForPipeline Won column — excludes soft-deleted Won", () => {
  it("every on-hold-filtered (Won) stage WHERE also requires is_active=true", async () => {
    const { db, wheres } = capturingTenantDb();
    const { getDealsForPipeline } = await import("../../../src/modules/deals/service.js");

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await getDealsForPipeline(db, "director", "dir-1", { scope: "all" } as any);

    const rendered = wheres.map(render);
    // The Won column is uniquely identified by the on_hold reportable filter (open/Lost columns don't use it).
    const wonWheres = rendered.filter((w) => w.includes("on_hold"));
    expect(wonWheres.length).toBeGreaterThan(0);
    for (const w of wonWheres) {
      expect(w).toContain("is_active");
    }
  });
});
