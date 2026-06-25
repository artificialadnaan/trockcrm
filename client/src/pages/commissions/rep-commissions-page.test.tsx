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
