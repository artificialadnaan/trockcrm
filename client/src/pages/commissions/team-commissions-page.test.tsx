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
      activeDeals: 23, pipelineValue: 11601319, leads: 1, qualifiedLeads: 0, opportunities: 0,
      estimating: 23, calls: 0, emails: 517, meetings: 0, notes: 0, totalActivities: 721,
    },
    {
      repId: "rep-2", repName: "Sidney Gibson",
      totalEarnedCommission: 0, potentialCommission: 127213.96, floorRemaining: 0,
      newCustomerShare: 0, meetsNewCustomerShare: true,
      activeDeals: 37, pipelineValue: 21202326.99, leads: 0, qualifiedLeads: 0, opportunities: 0,
      estimating: 37, calls: 0, emails: 0, meetings: 0, notes: 0, totalActivities: 0,
    },
  ],
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

  it("renders reps, KPI totals and a team-total footer", async () => {
    const { container } = await render();
    expect(container.textContent).toContain("Kaleb Marshall");
    expect(container.textContent).toContain("Sidney Gibson");
    // KPI cards + footer total of the two reps' pipeline ($11,601,319 + $21,202,326.99)
    expect(container.textContent).toContain("Open pipeline");
    expect(container.textContent).toContain("$32,803,646"); // usd() rounds to whole dollars
    expect(container.textContent).toContain("Team total");
  });

  it("clicking a rep's pipeline opens the drill drawer for that rep+metric", async () => {
    await render();
    const pipelineBtn = Array.from(document.querySelectorAll("button")).find(
      (b) => b.textContent === "$11,601,319",
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

  it("a $0 figure is not a drill button (dimmed)", async () => {
    await render();
    // Kaleb earned = $0 -> rendered as plain dimmed text, never a clickable button
    const earnedButton = Array.from(document.querySelectorAll("button")).find((b) => b.textContent === "$0.00");
    expect(earnedButton).toBeUndefined();
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
