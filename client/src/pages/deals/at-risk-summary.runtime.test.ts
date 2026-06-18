// @vitest-environment node
//
// Reconciliation-by-construction for the Deals-at-Risk drill-down: the Active Pipeline KPI card, the
// At-Risk KPI card, and the kanban must all derive from ONE at-risk-filtered set — getAtRiskBoardColumns —
// so they can never diverge (the bug was the Active Pipeline card summing the WHOLE open board instead).
// All/Mine/Watched + rep scoping is applied server-side to the board these helpers receive; the time
// window (updatedFrom/To) is applied here via matchesUpdatedRange and is exercised below.
import { describe, expect, it } from "vitest";
import type { Deal, DealBoardColumn } from "@/hooks/use-deals";
import {
  activePipelineDrilldownFilter,
  getActivePipelineSummary,
  getAtRiskBoardColumns,
  isEngineAtRiskDeal,
  sumNonOnHoldDealValues,
} from "./deal-list-page";

// Minimal Deal fixture: helpers only read atRisk / onHold / updatedAt / bidEstimate (→ effective value).
// bidEstimate is the sole value field set, so getEffectiveDealValue returns it verbatim for non-on-hold.
// (`atRisk` here is a boolean toggle, distinct from Deal.atRisk's AtRiskResult shape it expands to.)
function deal(o: {
  id: string;
  atRisk?: boolean;
  value?: number;
  onHold?: boolean;
  updatedAt?: string;
}): Deal {
  const { id, atRisk = false, value = 0, onHold = false, updatedAt = "2026-06-10T00:00:00.000Z" } = o;
  return {
    id,
    onHold,
    updatedAt,
    bidEstimate: value,
    atRisk: atRisk
      ? { isAtRisk: true, status: "at_risk", effectiveStageAgeDays: 30 }
      : { isAtRisk: false, status: "on_track", effectiveStageAgeDays: 1 },
  } as unknown as Deal;
}

function column(slug: string, cards: Deal[]): DealBoardColumn {
  return {
    stage: { id: slug, name: slug, slug },
    count: cards.length,
    totalCount: cards.length,
    totalValue: sumNonOnHoldDealValues(cards),
    cards,
  };
}

// A board: two open stages with a mix of at-risk / on-track / on-hold deals, plus a terminal Won column
// that must be excluded entirely.
function makeBoard(): DealBoardColumn[] {
  return [
    column("estimating", [
      deal({ id: "r1", atRisk: true, value: 100_000 }), // at-risk, active
      deal({ id: "r2", atRisk: true, value: 50_000, onHold: true }), // at-risk, ON HOLD → 0 value, not in count
      deal({ id: "o1", atRisk: false, value: 999_000 }), // on-track → excluded from the at-risk set
    ]),
    column("contract", [
      deal({ id: "r3", atRisk: true, value: 25_000 }), // at-risk, active
      deal({ id: "o2", atRisk: false, value: 888_000 }),
    ]),
    column("won", [
      deal({ id: "w1", atRisk: true, value: 1_000_000 }), // terminal column — must NOT be counted
    ]),
  ];
}

describe("isEngineAtRiskDeal", () => {
  it("is true only when the engine flag is set AND status is at_risk", () => {
    expect(isEngineAtRiskDeal(deal({ id: "a", atRisk: true }))).toBe(true);
    expect(isEngineAtRiskDeal(deal({ id: "b", atRisk: false }))).toBe(false);
    expect(isEngineAtRiskDeal({ atRisk: { isAtRisk: true, status: "on_track" } } as unknown as Deal)).toBe(false);
    expect(isEngineAtRiskDeal({ atRisk: null } as unknown as Deal)).toBe(false);
  });
});

describe("getAtRiskBoardColumns — the single filtered set", () => {
  it("drops terminal columns and narrows each open column to at-risk deals", () => {
    const cols = getAtRiskBoardColumns(makeBoard());
    expect(cols.map((c) => c.stage.slug)).toEqual(["estimating", "contract"]); // no 'won'
    const ids = cols.flatMap((c) => c.cards.map((d) => (d as { id: string }).id));
    expect(ids.sort()).toEqual(["r1", "r2", "r3"]); // only at-risk; on-track o1/o2 dropped
  });

  it("recounts each column: count excludes on-hold, totalCount is all at-risk, value is non-on-hold $", () => {
    const [estimating] = getAtRiskBoardColumns(makeBoard());
    expect(estimating.totalCount).toBe(2); // r1 + r2(on-hold)
    expect(estimating.count).toBe(1); // r2 on-hold excluded
    expect(estimating.totalValue).toBe(100_000); // r2 on-hold contributes 0
  });

  it("honors the updated-at window", () => {
    const board = [
      column("estimating", [
        deal({ id: "in", atRisk: true, value: 10, updatedAt: "2026-06-10T00:00:00.000Z" }),
        deal({ id: "out", atRisk: true, value: 10, updatedAt: "2026-01-01T00:00:00.000Z" }),
      ]),
    ];
    const cols = getAtRiskBoardColumns(board, "2026-06-01", "2026-06-30");
    expect(cols[0].cards.map((d) => (d as { id: string }).id)).toEqual(["in"]);
  });
});

describe("reconciliation: Active Pipeline card === At-Risk card === kanban (one set)", () => {
  it("the three surfaces agree by construction", () => {
    const atRiskColumns = getAtRiskBoardColumns(makeBoard()); // the kanban's source (pre-search)
    const summary = getActivePipelineSummary(atRiskColumns); // the Active Pipeline card
    const kanbanCards = atRiskColumns.flatMap((c) => c.cards); // what the kanban renders

    // At-Risk card count (mirrors the page's unsearchedOverSlaCount over the same columns).
    const atRiskCardCount = atRiskColumns.reduce(
      (sum, c) => sum + c.cards.filter(isEngineAtRiskDeal).length,
      0
    );

    // "/Y" of the Active Pipeline badge === At-Risk count === number of kanban cards.
    expect(summary.visibleCount).toBe(atRiskCardCount);
    expect(summary.visibleCount).toBe(kanbanCards.length); // 3 (r1, r2, r3)
    // Active count (excl on-hold) and $ also reconcile to the same card set.
    expect(summary.count).toBe(kanbanCards.filter((d) => !d.onHold).length); // 2
    expect(summary.value).toBe(sumNonOnHoldDealValues(kanbanCards)); // 100k + 25k = 125k
    expect(summary.value).toBe(125_000);
    // And it is NOT the whole open board ($999k + $888k on-track deals are excluded).
    expect(summary.value).not.toBe(125_000 + 999_000 + 888_000);
  });
});

describe("activePipelineDrilldownFilter — card links to the cohort it shows", () => {
  it("links the Active Pipeline card to the at-risk cohort on the at-risk drill-down, full pipeline elsewhere", () => {
    expect(activePipelineDrilldownFilter("at_risk")).toBe("at_risk"); // matches the at-risk number shown
    expect(activePipelineDrilldownFilter("active")).toBe("active_pipeline");
    expect(activePipelineDrilldownFilter("all")).toBe("active_pipeline");
    expect(activePipelineDrilldownFilter("won")).toBe("active_pipeline");
  });
});

describe("getActivePipelineSummary — empty state + NaN safety (R3)", () => {
  it("returns zeros when there are no at-risk deals", () => {
    const cols = getAtRiskBoardColumns([
      column("estimating", [deal({ id: "o", atRisk: false, value: 500 })]),
    ]);
    expect(getActivePipelineSummary(cols)).toEqual({ count: 0, visibleCount: 0, value: 0 });
  });

  it("coerces a non-finite column total to 0 (never propagates NaN to the card)", () => {
    const bad = column("estimating", []);
    (bad as { totalValue: number }).totalValue = Number.NaN;
    (bad as { count: number }).count = Number.NaN;
    const summary = getActivePipelineSummary([bad]);
    expect(Number.isFinite(summary.value)).toBe(true);
    expect(summary.value).toBe(0);
    expect(Number.isFinite(summary.count)).toBe(true);
  });
});
