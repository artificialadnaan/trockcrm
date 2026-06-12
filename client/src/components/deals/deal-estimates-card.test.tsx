// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DealEstimatesCard } from "./deal-estimates-card";
import type { Deal, DealChangeOrder } from "@/hooks/use-deals";

// DealEstimatesCard reads only these deal fields (via currentContractValue / combinedChangeOrderTotal).
// The Pick keeps the fixture type-checked against the real Deal shape; the cast is the narrow boundary
// for the component's `deal: Deal` prop.
type EstimatesDeal = Pick<
  Deal,
  "id" | "name" | "ddEstimate" | "bidEstimate" | "awardedAmount" | "awardedAmountOverridden" | "changeOrderTotal"
>;

function makeDeal(overrides: Partial<EstimatesDeal> = {}): Deal {
  return {
    id: "parent-1",
    name: "Palm Villas",
    ddEstimate: null,
    bidEstimate: null,
    awardedAmount: "500000",
    changeOrderTotal: null,
    ...overrides,
  } satisfies EstimatesDeal as Deal;
}

function makeChangeOrder(overrides: Partial<DealChangeOrder> = {}): DealChangeOrder {
  return {
    id: "co-1",
    dealId: "parent-1",
    signedDate: "2026-05-01",
    amount: "12500",
    description: "Added perimeter gate",
    createdBy: null,
    updatedBy: null,
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("DealEstimatesCard — a parent's change-order children", () => {
  it("lists each change-order child with its amount, signed date, and description", () => {
    const changeOrders = [
      makeChangeOrder(),
      makeChangeOrder({ id: "co-2", signedDate: "2026-05-10", amount: "3000", description: null }),
    ];

    const html = renderToStaticMarkup(
      <DealEstimatesCard deal={makeDeal()} changeOrders={changeOrders} changeOrderTotal="15500" />
    );

    expect((html.match(/data-testid="change-order-row"/g) ?? []).length).toBe(2);
    expect(html).toContain("Added perimeter gate"); // first child's description
    expect(html).toContain("2026-05-01"); // first child's signed date
    expect(html).toContain("2026-05-10"); // second child's distinct signed date
  });

  it("renders no change-order rows when the parent has no change orders", () => {
    const html = renderToStaticMarkup(<DealEstimatesCard deal={makeDeal()} changeOrders={[]} />);

    expect(html).not.toContain('data-testid="change-order-row"');
  });
});

describe("DealEstimatesCard — manual-override indicator", () => {
  it("shows the 'manually set — not synced from Procore' indicator when awarded_amount is overridden", () => {
    const html = renderToStaticMarkup(
      <DealEstimatesCard deal={makeDeal({ awardedAmountOverridden: true })} changeOrders={[]} />
    );

    expect(html).toContain("Manually set");
    expect(html).toContain("not synced from Procore");
  });

  it("does NOT show the indicator when awarded_amount is not overridden", () => {
    const htmlFalse = renderToStaticMarkup(
      <DealEstimatesCard deal={makeDeal({ awardedAmountOverridden: false })} changeOrders={[]} />
    );
    const htmlAbsent = renderToStaticMarkup(
      <DealEstimatesCard deal={makeDeal()} changeOrders={[]} />
    );

    expect(htmlFalse).not.toContain("Manually set");
    expect(htmlAbsent).not.toContain("Manually set");
  });
});
