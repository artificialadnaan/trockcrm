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
      repId: "rep-1", repName: "Kaleb Marshall", isRep: true,
      totalEarnedCommission: 0, potentialCommission: 261029.68, floorRemaining: 0,
      newCustomerShare: 0, meetsNewCustomerShare: true,
      activeDeals: 23, pipelineValue: 11601319, wonUnsignedValue: 500000, wonUnsignedCount: 1,
      leads: 1, qualifiedLeads: 0, opportunities: 0,
      estimating: 23, calls: 0, emails: 517, meetings: 0, notes: 0, totalActivities: 721,
    },
    {
      // Estimator whose won·unsigned deals have NO awarded/bid/DD amount yet: value $0 but COUNT 2. The cell
      // must stay drillable (gated on count, not value) and surface "(2)" — locking the zero-value regression.
      repId: "rep-2", repName: "Sidney Gibson", isRep: true,
      totalEarnedCommission: 0, potentialCommission: 127213.96, floorRemaining: 0,
      newCustomerShare: 0, meetsNewCustomerShare: true,
      activeDeals: 37, pipelineValue: 21202326.99, wonUnsignedValue: 0, wonUnsignedCount: 2,
      leads: 0, qualifiedLeads: 0, opportunities: 0,
      estimating: 37, calls: 0, emails: 0, meetings: 0, notes: 0, totalActivities: 0,
    },
    {
      // A NON-rep source row (a director): earned-only, involvement columns zeroed. Its name must NOT link
      // to the rep-detail page (P).
      repId: "dir-1", repName: "Chase Kelly", isRep: false,
      totalEarnedCommission: 250, potentialCommission: 0, floorRemaining: 0,
      newCustomerShare: 0, meetsNewCustomerShare: true,
      activeDeals: 0, pipelineValue: 0, wonUnsignedValue: 0, wonUnsignedCount: 0,
      leads: 0, qualifiedLeads: 0, opportunities: 0,
      estimating: 0, calls: 0, emails: 0, meetings: 0, notes: 0, totalActivities: 0,
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

  // ── floor-hold display (review findings) ──────────────────────────────────────────────────────────
  // A "held only" row: below floor (floorMet=false) with real earned commission withheld
  // (heldEarnedCommission>0) and nothing payable (totalEarnedCommission=0).
  const heldRow = {
    repId: "rep-held", repName: "Hold Below",
    totalEarnedCommission: 0, heldEarnedCommission: 4340, floorMet: false, floorRemaining: 4995660,
    potentialCommission: 0, newCustomerShare: 0, meetsNewCustomerShare: true,
    activeDeals: 1, pipelineValue: 0, wonUnsignedValue: 0, wonUnsignedCount: 0,
    leads: 0, qualifiedLeads: 0, opportunities: 0,
    estimating: 0, calls: 0, emails: 0, meetings: 0, notes: 0, totalActivities: 0,
  };
  const mockWorkspaceRows = (rows: unknown[]) =>
    mocks.apiMock.mockImplementation((url: string) =>
      url.includes("/evidence")
        ? Promise.resolve({ data: { ...evidence, repId: "rep-held", metric: "earned" } })
        : Promise.resolve({ data: { rows, officeTotals: workspace.officeTotals } }),
    );

  it("a below-floor rep shows a DRILLABLE held amount + 'held' badge, not a dimmed $0 (findings #1)", async () => {
    mockWorkspaceRows([heldRow]);
    const { container } = await render();
    // The held amount is a real button (drillable to its deals), NOT a dimmed non-clickable span.
    const heldBtn = Array.from(document.querySelectorAll("button")).find((b) => b.textContent === "$4,340.00");
    expect(heldBtn).toBeTruthy();
    // The amber "held · $X to floor" cue carries the below-floor context.
    expect(container.textContent).toContain("held · $4,995,660.00 to floor");
    // ...and the held amount is a clickable button, never the dimmed non-clickable $0 treatment.
    expect((heldBtn as HTMLElement).className).not.toContain("text-slate-300");
    await act(async () => { (heldBtn as HTMLButtonElement).click(); });
    await act(async () => { await Promise.resolve(); });
    expect(mocks.apiMock).toHaveBeenCalledWith(
      expect.stringContaining("/dashboard/director/commissions/evidence?repId=rep-held&metric=earned"),
    );
  });

  it("the Earned KPI + footer total reconcile with the held column value, not $0 (totals-vs-displayed finding)", async () => {
    mockWorkspaceRows([heldRow]);
    const { container } = await render();
    // The held $4,340 must appear THREE times: the column cell, the "Earned commission" KPI card, and the
    // "Team total" footer. Summing totalEarnedCommission would leave both totals at $0.00 — contradicting the
    // column (the very thing the held display exists to fix).
    const occurrences = (container.textContent?.match(/\$4,340\.00/g) ?? []).length;
    expect(occurrences).toBeGreaterThanOrEqual(3); // column + KPI + footer all reconcile
    expect(container.textContent).toContain("Earned commission");
    expect(container.textContent).toContain("Team total");
  });

  it("a below-floor rep with a payable override shows the payable total, not the held-only display (finding #2)", async () => {
    // Manager override is NOT floor-gated: totalEarnedCommission = override ($1,500) even below floor.
    mockWorkspaceRows([{ ...heldRow, totalEarnedCommission: 1500 }]);
    const { container } = await render();
    // The payable total is shown (drillable) and the held-only collapse does NOT hide it.
    const payableBtn = Array.from(document.querySelectorAll("button")).find((b) => b.textContent === "$1,500.00");
    expect(payableBtn).toBeTruthy();
    expect(container.textContent).not.toContain("held ·"); // not the held-only branch
    expect(container.textContent).not.toContain("$4,340.00"); // held amount not surfaced over the payable total
  });

  it("sorts the Earned column by the displayed amount — a held row outranks a true $0 (finding #3)", async () => {
    // zeroRow truly earns nothing ($0 displayed); heldRow displays its held $4,340. Sorting Earned desc must
    // put the held row above the $0 row even though both have totalEarnedCommission === 0.
    const zeroRow = { ...heldRow, repId: "rep-zero", repName: "Zero Earner", heldEarnedCommission: 0, floorMet: true };
    mockWorkspaceRows([zeroRow, heldRow]);
    const { container } = await render();
    const earnedHeader = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes("Earned")) as HTMLButtonElement;
    // Toggle to a deterministic Earned-desc sort.
    await act(async () => { earnedHeader.click(); });
    await act(async () => { await Promise.resolve(); });
    let order = Array.from(container.querySelectorAll("tbody tr")).map((tr) => tr.textContent ?? "");
    if (order.findIndex((t) => t.includes("Hold Below")) > order.findIndex((t) => t.includes("Zero Earner"))) {
      await act(async () => { earnedHeader.click(); }); // ensure desc (held on top)
      await act(async () => { await Promise.resolve(); });
      order = Array.from(container.querySelectorAll("tbody tr")).map((tr) => tr.textContent ?? "");
    }
    const heldIdx = order.findIndex((t) => t.includes("Hold Below"));
    const zeroIdx = order.findIndex((t) => t.includes("Zero Earner"));
    expect(heldIdx).toBeGreaterThanOrEqual(0);
    expect(heldIdx).toBeLessThan(zeroIdx); // held ($4,340 displayed) sorts above true $0
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

  it("does NOT link a non-rep source row's name to the rep-detail page (P)", async () => {
    const { container } = await render();
    const links = Array.from(container.querySelectorAll("a"));
    // A rep's name links to their rep-detail page.
    const kalebLink = links.find((a) => a.textContent?.includes("Kaleb Marshall"));
    expect(kalebLink?.getAttribute("href")).toContain("/director/rep/rep-1");
    // A non-rep source (Chase Kelly) is shown but NOT linked — the rep-detail page is rep-centric and would
    // show their owned deals, which the workspace deliberately zeroes.
    expect(links.some((a) => a.textContent?.includes("Chase Kelly"))).toBe(false);
    expect(container.textContent).toContain("Chase Kelly");
  });
});
