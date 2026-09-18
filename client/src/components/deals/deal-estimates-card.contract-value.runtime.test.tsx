// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DealEstimatesCard } from "./deal-estimates-card";
import type { Deal } from "@/hooks/use-deals";

// Reported from production (Sep 10 2026): a deductive change order entered on The Onyx
// (DFW-1-15426-ab) turned the card's Current Contract Value into -$61,829 while the page header read
// $439,121. The deal is Bid-Board-owned and Won with awarded_amount never seeded, so the CCV base —
// which read awardedAmount alone — collapsed to $0 and the card rendered the deduction as the whole
// contract. These assert the RENDERED card, the surface the report was filed against.

type EstimatesDeal = Pick<
  Deal,
  | "id" | "name" | "ddEstimate" | "bidEstimate" | "awardedAmount" | "bidBoardTotalSales"
  | "changeOrderTotal" | "stageSlug" | "isChangeOrder"
>;

/** The Onyx as production holds it: value in bid_board_total_sales, awarded_amount never seeded. */
function makeOnyx(overrides: Partial<EstimatesDeal> = {}): Deal {
  return {
    id: "109139cd-a8aa-4e97-a3a1-c23c82aca6b0",
    name: "The Onyx",
    ddEstimate: "400000.00",
    bidEstimate: "425102.86",
    awardedAmount: null,
    bidBoardTotalSales: "439120.68",
    changeOrderTotal: "0.00",
    stageSlug: "won",
    ...overrides,
  } satisfies EstimatesDeal as Deal;
}

function textOf(html: string, testId: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const node = doc.querySelector(`[data-testid="${testId}"]`);
  if (!node) throw new Error(`no element with data-testid="${testId}"`);
  return node.textContent ?? "";
}

function classOf(html: string, testId: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  return doc.querySelector(`[data-testid="${testId}"]`)?.getAttribute("class") ?? "";
}

describe("DealEstimatesCard — Current Contract Value on a deal with no awarded amount", () => {
  it("prices the contract from the bid-board value, not from the change order alone", () => {
    const html = renderToStaticMarkup(
      <DealEstimatesCard deal={makeOnyx()} changeOrders={[]} changeOrderTotal="-61828.57" />
    );

    // 439,120.68 - 61,828.57 = 377,292.11
    expect(textOf(html, "current-contract-value")).toBe("$377,292");
  });

  it("does not paint a healthy contract red when a deduction is smaller than the contract", () => {
    const html = renderToStaticMarkup(
      <DealEstimatesCard deal={makeOnyx()} changeOrders={[]} changeOrderTotal="-61828.57" />
    );

    expect(classOf(html, "current-contract-value")).not.toContain("text-red-600");
  });

  it("still shows the change-order total as the deduction it is", () => {
    const html = renderToStaticMarkup(
      <DealEstimatesCard deal={makeOnyx()} changeOrders={[]} changeOrderTotal="-61828.57" />
    );

    expect(textOf(html, "change-order-total")).toBe("-$61,829");
  });

  it("leaves the Awarded Amount row blank — the fix prices the contract, it does not invent a value", () => {
    // The missing awarded_amount is a separate data gap (a backfill). The card must keep reporting it
    // honestly rather than paper over it with the fallback the contract value now uses.
    const html = renderToStaticMarkup(
      <DealEstimatesCard deal={makeOnyx()} changeOrders={[]} changeOrderTotal="-61828.57" />
    );

    const doc = new DOMParser().parseFromString(html, "text/html");
    const awardedRow = Array.from(doc.querySelectorAll("div")).find((el) =>
      el.firstElementChild?.textContent === "Awarded Amount"
    );
    expect(awardedRow?.lastElementChild?.textContent).toBe("--");
  });

  it("still goes red when the deductions genuinely exceed the contract", () => {
    const html = renderToStaticMarkup(
      <DealEstimatesCard deal={makeOnyx()} changeOrders={[]} changeOrderTotal="-500000" />
    );

    expect(classOf(html, "current-contract-value")).toContain("text-red-600");
  });

  it("prices a change-order child from its own deductive amount, not its inherited estimates", () => {
    const child = makeOnyx({
      id: "1cc722be-63ff-460c-b2cd-a8145640b2d7",
      name: "The Onyx — Change Order 1",
      awardedAmount: "-61828.57",
      isChangeOrder: true,
      changeOrderTotal: null,
    });

    const html = renderToStaticMarkup(<DealEstimatesCard deal={child} changeOrders={[]} />);

    expect(textOf(html, "current-contract-value")).toBe("-$61,829");
  });
});

describe("DealEstimatesCard — deals that hold no contract", () => {
  // The card renders on EVERY deal's overview, so the contract-value fallback must not reach a deal
  // that was never awarded. A Lost deal keeps its preserved bid for Loss Analysis; showing that bid as
  // a live "Current Contract Value" (in green) would read as money the company is owed.

  it("shows no contract value on a Lost deal carrying a preserved bid", () => {
    const lost = makeOnyx({ stageSlug: "lost", bidBoardTotalSales: null, changeOrderTotal: null });

    const html = renderToStaticMarkup(<DealEstimatesCard deal={lost} changeOrders={[]} />);

    expect(textOf(html, "current-contract-value")).toBe("$0");
  });

  it("shows no contract value on an open deal carrying estimates", () => {
    const open = makeOnyx({
      stageSlug: "opportunity",
      bidBoardTotalSales: null,
      changeOrderTotal: null,
    });

    const html = renderToStaticMarkup(<DealEstimatesCard deal={open} changeOrders={[]} />);

    expect(textOf(html, "current-contract-value")).toBe("$0");
  });
});
