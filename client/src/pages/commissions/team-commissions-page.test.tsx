// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TeamCommissionsPage } from "./team-commissions-page";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({ apiMock: vi.fn() }));
vi.mock("@/lib/api", () => ({ api: mocks.apiMock }));

const workspace = {
  rows: [
    {
      repId: "rep-1", repName: "Kaleb Marshall",
      totalEarnedCommission: 0, potentialCommission: 261029.68, floorRemaining: 0,
      newCustomerShare: 0, meetsNewCustomerShare: true,
      activeDeals: 23, pipelineValue: 11601319, wonUnsignedValue: 500000, wonUnsignedCount: 1,
      leads: 1, qualifiedLeads: 0, opportunities: 0,
      estimating: 23, calls: 0, emails: 517, meetings: 0, notes: 0, totalActivities: 721,
    },
    {
      // Estimator whose won·unsigned deals have NO awarded/bid/DD amount yet: value $0 but COUNT 2. The cell
      // must stay drillable (gated on count, not value) and surface "(2)" — locking the zero-value regression.
      repId: "rep-2", repName: "Sidney Gibson",
      totalEarnedCommission: 0, potentialCommission: 127213.96, floorRemaining: 0,
      newCustomerShare: 0, meetsNewCustomerShare: true,
      activeDeals: 37, pipelineValue: 21202326.99, wonUnsignedValue: 0, wonUnsignedCount: 2,
      leads: 0, qualifiedLeads: 0, opportunities: 0,
      estimating: 37, calls: 0, emails: 0, meetings: 0, notes: 0, totalActivities: 0,
    },
  ],
  // De-duped office totals — DELIBERATELY less than the row sum ($32.8M) to prove the KPI/footer use these
  // (each deal once) instead of summing the involvement rows. Count 3 = Kaleb's 1 valued + Sidney's 2 $0-value.
  officeTotals: { activeDeals: 45, pipelineValue: 30000000, wonUnsignedValue: 500000, wonUnsignedCount: 3 },
};

const evidence = {
  metric: "pipeline", kind: "deal", repId: "rep-1", repName: "Kaleb Marshall",
  title: "Kaleb Marshall — Pipeline value", subtitle: "Open best-estimate", valueLabel: "Deal value",
  total: { count: 1, value: 11601319 },
  records: [
    { id: "d1", navKind: "deal", navId: "d1", primary: "D-1", name: "Tower Re-Cover", stageLabel: "Estimating", value: 11601319, date: "2026-04-01", companyName: "Acme" },
  ],
};

async function render() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let root: Root | null = null;
  await act(async () => {
    root = createRoot(container);
    root.render(<MemoryRouter><TeamCommissionsPage /></MemoryRouter>);
  });
  await act(async () => { await Promise.resolve(); });
  return { container, root: root! };
}

describe("TeamCommissionsPage", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    mocks.apiMock.mockReset();
    mocks.apiMock.mockImplementation((url: string) =>
      url.includes("/evidence")
        ? Promise.resolve({ data: evidence })
        : Promise.resolve({ data: workspace }),
    );
  });

  it("renders reps, a Won·unsigned column, and de-duped deal-value totals (NOT the row sum)", async () => {
    const { container } = await render();
    expect(container.textContent).toContain("Kaleb Marshall");
    expect(container.textContent).toContain("Sidney Gibson");
    expect(container.textContent).toContain("Won · unsigned"); // new column + KPI
    // Open-pipeline total uses officeTotals ($30,000,000) — NOT the double-counted row sum ($32,803,645.99).
    expect(container.textContent).toContain("Open pipeline");
    expect(container.textContent).toContain("$30,000,000.00");
    expect(container.textContent).not.toContain("$32,803,645.99");
    expect(container.textContent).toContain("Team total");
  });

  it("clicking a rep's pipeline opens the drill drawer for that rep+metric", async () => {
    await render();
    const pipelineBtn = Array.from(document.querySelectorAll("button")).find(
      (b) => b.textContent === "$11,601,319.00",
    ) as HTMLButtonElement;
    expect(pipelineBtn).toBeTruthy();
    await act(async () => { pipelineBtn.click(); });
    await act(async () => { await Promise.resolve(); });

    expect(mocks.apiMock).toHaveBeenCalledWith(
      expect.stringContaining("/dashboard/director/commissions/evidence?repId=rep-1&metric=pipeline"),
    );
    // drawer (portal) shows the supporting record
    expect(document.body.textContent).toContain("Kaleb Marshall — Pipeline value");
    expect(document.body.textContent).toContain("Tower Re-Cover");
  });

  it("a $0 figure is rendered dimmed and is NOT a drill button", async () => {
    const { container } = await render();
    // Both reps' earned = $0 -> rendered as plain dimmed spans ("$0.00" with usdExact), never buttons.
    const zeroButtons = Array.from(document.querySelectorAll("button")).filter((b) => b.textContent === "$0.00");
    expect(zeroButtons).toHaveLength(0);
    // ...and the dimmed $0.00 cell actually exists (so the assertion above isn't vacuous).
    const dimmed = Array.from(container.querySelectorAll("span")).find(
      (s) => s.textContent === "$0.00" && s.className.includes("text-slate-300"),
    );
    expect(dimmed).toBeTruthy();
  });

  it("a $0 won·unsigned cell with deals stays drillable on COUNT (not value) and surfaces its count", async () => {
    await render();
    // Sidney: $0 value but 2 unsigned wins -> a drill BUTTON reading "$0.00 (2)", NOT a dimmed span.
    const wonBtn = Array.from(document.querySelectorAll("button")).find(
      (b) => b.textContent?.replace(/\s/g, "") === "$0.00(2)",
    ) as HTMLButtonElement;
    expect(wonBtn).toBeTruthy();
    await act(async () => { wonBtn.click(); });
    await act(async () => { await Promise.resolve(); });
    // Drill keys off the COUNT, so the won_unsigned evidence is requested even though the value is $0.
    expect(mocks.apiMock).toHaveBeenCalledWith(
      expect.stringContaining("/dashboard/director/commissions/evidence?repId=rep-2&metric=won_unsigned"),
    );
  });

  it("Won·unsigned KPI + footer surface the deal count when the office total value is $0", async () => {
    mocks.apiMock.mockImplementation((url: string) =>
      url.includes("/evidence")
        ? Promise.resolve({ data: evidence })
        : Promise.resolve({
            data: {
              rows: workspace.rows,
              // Whole office's unsigned wins lack amounts: $0 total but 4 deals -> must NOT read as a bare "$0.00".
              officeTotals: { activeDeals: 45, pipelineValue: 30000000, wonUnsignedValue: 0, wonUnsignedCount: 4 },
            },
          }),
    );
    const { container } = await render();
    // Appears in BOTH the KPI card and the footer total (≥2), each as "$0.00 (4)".
    const matches = container.textContent?.match(/\$0\.00 \(4\)/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  it("changing the period preset refetches the workspace", async () => {
    const { container } = await render();
    const mtd = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "MTD") as HTMLButtonElement;
    await act(async () => { mtd.click(); });
    await act(async () => { await Promise.resolve(); });
    const workspaceCalls = mocks.apiMock.mock.calls.filter(([u]) => !String(u).includes("/evidence"));
    // at least the initial YTD fetch + the MTD refetch (distinct from/to query strings)
    expect(new Set(workspaceCalls.map(([u]) => String(u))).size).toBeGreaterThanOrEqual(2);
  });
});
