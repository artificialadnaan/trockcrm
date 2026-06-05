// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DealEstimatesCard } from "./deal-estimates-card";
import type { Deal, DealChangeOrder } from "@/hooks/use-deals";

function makeDeal(overrides: Partial<Deal> = {}): Deal {
  return {
    id: "parent-1",
    name: "Palm Villas",
    ddEstimate: null,
    bidEstimate: null,
    awardedAmount: "500000",
    changeOrderTotal: null,
    ...overrides,
  } as Deal;
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
    expect(html).toContain("Added perimeter gate");
    expect(html).toContain("2026-05-01");
  });

  it("renders no change-order rows when the parent has no change orders", () => {
    const html = renderToStaticMarkup(<DealEstimatesCard deal={makeDeal()} changeOrders={[]} />);

    expect(html).not.toContain('data-testid="change-order-row"');
  });
});
