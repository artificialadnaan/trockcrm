// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RepCommissionsPage } from "./rep-commissions-page";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  apiMock: vi.fn(),
  downloadTextFile: vi.fn(),
}));

vi.mock("@/lib/api", () => ({ api: mocks.apiMock }));
vi.mock("@/lib/report-export", async () => {
  const actual = await vi.importActual<typeof import("@/lib/report-export")>("@/lib/report-export");
  return {
    ...actual,
    downloadTextFile: mocks.downloadTextFile,
  };
});

const dashboard = {
  period: "ytd",
  dateRange: { from: "2026-01-01", to: "2026-05-09" },
  formula: "Commission = deal value x rep commission rate.",
  goal: { amount: 12000, percentToGoal: 16.5, source: "none" },
  summary: {
    earned: 1980,
    inPipeline: 44850,
    totalPotential: 46830,
    openDealCount: 4,
    wonAwaitingSignature: { dealCount: 7, dealValue: 1388292, potentialCommission: 8329.75 },
  },
  stageTotals: [
    { stageKey: "won", stageName: "Won", commission: 1980, dealValue: 132000, dealCount: 2, percentOfTotal: 4.2 },
    { stageKey: "contract", stageName: "Contract", commission: 4575, dealValue: 305000, dealCount: 1, percentOfTotal: 9.8 },
    { stageKey: "estimate_sent", stageName: "Estimate Sent", commission: 16800, dealValue: 1120000, dealCount: 1, percentOfTotal: 35.9 },
    { stageKey: "estimating", stageName: "Estimating", commission: 16800, dealValue: 1120000, dealCount: 1, percentOfTotal: 35.9 },
    { stageKey: "opportunity", stageName: "Opportunity", commission: 6675, dealValue: 445000, dealCount: 1, percentOfTotal: 14.3 },
  ],
  deals: [
    {
      dealId: "deal-earned",
      dealNumber: "D-1",
      dealName: "Allen Sports Complex",
      companyName: "Allen ISD",
      propertyName: "Stadium",
      propertyAddress: "1 Eagle Way",
      stageKey: "won",
      stageName: "Won",
      stageSlug: "sent_to_production",
      dealValue: 100000,
      commissionRate: 0.015,
      commission: 1500,
      deltaCommission: null,
      contractSignedDate: "2026-05-02",
      expectedCloseDate: null,
      daysInStage: 5,
      isEarned: true,
    },
    {
      dealId: "deal-contract",
      dealNumber: "D-2",
      dealName: "Garland Warehouse 14",
      companyName: "Garland Industrial",
      propertyName: null,
      propertyAddress: "14 Warehouse Rd",
      stageKey: "contract",
      stageName: "Contract",
      stageSlug: "contract",
      dealValue: 305000,
      commissionRate: 0.015,
      commission: 4575,
      deltaCommission: 75,
      contractSignedDate: null,
      expectedCloseDate: "2026-05-22",
      daysInStage: 7,
      isEarned: false,
    },
    {
      dealId: "deal-estimating",
      dealNumber: "D-3",
      dealName: "Plano Office Tower Re-Cover",
      companyName: "Plano Tower LP",
      propertyName: null,
      propertyAddress: "2 Plano Ave",
      stageKey: "estimating",
      stageName: "Estimating",
      stageSlug: "estimating",
      dealValue: 320000,
      commissionRate: 0.015,
      commission: 4800,
      deltaCommission: -120,
      contractSignedDate: null,
      expectedCloseDate: "2026-06-30",
      daysInStage: 9,
      isEarned: false,
    },
  ],
};

async function renderPage() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let root: Root | null = null;
  await act(async () => {
    root = createRoot(container);
    root.render(
      <MemoryRouter>
        <RepCommissionsPage />
      </MemoryRouter>
    );
  });
  await act(async () => {
    await Promise.resolve();
  });
  return { container, root: root! };
}

async function unmount(root: Root) {
  await act(async () => {
    root.unmount();
  });
}

describe("RepCommissionsPage", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    mocks.apiMock.mockReset();
    mocks.downloadTextFile.mockReset();
    mocks.apiMock.mockResolvedValue({ data: dashboard });
  });

  it("renders KPI strip with won, in pipeline, total potential and red won card", async () => {
    const { container, root } = await renderPage();

    expect(container.textContent).toContain("Won");
    expect(container.textContent).toContain("In pipeline");
    expect(container.textContent).toContain("Total potential");
    expect(container.textContent).toContain("$1,980.00");
    expect(Array.from(container.querySelectorAll(".bg-brand-red")).some((node) => node.textContent?.includes("Contract signed"))).toBe(true);
    await unmount(root);
  });

  it("surfaces won-but-unsigned deals as an 'awaiting contract signature' callout", async () => {
    const { container, root } = await renderPage();
    expect(container.textContent).toContain("Won — awaiting contract signature");
    expect(container.textContent).toContain("7 won deals");
    expect(container.textContent).toContain("$1,388,292.00"); // the won value otherwise invisible
    await unmount(root);
  });

  it("time-range change refetches data", async () => {
    const { container, root } = await renderPage();

    await act(async () => {
      (Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "MTD") as HTMLButtonElement).click();
    });

    expect(mocks.apiMock).toHaveBeenCalledWith("/commissions/dashboard?period=ytd");
    expect(mocks.apiMock).toHaveBeenCalledWith("/commissions/dashboard?period=mtd");
    await unmount(root);
  });

  it("renders pipeline by stage proportions and stage columns sum to total", async () => {
    const { container, root } = await renderPage();

    expect(container.textContent).toContain("Pipeline by stage");
    expect(container.textContent).toContain("4% of total");
    const total = dashboard.stageTotals.reduce((sum, stage) => sum + stage.commission, 0);
    expect(total).toBe(dashboard.summary.totalPotential);
    await unmount(root);
  });

  it("goal progress bar reflects earned over goal", async () => {
    const { container, root } = await renderPage();

    expect(container.textContent).toContain("$1,980.00 / $12,000.00 (17%)");
    await unmount(root);
  });

  it("projects table groups by stage in the correct order with context text", async () => {
    const { container, root } = await renderPage();
    const text = container.textContent ?? "";

    expect(text.indexOf("Won")).toBeLessThan(text.indexOf("Contract"));
    expect(text.indexOf("Contract")).toBeLessThan(text.indexOf("Estimating"));
    expect(text).toContain("Contract signed · locked in");
    expect(text).toContain("One signature away");
    expect(text).toContain("Pricing in progress");
    await unmount(root);
  });

  it("deal row shows value, rate, commission, delta colors, and detail link semantics", async () => {
    const { container, root } = await renderPage();

    expect(container.textContent).toContain("Garland Warehouse 14");
    expect(container.textContent).toContain("$305,000.00");
    expect(container.textContent).toContain("1.5%");
    expect(container.textContent).toContain("+$75.00 since last update");
    expect(container.textContent).toContain("-$120.00 since last update");
    expect(container.querySelector('a[href="/deals/deal-contract"]')).not.toBeNull();
    await unmount(root);
  });

  it("export button triggers CSV download", async () => {
    const { container, root } = await renderPage();

    await act(async () => {
      (Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes("Export")) as HTMLButtonElement).click();
    });

    expect(mocks.downloadTextFile).toHaveBeenCalledWith(
      expect.stringContaining("Garland Warehouse 14"),
      expect.stringMatching(/commissions-\d{4}-\d{2}-\d{2}\.csv/),
      "text/csv;charset=utf-8;"
    );
    const csv = String(mocks.downloadTextFile.mock.calls[0][0]);
    expect(csv).toContain("deal,company,property,stage,status,dealValue,rate,commission");
    expect(csv).toContain("Allen Sports Complex,Allen ISD,Stadium,Won,Won,100000.00,1.50,1500.00");
    expect(csv).toContain("Garland Warehouse 14,Garland Industrial,14 Warehouse Rd,Contract,Pipeline,305000.00,1.50,4575.00");
    await unmount(root);
  });

  it("total row sums visible commissions", async () => {
    const { container, root } = await renderPage();

    expect(container.textContent).toContain("$10,875.00");
    await unmount(root);
  });
});

// A deductive change order books a NEGATIVE commission row (a claw-back). The server stopped dropping
// it (reporting-service's UNION filter went `> 0` -> `<> 0`), so it now reaches this page — but the
// summary above the list sized itself on the NET stage total and skipped any stage whose commission was
// `<= 0`. For a period whose only activity is a claw-back that produced a flat contradiction: the deal
// list showed the claw-back while the visualization above it said there had been no activity at all.
describe("RepCommissionsPage — deductive change-order claw-back", () => {
  function clawBackDashboard(over: Partial<typeof dashboard> = {}) {
    return {
      ...dashboard,
      summary: { ...dashboard.summary, earned: -2000, inPipeline: 0, totalPotential: -2000, openDealCount: 0 },
      // Only the Won stage carries activity, and it is negative. `percentOfTotal` is 0 on every row
      // because the server divides by totalPotential and guards `> 0` — the page must not depend on it.
      stageTotals: [
        { stageKey: "won", stageName: "Won", commission: -2000, dealValue: -20000, dealCount: 1, percentOfTotal: 0 },
        { stageKey: "contract", stageName: "Contract", commission: 0, dealValue: 0, dealCount: 0, percentOfTotal: 0 },
        { stageKey: "estimate_sent", stageName: "Estimate Sent", commission: 0, dealValue: 0, dealCount: 0, percentOfTotal: 0 },
        { stageKey: "estimating", stageName: "Estimating", commission: 0, dealValue: 0, dealCount: 0, percentOfTotal: 0 },
        { stageKey: "opportunity", stageName: "Opportunity", commission: 0, dealValue: 0, dealCount: 0, percentOfTotal: 0 },
      ],
      deals: [
        {
          ...dashboard.deals[0]!,
          dealId: "deal-deductive-co",
          dealName: "Allen Sports Complex — CO #2",
          dealValue: -20000,
          commissionRate: 0.1,
          commission: -2000,
          deltaCommission: null,
        },
      ],
      ...over,
    };
  }

  const segments = (container: HTMLElement) =>
    Array.from(container.querySelectorAll<HTMLElement>('[data-testid="commission-stage-segment"]'));

  beforeEach(() => {
    document.body.innerHTML = "";
    mocks.apiMock.mockReset();
    mocks.downloadTextFile.mockReset();
  });

  it("does NOT claim 'no commission activity' when the only activity is a claw-back", async () => {
    mocks.apiMock.mockResolvedValue({ data: clawBackDashboard() });
    const { container, root } = await renderPage();

    expect(container.textContent).not.toContain("No commission activity yet");
    // The list plainly shows the claw-back, so the summary above it must too.
    expect(container.textContent).toContain("Allen Sports Complex — CO #2");
    expect(container.textContent).toContain("-$2,000.00");
    await unmount(root);
  });

  it("renders the claw-back as a signed segment — magnitude by width, sign by flag and label", async () => {
    mocks.apiMock.mockResolvedValue({ data: clawBackDashboard() });
    const { container, root } = await renderPage();

    const bars = segments(container);
    expect(bars).toHaveLength(1);
    expect(bars[0]!.dataset.stage).toBe("won");
    // Length can only encode magnitude: it is the ONLY non-zero stage, so it fills the bar...
    expect(bars[0]!.style.width).toBe("100%");
    // ...and the sign rides on the claw-back flag + the signed label, never on the width.
    expect(bars[0]!.dataset.clawBack).toBe("true");
    expect(bars[0]!.textContent).toContain("-$2.0K");
    expect(bars[0]!.title).toBe("Won: -$2,000.00 (claw-back)");
    await unmount(root);
  });

  it("sizes a mixed +/- period on MAGNITUDE so the claw-back is visible at its true size", async () => {
    mocks.apiMock.mockResolvedValue({
      data: clawBackDashboard({
        summary: { ...dashboard.summary, earned: -2000, inPipeline: 8000, totalPotential: 6000, openDealCount: 1 },
        stageTotals: [
          { stageKey: "won", stageName: "Won", commission: -2000, dealValue: -20000, dealCount: 1, percentOfTotal: -33.3 },
          { stageKey: "contract", stageName: "Contract", commission: 8000, dealValue: 533333, dealCount: 1, percentOfTotal: 133.3 },
          { stageKey: "estimate_sent", stageName: "Estimate Sent", commission: 0, dealValue: 0, dealCount: 0, percentOfTotal: 0 },
          { stageKey: "estimating", stageName: "Estimating", commission: 0, dealValue: 0, dealCount: 0, percentOfTotal: 0 },
          { stageKey: "opportunity", stageName: "Opportunity", commission: 0, dealValue: 0, dealCount: 0, percentOfTotal: 0 },
        ],
      }),
    });
    const { container, root } = await renderPage();

    const bars = segments(container);
    expect(bars.map((bar) => bar.dataset.stage)).toEqual(["won", "contract"]);
    // |−2000| / (2000 + 8000) = 20%, |8000| / 10000 = 80% — widths still fill the bar.
    expect(bars[0]!.style.width).toBe("20%");
    expect(bars[1]!.style.width).toBe("80%");
    expect(bars[0]!.dataset.clawBack).toBe("true");
    expect(bars[1]!.dataset.clawBack).toBeUndefined();
    // The legend percentages come off the SAME magnitude basis, so bar and legend can't disagree.
    expect(container.textContent).toContain("20% of total");
    expect(container.textContent).toContain("80% of total");
    await unmount(root);
  });

  // The case a magnitude-AFTER-aggregation fix cannot reach. A deductive CO child is created Won, so its
  // claw-back shares the `won` stageKey with the commission it reduces, and the SERVER nets the two into
  // one stage commission (reporting-service.ts stageTotals) before the client sees anything. An equal pair
  // nets to 0, and `Math.abs(0)` is still 0 — the bar claimed "no activity" over a list showing $10,000 of
  // it. The per-deal rows the server aggregated FROM ride along in the same payload, so the components are
  // recoverable; they just have to be read before the netting, not after.
  it("splits one stage's commission and equal claw-back into two segments instead of netting them away", async () => {
    mocks.apiMock.mockResolvedValue({
      // Built inline rather than through clawBackDashboard's `over`: the whole point of this fixture is
      // its `deals`, and `Partial<typeof dashboard>` narrows that array to the base fixture's exact
      // literal shapes.
      data: {
        ...dashboard,
        summary: { ...dashboard.summary, earned: 0, inPipeline: 0, totalPotential: 0, openDealCount: 0 },
        // The server nets the pair into ONE stage commission of 0 and, dividing by a totalPotential of 0
        // behind its `> 0` guard, reports 0% everywhere. Both halves of the activity are invisible here.
        stageTotals: dashboard.stageTotals.map((stage) => ({
          ...stage,
          commission: 0,
          dealValue: 0,
          dealCount: stage.stageKey === "won" ? 2 : 0,
          percentOfTotal: 0,
        })),
        deals: [
          {
            ...dashboard.deals[0]!,
            dealId: "deal-parent",
            dealName: "Allen Sports Complex",
            dealValue: 50000,
            commissionRate: 0.1,
            commission: 5000,
            deltaCommission: null,
          },
          {
            ...dashboard.deals[0]!,
            dealId: "deal-deductive-co",
            dealName: "Allen Sports Complex — CO #2",
            dealValue: -50000,
            commissionRate: 0.1,
            commission: -5000,
            deltaCommission: null,
          },
        ],
      },
    });
    const { container, root } = await renderPage();

    expect(container.textContent).not.toContain("No commission activity yet");

    const bars = segments(container);
    expect(bars).toHaveLength(2);
    expect(bars.map((bar) => bar.dataset.stage)).toEqual(["won", "won"]);
    // Each segment is one real, single-signed quantity at its true magnitude — $5,000 of commission and
    // $5,000 clawed back, half the period's movement each. Neither a zero-width segment (which shows
    // nothing) nor one $10,000 segment (which nobody earned) would be true.
    expect(bars[0]!.style.width).toBe("50%");
    expect(bars[1]!.style.width).toBe("50%");
    expect(bars[0]!.dataset.clawBack).toBeUndefined();
    expect(bars[1]!.dataset.clawBack).toBe("true");
    expect(bars[0]!.title).toBe("Won: $5,000.00");
    expect(bars[1]!.title).toBe("Won: -$5,000.00 (claw-back)");
    expect(bars[0]!.textContent).toContain("$5.0K");
    expect(bars[1]!.textContent).toContain("-$5.0K");

    // The legend keeps the stage NET ($0.00) — that is what the rep takes home — but its share comes off
    // the same magnitude basis as the widths (50% + 50%), and it names the claw-back so the two same-stage
    // segments are explained rather than mysterious.
    expect(container.textContent).toContain("100% of total");
    expect(container.textContent).toContain("incl. -$5,000.00 clawed back");
    await unmount(root);
  });

  it("keeps the empty state for a period with genuinely nothing in it", async () => {
    mocks.apiMock.mockResolvedValue({
      data: clawBackDashboard({
        summary: { ...dashboard.summary, earned: 0, inPipeline: 0, totalPotential: 0, openDealCount: 0 },
        stageTotals: dashboard.stageTotals.map((stage) => ({ ...stage, commission: 0, dealValue: 0, dealCount: 0, percentOfTotal: 0 })),
        deals: [],
      }),
    });
    const { container, root } = await renderPage();

    expect(container.textContent).toContain("No commission activity yet");
    expect(segments(container)).toHaveLength(0);
    await unmount(root);
  });
});
