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
