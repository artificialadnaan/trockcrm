import { describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

/**
 * The deal list pushes on-hold and $0-value deals to the BOTTOM, beneath all
 * active, non-zero deals — whatever the requested sort. This is implemented as a
 * leading ORDER BY tier (active & non-zero -> 0, else -> 1, ascending) ahead of the
 * existing sort column + id tiebreaker. Sort-only: the WHERE set is unchanged, so
 * on-hold/$0 deals still appear, just last.
 */

// listDealStages() reads the module-level db (not the tenantDb arg). Stub it so the
// Won/Lost classification (used by the stage-aware value tier) can resolve.
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

function createTenantDbCapturingOrderBy() {
  const capturedOrderBy: unknown[][] = [];
  const dataChain: Record<string, unknown> = {};
  dataChain.from = () => dataChain;
  dataChain.leftJoin = () => dataChain;
  dataChain.where = () => dataChain;
  dataChain.orderBy = (...args: unknown[]) => {
    capturedOrderBy.push(args);
    return dataChain;
  };
  dataChain.limit = () => dataChain;
  dataChain.offset = () => Promise.resolve([]);
  (dataChain as { then: unknown }).then = (resolve: (rows: unknown[]) => unknown) => resolve([{ count: 0 }]);
  const db = { select: () => dataChain } as never;
  return { db, capturedOrderBy };
}

const orderText = (capturedOrderBy: unknown[][]) => capturedOrderBy.flat().map(renderText).join(" ");

describe("getDeals — active/non-zero two-tier ordering", () => {
  it("leads the ORDER BY with an ascending active+non-zero tier, ahead of the requested created_at sort and id tiebreaker", async () => {
    const { db, capturedOrderBy } = createTenantDbCapturingOrderBy();
    const { getDeals } = await import("../../../src/modules/deals/service.js");

    await getDeals(db, { sortBy: "created_at", sortDir: "desc", scope: "all" }, "director", "director-1");

    expect(capturedOrderBy.length).toBeGreaterThan(0);
    const text = orderText(capturedOrderBy);

    // A leading CASE tier built from the on-hold guard.
    expect(text).toContain("case when");
    expect(text).toContain("on_hold");
    // Ascending, so active/non-zero (0) sort above on-hold/$0 (1).
    expect(text).toContain("end asc");
    // The tier precedes the requested recency column...
    expect(text.indexOf("on_hold")).toBeLessThan(text.indexOf("created_at"));
    // ...and the existing created_at sort + id tiebreaker are preserved.
    expect(text).toContain("created_at");
    expect(text).toContain('"id"');
    // created_at sort does NOT resolve wonStageIds, so the tier uses the open
    // best-estimate chain. That chain still COALESCEs over ALL value columns —
    // including awarded_amount — so an awarded-only Won deal evaluates > 0 and stays
    // in the top tier (it is NOT misclassified as $0). The tier's > 0 test is a
    // boolean over the same four columns, so it is independent of chain order.
    expect(text).toContain("awarded_amount");
    expect(text).toContain("bid_estimate");
  });

  it("keeps the tier leading regardless of which column the user sorts by (name asc)", async () => {
    const { db, capturedOrderBy } = createTenantDbCapturingOrderBy();
    const { getDeals } = await import("../../../src/modules/deals/service.js");

    await getDeals(db, { sortBy: "name", sortDir: "asc", scope: "all" }, "director", "director-1");

    const text = orderText(capturedOrderBy);
    expect(text).toContain("on_hold");
    expect(text).toContain('"name"');
    // tier (on_hold) still leads, ahead of the name sort.
    expect(text.indexOf("on_hold")).toBeLessThan(text.indexOf('"name"'));
  });
});
