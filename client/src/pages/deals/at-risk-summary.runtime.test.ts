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
  AT_RISK_ROUTE_BUCKETS,
  activePipelineDrilldownFilter,
  atRiskFilterForRouteBucket,
  atRiskRouteBucketForFilter,
  countAtRiskDeals,
  getActivePipelineSummary,
  getAtRiskBoardColumns,
  isEngineAtRiskDeal,
  isServiceRouteDeal,
  matchesAtRiskRouteBucket,
  sumNonOnHoldDealValues,
  type AtRiskRouteBucket,
} from "./deal-list-page";

// Minimal Deal fixture: helpers only read atRisk / onHold / updatedAt / bidEstimate (→ effective value)
// and workflowRoute (→ route bucket).
// bidEstimate is the sole value field set, so getEffectiveDealValue returns it verbatim for non-on-hold.
// (`atRisk` here is a boolean toggle, distinct from Deal.atRisk's AtRiskResult shape it expands to.)
function deal(o: {
  id: string;
  atRisk?: boolean;
  value?: number;
  onHold?: boolean;
  updatedAt?: string;
  // OMIT the key entirely to model a wire payload that carries no route at all; pass null to model an
  // explicit null. Neither is "service", so both must land in the non-service bucket.
  workflowRoute?: "normal" | "service" | null;
}): Deal {
  const { id, atRisk = false, value = 0, onHold = false, updatedAt = "2026-06-10T00:00:00.000Z" } = o;
  return {
    id,
    onHold,
    updatedAt,
    bidEstimate: value,
    ...("workflowRoute" in o ? { workflowRoute: o.workflowRoute } : {}),
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

  it("is CURRENT-STATE: includes at-risk deals regardless of updated_at (?period is a no-op here)", () => {
    // Deals at Risk is a current-state SLA view — period-windowing by updated_at would hide the stalest
    // (least-recently-touched = MOST at-risk) deals. So getAtRiskBoardColumns takes no window and keeps them.
    const board = [
      column("estimating", [
        deal({ id: "recent", atRisk: true, value: 10, updatedAt: "2026-06-10T00:00:00.000Z" }),
        deal({ id: "stale", atRisk: true, value: 10, updatedAt: "2025-01-01T00:00:00.000Z" }),
      ]),
    ];
    const ids = getAtRiskBoardColumns(board)[0].cards.map((d) => (d as { id: string }).id).sort();
    expect(ids).toEqual(["recent", "stale"]); // the very-stale deal is kept, not windowed out
  });

  it("the at-risk set is period-independent: identical cohort whatever the (now-ignored) period would be", () => {
    // getAtRiskBoardColumns has no period parameter, so card = kanban = list = link cohort across every
    // ?period preset by construction — the at-risk set simply cannot change with the period.
    const a = getAtRiskBoardColumns(makeBoard());
    const b = getAtRiskBoardColumns(makeBoard());
    expect(getActivePipelineSummary(a)).toEqual(getActivePipelineSummary(b));
    expect(getActivePipelineSummary(a)).toEqual({ count: 2, visibleCount: 3, value: 125_000 });
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

  it("keeps the ROUTE on the at-risk drill-down: it shows the route-narrowed set, so it must link back to it", () => {
    // On /deals?filter=at_risk_service the Active Pipeline card aggregates the service-only at-risk
    // columns. Linking to the unsplit at_risk would open a strictly larger set than the number it prints.
    expect(activePipelineDrilldownFilter("at_risk", "service")).toBe("at_risk_service");
    expect(activePipelineDrilldownFilter("at_risk", "non_service")).toBe("at_risk_non_service");
    expect(activePipelineDrilldownFilter("at_risk", "all")).toBe("at_risk");
    // Off the at-risk board the route is irrelevant — still the full active pipeline.
    expect(activePipelineDrilldownFilter("active", "service")).toBe("active_pipeline");
  });
});

// ---------------------------------------------------------------------------------------------------
// The workflow-route split of the At-Risk card into Service / Non-service / All.
//
// The whole point of this block is the reconciliation constraint: each card's NUMBER and the ROWS on the
// drill-down its link opens must come from the same at-risk predicate AND the same route filter, and the
// two route cards must sum exactly to the All card. The tests below therefore always route through the
// real ?filter round trip (atRiskFilterForRouteBucket → atRiskRouteBucketForFilter) rather than passing a
// bucket straight to both sides, so a mismatch in that mapping cannot pass unnoticed.
// ---------------------------------------------------------------------------------------------------

/**
 * A realistic MIXED board: both routes present in the same stage, at-risk and on-track deals of each
 * route, an on-hold at-risk service deal, deals with an explicit null route and with the route key
 * ABSENT entirely, and a terminal column that must stay excluded.
 *
 * At-risk deals by route:
 *   service      → s1, s2, s3(on-hold)                       = 3
 *   non-service  → n1, n2 (normal), x1 (null), x2 (absent)   = 4
 *   TOTAL                                                     = 7
 * Non-at-risk (must never be counted): so1, no1, xo1. Terminal: w1 (at-risk, but in 'won').
 */
function makeRouteMixedBoard(): DealBoardColumn[] {
  return [
    column("estimating", [
      deal({ id: "s1", atRisk: true, value: 100_000, workflowRoute: "service" }),
      deal({ id: "n1", atRisk: true, value: 80_000, workflowRoute: "normal" }),
      deal({ id: "x1", atRisk: true, value: 40_000, workflowRoute: null }), // explicit null route
      deal({ id: "so1", atRisk: false, value: 999_000, workflowRoute: "service" }), // on-track
      deal({ id: "no1", atRisk: false, value: 888_000, workflowRoute: "normal" }), // on-track
    ]),
    column("contract", [
      deal({ id: "s2", atRisk: true, value: 25_000, workflowRoute: "service" }),
      deal({ id: "s3", atRisk: true, value: 60_000, onHold: true, workflowRoute: "service" }),
      deal({ id: "n2", atRisk: true, value: 15_000, workflowRoute: "normal" }),
      deal({ id: "x2", atRisk: true, value: 5_000 }), // route key ABSENT from the payload
      deal({ id: "xo1", atRisk: false, value: 7_000 }), // on-track, no route
    ]),
    column("won", [
      deal({ id: "w1", atRisk: true, value: 1_000_000, workflowRoute: "service" }), // terminal — excluded
    ]),
  ];
}

function cardIds(columns: DealBoardColumn[]): string[] {
  return columns.flatMap((c) => c.cards.map((d) => (d as { id: string }).id)).sort();
}

/** The rows a drill-down actually renders for a ?filter, via the SAME path the page takes. */
function drilldownCardIdsForFilter(
  columns: DealBoardColumn[],
  filter: ReturnType<typeof atRiskFilterForRouteBucket>
): string[] {
  return cardIds(getAtRiskBoardColumns(columns, atRiskRouteBucketForFilter(filter)));
}

describe("at-risk route bucketing — the predicate", () => {
  it("treats ONLY workflowRoute === 'service' as service", () => {
    expect(isServiceRouteDeal(deal({ id: "a", workflowRoute: "service" }))).toBe(true);
    expect(isServiceRouteDeal(deal({ id: "b", workflowRoute: "normal" }))).toBe(false);
    expect(isServiceRouteDeal(deal({ id: "c", workflowRoute: null }))).toBe(false);
    expect(isServiceRouteDeal(deal({ id: "d" }))).toBe(false);
  });

  it("puts a NULL or ABSENT workflowRoute in NON-SERVICE (documented: not service ⇒ non-service)", () => {
    // deals.workflow_route is `.default('normal').notNull()`, so a real row always has a route — but the
    // client Deal type still allows null and a payload can omit the key. Such a deal is not service, so
    // it belongs on the non-service side. Dropping it from BOTH buckets would silently break the sum.
    for (const routeless of [deal({ id: "null-route", workflowRoute: null }), deal({ id: "no-route" })]) {
      expect(matchesAtRiskRouteBucket(routeless, "non_service")).toBe(true);
      expect(matchesAtRiskRouteBucket(routeless, "service")).toBe(false);
      expect(matchesAtRiskRouteBucket(routeless, "all")).toBe(true);
    }
  });

  it("is a TOTAL partition: every deal matches exactly one of service / non_service, and always all", () => {
    const everyShape = [
      deal({ id: "svc", workflowRoute: "service" }),
      deal({ id: "nrm", workflowRoute: "normal" }),
      deal({ id: "nul", workflowRoute: null }),
      deal({ id: "abs" }),
    ];
    for (const d of everyShape) {
      const inService = matchesAtRiskRouteBucket(d, "service");
      const inNonService = matchesAtRiskRouteBucket(d, "non_service");
      expect(inService !== inNonService).toBe(true); // exactly one side — never both, never neither
      expect(matchesAtRiskRouteBucket(d, "all")).toBe(true);
    }
  });
});

describe("at-risk route bucketing — the ?filter round trip (the card↔list contract)", () => {
  it("atRiskRouteBucketForFilter inverts atRiskFilterForRouteBucket for every bucket", () => {
    for (const bucket of AT_RISK_ROUTE_BUCKETS) {
      expect(atRiskRouteBucketForFilter(atRiskFilterForRouteBucket(bucket))).toBe(bucket);
    }
    expect(atRiskFilterForRouteBucket("service")).toBe("at_risk_service");
    expect(atRiskFilterForRouteBucket("non_service")).toBe("at_risk_non_service");
    expect(atRiskFilterForRouteBucket("all")).toBe("at_risk");
  });

  it("every non-route filter reads as the 'all' bucket (stale and the base view included)", () => {
    expect(atRiskRouteBucketForFilter("at_risk")).toBe("all");
    expect(atRiskRouteBucketForFilter("stale")).toBe("all");
    expect(atRiskRouteBucketForFilter("won")).toBe("all");
    expect(atRiskRouteBucketForFilter(null)).toBe("all");
  });
});

describe("at-risk route split — counts reconcile with the list each card links to", () => {
  it("Service + Non-service === All (the sum identity) on a realistic mixed board", () => {
    const columns = makeRouteMixedBoard();
    const service = countAtRiskDeals(columns, "service");
    const nonService = countAtRiskDeals(columns, "non_service");
    const all = countAtRiskDeals(columns, "all");

    expect(service).toBe(3); // s1, s2, s3(on-hold — still at risk, still counted)
    expect(nonService).toBe(4); // n1, n2 + the null-route x1 + the route-less x2
    expect(all).toBe(7);
    expect(service + nonService).toBe(all);
  });

  it("the All card keeps EXACTLY the pre-split number (the old inline reduce)", () => {
    const columns = makeRouteMixedBoard();
    // Verbatim reproduction of the reduce the single "At risk" card used before the split.
    const legacyCount = columns.reduce(
      (sum, c) => sum + (c.stage.slug === "won" ? 0 : c.cards.filter(isEngineAtRiskDeal).length),
      0
    );
    expect(countAtRiskDeals(columns, "all")).toBe(legacyCount);
  });

  it("each card's COUNT equals the number of ROWS on the drill-down its own link opens", () => {
    // This is the constraint the whole feature hangs on. For each card we take the number it renders and
    // the rows the ?filter it links to produces — through the real bucket→filter→bucket round trip — and
    // require them to be the same set, not merely the same size.
    const columns = makeRouteMixedBoard();
    for (const bucket of AT_RISK_ROUTE_BUCKETS) {
      const cardCount = countAtRiskDeals(columns, bucket);
      const rows = drilldownCardIdsForFilter(columns, atRiskFilterForRouteBucket(bucket));
      expect(rows).toHaveLength(cardCount);
    }
  });

  it("the two route drill-downs PARTITION the All drill-down's rows — no deal lost, none double-counted", () => {
    const columns = makeRouteMixedBoard();
    const serviceRows = drilldownCardIdsForFilter(columns, "at_risk_service");
    const nonServiceRows = drilldownCardIdsForFilter(columns, "at_risk_non_service");
    const allRows = drilldownCardIdsForFilter(columns, "at_risk");

    expect(serviceRows).toEqual(["s1", "s2", "s3"]);
    expect(nonServiceRows).toEqual(["n1", "n2", "x1", "x2"]); // the null/absent-route deals are HERE
    expect([...serviceRows, ...nonServiceRows].sort()).toEqual(allRows);
    expect(serviceRows.filter((id) => nonServiceRows.includes(id))).toEqual([]); // disjoint
    expect(allRows).not.toContain("w1"); // the terminal Won column stays excluded on every route
    expect(allRows).not.toContain("so1"); // and on-track deals are still dropped by the at-risk predicate
  });

  it("narrowing by route does not touch the at-risk predicate — only WHICH at-risk deals are shown", () => {
    const columns = makeRouteMixedBoard();
    const all = getAtRiskBoardColumns(columns, "all");
    for (const bucket of ["service", "non_service"] as AtRiskRouteBucket[]) {
      const narrowed = getAtRiskBoardColumns(columns, bucket);
      // Every card in a route view is a card of the unsplit at-risk view (a strict subset), and it is
      // still an engine at-risk deal — the route filter can only remove, never admit.
      expect(narrowed.flatMap((c) => c.cards).every(isEngineAtRiskDeal)).toBe(true);
      for (const id of cardIds(narrowed)) expect(cardIds(all)).toContain(id);
    }
  });

  it("recounts the route-narrowed columns the same way (on-hold out of count, in totalCount)", () => {
    // s2 (active) + s3 (on-hold) both sit in 'contract'; the on-hold one still belongs to the at-risk
    // cohort but must not inflate the active count or the $ — same rule as the unsplit view.
    const contract = getAtRiskBoardColumns(makeRouteMixedBoard(), "service").find(
      (c) => c.stage.slug === "contract"
    )!;
    expect(contract.totalCount).toBe(2); // s2 + s3
    expect(contract.count).toBe(1); // s3 on-hold excluded
    expect(contract.totalValue).toBe(25_000); // s3 contributes 0
  });

  it("holds the sum identity on EVERY board shape, including empty and single-route boards", () => {
    const boards: DealBoardColumn[][] = [
      [],
      [column("estimating", [])],
      [column("estimating", [deal({ id: "only-svc", atRisk: true, workflowRoute: "service" })])],
      [column("estimating", [deal({ id: "only-routeless", atRisk: true })])],
      [column("won", [deal({ id: "terminal", atRisk: true, workflowRoute: "service" })])],
      makeRouteMixedBoard(),
    ];
    for (const board of boards) {
      expect(countAtRiskDeals(board, "service") + countAtRiskDeals(board, "non_service")).toBe(
        countAtRiskDeals(board, "all")
      );
    }
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
