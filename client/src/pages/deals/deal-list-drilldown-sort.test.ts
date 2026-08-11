import { describe, expect, it } from "vitest";
import { compareDrilldownDeals } from "./deal-list-page";

type Row = Parameters<typeof compareDrilldownDeals>[0];
type Sort = Parameters<typeof compareDrilldownDeals>[2];

// Minimal drill-down row. Open-stage (no won slug) so effective value reads the
// best-estimate chain; `bidEstimate` drives the value, `onHold` zeroes it.
function makeRow(over: Partial<Row> & { id: string }): Row {
  return {
    name: over.id,
    boardStageName: "Opportunity",
    onHold: false,
    awardedAmount: null,
    bidEstimate: null,
    ddEstimate: null,
    bidBoardTotalSales: null,
    updatedAt: "2026-01-01T00:00:00.000Z",
    stageEnteredAt: "2026-01-01T00:00:00.000Z",
    expectedCloseDate: null,
    actualCloseDate: null,
    ...over,
  } as unknown as Row;
}

function sortedIds(rows: Row[], sort: Sort): string[] {
  return [...rows].sort((left, right) => compareDrilldownDeals(left, right, sort)).map((row) => row.id);
}

describe("compareDrilldownDeals — on-hold & $0 deals sink to the bottom", () => {
  it("keeps on-hold and zero-value deals below active deals even when sorting by value ascending", () => {
    const rows = [
      makeRow({ id: "zero" }), // no estimates -> $0
      makeRow({ id: "on-hold", bidEstimate: "999999", onHold: true }), // high raw value but on hold
      makeRow({ id: "small", bidEstimate: "100000" }),
      makeRow({ id: "big", bidEstimate: "500000" }),
    ];

    const order = sortedIds(rows, { key: "awarded_amount", dir: "asc" } as Sort);

    // Tier 1 (active, non-zero) on top, ascending by value; on-hold/$0 pushed below.
    expect(order.slice(0, 2)).toEqual(["small", "big"]);
    expect(order.slice(2).sort()).toEqual(["on-hold", "zero"]);
  });

  it("keeps the newest on-hold and zero-value deals at the bottom when sorting by updated_at desc", () => {
    const rows = [
      makeRow({ id: "old-active", bidEstimate: "100000", updatedAt: "2026-01-01T00:00:00.000Z" }),
      makeRow({ id: "new-on-hold", bidEstimate: "100000", onHold: true, updatedAt: "2026-06-01T00:00:00.000Z" }),
      makeRow({ id: "mid-active", bidEstimate: "100000", updatedAt: "2026-05-01T00:00:00.000Z" }),
      makeRow({ id: "new-zero", updatedAt: "2026-06-02T00:00:00.000Z" }),
    ];

    const order = sortedIds(rows, { key: "updated_at", dir: "desc" } as Sort);

    // Active deals first, newest-first; the (newer) on-hold and $0 deals are still last.
    expect(order.slice(0, 2)).toEqual(["mid-active", "old-active"]);
    expect(order.slice(2).sort()).toEqual(["new-on-hold", "new-zero"]);
  });
});

// A deductive change order is a live Won child deal with a NEGATIVE awarded amount. The tier's original
// `> 0` test filed it with the dead rows (on-hold / $0), and because the tier LEADS the comparator that
// happened under every sort. The twin of the server tier — aliasedActiveNonZeroDealSortTierSql in
// server/src/modules/shared/deal-value-sql.ts, which carries the rationale — so both are `!== 0`: the
// tier demotes dead rows, and a deduction is live.
describe("compareDrilldownDeals — a deductive change order", () => {
  const deductive = (over: Partial<Row> = {}) =>
    makeRow({ id: "deductive", isChangeOrder: true, awardedAmount: "-20000", ...over });

  it("value DESCENDING: below every positive deal, but still above the on-hold and $0 rows", () => {
    const rows = [
      deductive(),
      makeRow({ id: "zero" }),
      makeRow({ id: "on-hold", bidEstimate: "999999", onHold: true }),
      makeRow({ id: "active", bidEstimate: "100000" }),
    ];

    const order = sortedIds(rows, { key: "awarded_amount", dir: "desc" } as Sort);

    // It cannot top a descending money ranking — it is the smallest number — so it needs no tier help,
    // and staying above the dead rows keeps it reachable on a paginated list.
    expect(order.slice(0, 2)).toEqual(["active", "deductive"]);
    expect(order.slice(2).sort()).toEqual(["on-hold", "zero"]);
  });

  it("value ASCENDING: FIRST, where smallest-first genuinely puts it", () => {
    const rows = [makeRow({ id: "active", bidEstimate: "100000" }), deductive(), makeRow({ id: "zero" })];

    const order = sortedIds(rows, { key: "awarded_amount", dir: "asc" } as Sort);

    expect(order).toEqual(["deductive", "active", "zero"]);
  });

  it("orders normally when the user sorts BY NAME", () => {
    const rows = [
      makeRow({ id: "zero", name: "aaa-zero" }), // alphabetically first, but $0
      deductive(),
      makeRow({ id: "active", name: "bbb-active", bidEstimate: "100000" }),
    ];

    const order = sortedIds(rows, { key: "name", dir: "asc" } as Sort);

    // "bbb-active" < "deductive" alphabetically; the $0 row sinks despite sorting first by name.
    expect(order).toEqual(["active", "deductive", "zero"]);
  });

  it("orders normally when the user sorts BY DATE", () => {
    const rows = [
      makeRow({ id: "old-active", bidEstimate: "100000", updatedAt: "2026-01-01T00:00:00.000Z" }),
      deductive({ updatedAt: "2026-06-01T00:00:00.000Z" }),
      makeRow({ id: "new-zero", updatedAt: "2026-06-02T00:00:00.000Z" }),
    ];

    const order = sortedIds(rows, { key: "updated_at", dir: "desc" } as Sort);

    // Newest-first among live rows; only the genuinely $0 row is still pushed below.
    expect(order).toEqual(["deductive", "old-active", "new-zero"]);
  });
});
