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

  it("floor met: shows cleared, no held markers", () => {
    const { container, cleanup } = renderDrilldown({});
    const text = container.textContent ?? "";
    expect(text).toContain("Floor cleared");
    expect(text).not.toContain("held");
    expect(text).toContain("$120,000 of $100,000");
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
    expect(text).toContain("$60,000 more booked revenue needed"); // 100000 - 40000 shortfall
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

describe("RepCommissionDrilldown — view as rep", () => {
  it("lazy-loads the rep's own Engine A view from the director endpoint on expand", async () => {
    apiMock.mockResolvedValueOnce({
      data: {
        period: "ytd",
        summary: { earned: 6000, inPipeline: 2000, totalPotential: 8000, openDealCount: 3 },
        stageTotals: [
          { stageKey: "won", stageName: "Earned", commission: 6000, dealValue: 80000, dealCount: 2, percentOfTotal: 75 },
        ],
        deals: [],
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
    cleanup();
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
