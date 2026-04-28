/**
 * @vitest-environment jsdom
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildEstimatePdfHtml,
  calculateEstimateTotals,
  DealEstimatesTab,
} from "./deal-estimates-tab";

const mocks = vi.hoisted(() => ({
  apiMock: vi.fn(),
  toastErrorMock: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  api: mocks.apiMock,
}));

vi.mock("sonner", () => ({
  toast: {
    error: mocks.toastErrorMock,
    success: vi.fn(),
  },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function makeSection() {
  return {
    id: "section-1",
    dealId: "deal-1",
    name: "Roofing",
    subtotal: "200.00",
    displayOrder: 0,
    items: [
      {
        id: "item-1",
        sectionId: "section-1",
        description: "Metal panels",
        quantity: "2",
        unit: "ea",
        unitPrice: "100.00",
        totalPrice: "200.00",
        displayOrder: 0,
      },
    ],
  };
}

describe("DealEstimatesTab", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    mocks.apiMock.mockReset();
    mocks.toastErrorMock.mockReset();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it("mounts the canonical estimate editor empty state without loading the legacy workbench", async () => {
    mocks.apiMock.mockResolvedValue({ sections: [] });

    await act(async () => {
      root.render(<DealEstimatesTab dealId="deal-1" />);
    });

    expect(container.textContent).toContain("No estimate line items yet");
    expect(container.textContent).toContain("Tax rate %");
    expect(container.textContent).toContain("Export PDF");
    expect(mocks.apiMock).toHaveBeenCalledWith("/deals/deal-1/estimates");
    expect(mocks.apiMock).not.toHaveBeenCalledWith("/deals/deal-1/estimating");
  });

  it("calculates tax totals and includes them in the printable export", () => {
    const section = makeSection();
    const totals = calculateEstimateTotals([section], "8.25");
    const html = buildEstimatePdfHtml({
      dealId: "deal-1",
      sections: [section],
      taxRate: "8.25",
    });

    expect(totals).toEqual({
      subtotal: 200,
      taxRatePercent: 8.25,
      taxAmount: 16.5,
      total: 216.5,
    });
    expect(html).toContain("Metal panels");
    expect(html).toContain("Tax (8.25%): $16.50");
    expect(html).toContain("Grand Total: $216.50");
  });
});
