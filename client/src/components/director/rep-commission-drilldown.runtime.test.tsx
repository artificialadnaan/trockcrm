// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { RepCommissionDrilldown } from "./rep-commission-drilldown";
import type { RepDetailData } from "@/hooks/use-director-dashboard";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const apiMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ api: apiMock }));

type Summary = RepDetailData["commissionSummary"];
type Deals = RepDetailData["commissionDeals"];
type Worklist = RepDetailData["wonMissingContractDate"];

function summary(overrides: Partial<Summary> = {}): Summary {
  return {
    commissionRate: 0.1,
    overrideRate: 0,
    rollingFloor: 100000,
    rollingPaidRevenue: 0,
    rollingCommissionableMargin: 0,
    floorRemaining: 0,
    newCustomerRevenue: 0,
    newCustomerShare: 0,
    newCustomerShareFloor: 0.1,
    meetsNewCustomerShare: true,
    estimatedPaymentCount: 0,
    excludedLowMarginRevenue: 0,
    directEarnedCommission: 6000,
    overrideEarnedCommission: 0,
    totalEarnedCommission: 6000,
    potentialRevenue: 0,
    potentialMargin: 0,
    potentialCommission: 0,
    qualifyingRevenue: 120000,
    floorMet: true,
    ...overrides,
  };
}

const SPLIT_DEALS: Deals = [
  {
    dealId: "d-own",
    dealNumber: "OWN-1",
    dealName: "Owned deal",
    companyName: "Acme",
    propertyName: null,
    paidRevenue: 50000,
    commissionableMargin: 50000,
    earnedCommission: 5000,
    paymentCount: 0,
    lastPaidAt: null,
    attributionRole: "owner",
  },
  {
    dealId: "d-est",
    dealNumber: "EST-1",
    dealName: "Estimated deal",
    companyName: "Beta",
    propertyName: null,
    paidRevenue: 30000,
    commissionableMargin: 30000,
    earnedCommission: 1000,
    paymentCount: 0,
    lastPaidAt: null,
    attributionRole: "estimator",
  },
];

function renderDrilldown(props: {
  commissionSummary?: Summary;
  commissionDeals?: Deals;
  wonMissingContractDate?: Worklist;
  onDataChanged?: () => void;
}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let root!: Root;
  act(() => {
    root = createRoot(container);
    root.render(
      <MemoryRouter>
        <RepCommissionDrilldown
          repId="rep-1"
          repName="Kevin Scott"
          periodLabel="YTD"
          isFlatListWindow
          dateRange={{ from: "2026-01-01", to: "2026-12-31" }}
          commissionSummary={props.commissionSummary ?? summary()}
          commissionDeals={props.commissionDeals ?? SPLIT_DEALS}
          wonMissingContractDate={props.wonMissingContractDate ?? []}
          onDataChanged={props.onDataChanged ?? (() => {})}
        />
      </MemoryRouter>
    );
  });
  return {
    container,
    cleanup: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

afterEach(() => {
  apiMock.mockReset();
});

describe("RepCommissionDrilldown — split + floor", () => {
  it("renders owner and estimator cuts with role badges that sum to direct", () => {
    const { container, cleanup } = renderDrilldown({});
    const text = container.textContent ?? "";
    expect(text).toContain("Owner cut");
    expect(text).toContain("Estimator cut");
    // Owner $5,000 + estimator $1,000 = $6,000 direct (the reconciliation caption).
    expect(text).toContain("$5,000");
    expect(text).toContain("$1,000");
    expect(text).toContain("$6,000");
    cleanup();
  });

  it("net-negative earnings render a distinct rose split bar, not the empty track (review finding)", () => {
    // Clawback/reversal makes the owner cut net negative → total < 0. The bar must signal a negative position
    // (rose), distinct from the empty slate track that a director would read as "earned nothing".
    const negativeDeals: Deals = [{ ...SPLIT_DEALS[0], dealId: "d-claw", earnedCommission: -2000 }];
    const neg = renderDrilldown({
      commissionDeals: negativeDeals,
      commissionSummary: summary({ directEarnedCommission: -2000, totalEarnedCommission: -2000 }),
    });
    expect(neg.container.querySelector(".bg-rose-400")).toBeTruthy();
    neg.cleanup();

    // The positive default render uses the proportional segments, NOT the rose negative treatment.
    const pos = renderDrilldown({});
    expect(pos.container.querySelector(".bg-rose-400")).toBeNull();
    pos.cleanup();
  });

  it("floor met: shows cleared, no held markers", () => {
    const { container, cleanup } = renderDrilldown({});
    const text = container.textContent ?? "";
    expect(text).toContain("Floor cleared");
    expect(text).not.toContain("held");
    expect(text).toContain("$120,000.00 of $100,000.00"); // cents-preserving (commission reconciliation)
    cleanup();
  });

  it("below floor: shows held earnings + shortfall, never a blank $0", () => {
    const belowDeals: Deals = SPLIT_DEALS.map((d) => ({ ...d, earnedCommission: 0 }));
    const { container, cleanup } = renderDrilldown({
      commissionSummary: summary({
        floorMet: false,
        qualifyingRevenue: 40000,
        rollingFloor: 100000,
        directEarnedCommission: 0,
        totalEarnedCommission: 0,
      }),
      commissionDeals: belowDeals,
    });
    const text = container.textContent ?? "";
    expect(text).toContain("Below floor");
    expect(text).toContain("held"); // per-deal earnings marked held, rows still visible
    expect(text).toContain("$60,000.00 more booked revenue needed"); // 100000 - 40000 shortfall
    cleanup();
  });

  it("uncommissioned rep: explicit notice, not a wall of $0", () => {
    const { container, cleanup } = renderDrilldown({
      commissionSummary: summary({ commissionRate: 0, directEarnedCommission: 0, totalEarnedCommission: 0 }),
      commissionDeals: [],
    });
    const text = container.textContent ?? "";
    expect(text).toContain("Uncommissioned");
    cleanup();
  });

  it("non-flat-list window: caption does not over-claim a Team Commissions match", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    let root!: Root;
    act(() => {
      root = createRoot(container);
      root.render(
        <MemoryRouter>
          <RepCommissionDrilldown
            repId="rep-1"
            repName="Kevin Scott"
            periodLabel="MTD"
            isFlatListWindow={false}
            dateRange={{ from: "2026-06-01", to: "2026-06-30" }}
            commissionSummary={summary()}
            commissionDeals={SPLIT_DEALS}
            wonMissingContractDate={[]}
            onDataChanged={() => {}}
          />
        </MemoryRouter>
      );
    });
    const text = container.textContent ?? "";
    expect(text).toContain("Team Commissions shows YTD");
    expect(text).not.toContain("Matches this rep's row");
    act(() => root.unmount());
    container.remove();
  });

  it("partial payload (undefined arrays) does not crash the card", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    let root!: Root;
    act(() => {
      root = createRoot(container);
      root.render(
        <MemoryRouter>
          <RepCommissionDrilldown
            repId="rep-1"
            repName="Kevin Scott"
            periodLabel="YTD"
            isFlatListWindow
            dateRange={{ from: "2026-01-01", to: "2026-12-31" }}
            commissionSummary={summary({ directEarnedCommission: 0, totalEarnedCommission: 0 })}
            commissionDeals={undefined as unknown as Deals}
            wonMissingContractDate={undefined as unknown as Worklist}
            onDataChanged={() => {}}
          />
        </MemoryRouter>
      );
    });
    // No throw; renders the empty-breakdown copy rather than crashing on .filter/.map.
    expect(container.textContent ?? "").toContain("No contributing deals");
    act(() => root.unmount());
    container.remove();
  });
});

describe("RepCommissionDrilldown — floor bar", () => {
  it("below floor: the progress bar never renders 100% even when rounding would (must match 'Below floor')", () => {
    const { container, cleanup } = renderDrilldown({
      commissionSummary: summary({
        floorMet: false,
        qualifyingRevenue: 99600,
        rollingFloor: 100000,
        directEarnedCommission: 0,
        totalEarnedCommission: 0,
      }),
      commissionDeals: SPLIT_DEALS.map((d) => ({ ...d, earnedCommission: 0 })),
    });
    const text = container.textContent ?? "";
    expect(text).toContain("Below floor");
    // 99600/100000 = 99.6% — must floor/cap to 99%, never 100% while below floor.
    const bar = Array.from(container.querySelectorAll("div")).find(
      (d) => d.getAttribute("style")?.includes("width:")
    );
    expect(bar?.getAttribute("style") ?? "").toContain("width: 99%");
    cleanup();
  });
});

describe("RepCommissionDrilldown — view as rep", () => {
  it("lazy-loads the rep's own Engine A view from the director endpoint on expand", async () => {
    apiMock.mockResolvedValueOnce({
      data: {
        period: "ytd",
        summary: { earned: 6000, inPipeline: 2000, totalPotential: 8000, openDealCount: 3 },
        stageTotals: [
          { stageKey: "won", stageName: "Won", commission: 6000, dealValue: 80000, dealCount: 2, percentOfTotal: 75 },
        ],
        deals: [
          { dealId: "d-1", dealName: "Riverside Reroof", dealNumber: "D-1", companyName: "Acme", commission: 6000, isEarned: true, stageName: "Won" },
          { dealId: "d-2", dealName: "Open Pipeline Job", dealNumber: "D-2", companyName: null, commission: 2000, isEarned: false, stageName: "Estimating" },
        ],
      },
    });
    const { container, cleanup } = renderDrilldown({});
    const viewBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      (b.textContent ?? "").includes("View as rep")
    )!;
    await act(async () => {
      viewBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(apiMock).toHaveBeenCalledTimes(1);
    expect(apiMock.mock.calls[0]![0]).toContain("/dashboard/director/rep/rep-1/commission-view");
    const text = container.textContent ?? "";
    expect(text).toContain("Read-only");
    expect(text).toContain("exactly what Kevin Scott sees");
    // The contributing-deals list renders (faithful mirror — earned + open pipeline), not just stage totals.
    expect(text).toContain("Riverside Reroof");
    expect(text).toContain("Open Pipeline Job");
    // Relabel: the view-as-rep mirror shows "Won" (KPI label, stage row, earned-deal badge), never "Earned".
    expect(text).toContain("Won");
    expect(text).not.toContain("Earned");
    cleanup();
  });

  it("re-fetches the rep view when the period (dateRange) changes while the panel is open", async () => {
    apiMock.mockResolvedValue({
      data: {
        period: "ytd",
        summary: { earned: 6000, inPipeline: 0, totalPotential: 6000, openDealCount: 0 },
        stageTotals: [],
        deals: [],
      },
    });
    const container = document.createElement("div");
    document.body.appendChild(container);
    let root!: Root;
    const renderWith = (range: { from: string; to: string }) =>
      act(() => {
        root.render(
          <MemoryRouter>
            <RepCommissionDrilldown
              repId="rep-1"
              repName="Kevin Scott"
              periodLabel="YTD"
              isFlatListWindow
              dateRange={range}
              commissionSummary={summary()}
              commissionDeals={SPLIT_DEALS}
              wonMissingContractDate={[]}
              onDataChanged={() => {}}
            />
          </MemoryRouter>
        );
      });
    act(() => {
      root = createRoot(container);
    });
    renderWith({ from: "2026-01-01", to: "2026-12-31" });

    // Open the panel -> first fetch for the YTD window.
    const viewBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      (b.textContent ?? "").includes("View as rep")
    )!;
    await act(async () => {
      viewBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();
    expect(apiMock).toHaveBeenCalledTimes(1);
    expect(apiMock.mock.calls[0]![0]).toContain("from=2026-01-01");

    // Director switches to MTD for the same rep -> the open panel must refetch the new window.
    renderWith({ from: "2026-06-01", to: "2026-06-30" });
    await flush();
    expect(apiMock).toHaveBeenCalledTimes(2);
    expect(apiMock.mock.calls[1]![0]).toContain("from=2026-06-01");

    act(() => root.unmount());
    container.remove();
  });
});

describe("RepCommissionDrilldown — missing-contract worklist", () => {
  it("PATCHes the contract date and refetches on save", async () => {
    apiMock.mockResolvedValueOnce({ deal: {} });
    const onDataChanged = vi.fn();
    const worklist: Worklist = [
      {
        dealId: "deal-stuck",
        dealNumber: "WL-1",
        dealName: "Stuck won deal",
        companyName: "Gamma",
        propertyName: null,
        value: 70000,
        wonDate: "2026-04-01",
      },
    ];
    const { container, cleanup } = renderDrilldown({ wonMissingContractDate: worklist, onDataChanged });

    const text = container.textContent ?? "";
    expect(text).toContain("Won, missing contract date (1)");
    expect(text).toContain("Stuck won deal");

    const dateInput = container.querySelector('input[type="date"]') as HTMLInputElement;
    // Use the native value setter so React's controlled-input value tracker registers the change.
    const nativeSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value"
    )!.set!;
    await act(async () => {
      nativeSetter.call(dateInput, "2026-04-10");
      dateInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const saveBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      (b.textContent ?? "").includes("Set date")
    )!;
    await act(async () => {
      saveBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(apiMock).toHaveBeenCalledTimes(1);
    expect(apiMock.mock.calls[0]![0]).toBe("/deals/deal-stuck/contract-signed-date");
    expect(apiMock.mock.calls[0]![1]).toMatchObject({ method: "PATCH", json: { date: "2026-04-10" } });
    expect(onDataChanged).toHaveBeenCalledTimes(1);
    cleanup();
  });
});
