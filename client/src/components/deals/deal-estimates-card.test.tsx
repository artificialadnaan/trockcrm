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
  "id" | "name" | "ddEstimate" | "ddEstimateOverridden" | "bidEstimate" | "awardedAmount" | "awardedAmountOverridden" | "changeOrderTotal"
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

  it("shows the 'manually set — not synced from Procore' indicator when dd_estimate is overridden", () => {
    const html = renderToStaticMarkup(
      <DealEstimatesCard deal={makeDeal({ ddEstimate: "125000", ddEstimateOverridden: true })} changeOrders={[]} />
    );

    expect(html).toContain("Manually set");
    expect(html).toContain("not synced from Procore");
  });

  it("does NOT show the DD indicator when dd_estimate is not overridden", () => {
    const html = renderToStaticMarkup(
      <DealEstimatesCard deal={makeDeal({ ddEstimate: "125000", ddEstimateOverridden: false })} changeOrders={[]} />
    );

    expect(html).not.toContain("Manually set");
  });
});

describe("DealEstimatesCard — awarded amount editor", () => {
  // The route this drives exists because the generic PATCH is ownership-gated: on a rep-owned deal the
  // owning rep fails the awarded RBAC and a leader fails ownership, so nobody could set it. The pencil
  // must therefore appear for a leader on ANY deal, and never for a rep.
  it("offers the editor when the viewer may edit the awarded amount", () => {
    const html = renderToStaticMarkup(
      <DealEstimatesCard deal={makeDeal({ awardedAmount: null })} changeOrders={[]} canEditAwarded />
    );

    expect(html).toContain('aria-label="Edit awarded amount"');
  });

  it("hides the editor when the viewer may not", () => {
    const html = renderToStaticMarkup(
      <DealEstimatesCard deal={makeDeal({ awardedAmount: null })} changeOrders={[]} />
    );

    expect(html).not.toContain('aria-label="Edit awarded amount"');
  });

  it("does not couple the awarded editor to change-order management", () => {
    // canManage (change orders, admin-only) and canEditAwarded (admin OR director) are separate roles.
    const html = renderToStaticMarkup(
      <DealEstimatesCard deal={makeDeal()} changeOrders={[]} canManage onChanged={() => {}} />
    );

    expect(html).toContain("Add Change Order");
    expect(html).not.toContain('aria-label="Edit awarded amount"');
  });

  it("still shows the blank value honestly when there is no awarded amount", () => {
    const html = renderToStaticMarkup(
      <DealEstimatesCard deal={makeDeal({ awardedAmount: null })} changeOrders={[]} canEditAwarded />
    );

    expect(html).toContain("--");
  });
});

describe("DealEstimatesCard — the awarded editor and change orders", () => {
  // setDealAwardedAmount 409s CHANGE_ORDER_FIELD_LOCKED on a CO child, so a pencil there is an action
  // that can never succeed. The parent decides this (it owns the capability), but the card must honour
  // a false canEditAwarded regardless of role.
  it("shows no editor when the parent withholds the capability on a change order", () => {
    const html = renderToStaticMarkup(
      <DealEstimatesCard
        deal={makeDeal({ isChangeOrder: true, awardedAmount: "-61828.57" } as any)}
        changeOrders={[]}
        canEditAwarded={false}
      />
    );

    expect(html).not.toContain('aria-label="Edit awarded amount"');
  });
});
