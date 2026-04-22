// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { LeadForm } from "./lead-form";

const mocks = vi.hoisted(() => ({
  navigateMock: vi.fn(),
  convertLeadMock: vi.fn(),
  convertLeadToOpportunityMock: vi.fn(),
}));

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return {
    ...actual,
    useNavigate: () => mocks.navigateMock,
  };
});

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("@/hooks/use-leads", () => ({
  convertLead: mocks.convertLeadMock,
  convertLeadToOpportunity: mocks.convertLeadToOpportunityMock,
}));

vi.mock("@/components/ui/card", () => ({
  Card: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CardContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CardHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CardTitle: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/leads/lead-stage-badge", () => ({
  LeadStageBadge: () => <div>Lead Stage</div>,
}));

describe("LeadForm", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.innerHTML = "";
    document.body.appendChild(container);
    // React 18 expects this flag in jsdom-based tests that call act().
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    root = createRoot(container);
    mocks.navigateMock.mockReset();
    mocks.convertLeadMock.mockReset();
    mocks.convertLeadToOpportunityMock.mockReset();
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it("uses the standard opportunity conversion path and routes to the enrichment landing", async () => {
    mocks.convertLeadToOpportunityMock.mockResolvedValue({ deal: { id: "deal-9" } });

    act(() => {
      root.render(
        <MemoryRouter>
          <LeadForm
            lead={{
              id: "lead-1",
              name: "Alpha Roofing Follow-Up",
              convertedDealId: null,
              convertedDealNumber: null,
              companyId: "company-1",
              companyName: "Alpha Roofing",
              stageId: "stage-qualified",
              propertyId: "property-1",
              propertyName: "Dallas HQ",
              propertyAddress: "123 Main St",
              propertyCity: "Dallas",
              propertyState: "TX",
              propertyZip: "75201",
              source: "trade show",
              description: "Initial pre-RFP lead.",
              stageEnteredAt: "2026-04-10T10:00:00.000Z",
            }}
          />
        </MemoryRouter>
      );
    });

    const convertButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Convert to Deal")
    );
    expect(convertButton).toBeTruthy();

    await act(async () => {
      convertButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(mocks.convertLeadMock).not.toHaveBeenCalled();
    expect(mocks.convertLeadToOpportunityMock).toHaveBeenCalledWith("lead-1");
    expect(mocks.navigateMock).toHaveBeenCalledWith("/deals/deal-9?enrichment=1");
  });

  it("keeps the safe new-deal fallback for lead summaries that are not opportunity conversions", async () => {
    act(() => {
      root.render(
        <MemoryRouter>
          <LeadForm
            lead={{
              id: "lead-2",
              name: "Beta Follow-Up",
              convertedDealId: null,
              convertedDealNumber: null,
              companyId: "company-2",
              companyName: "Beta",
              stageId: "stage-dd",
              propertyId: null,
              propertyName: null,
              propertyAddress: null,
              propertyCity: null,
              propertyState: null,
              propertyZip: null,
              source: null,
              description: null,
              stageEnteredAt: "2026-04-10T10:00:00.000Z",
            }}
            primaryActionMode="newDeal"
          />
        </MemoryRouter>
      );
    });

    const convertButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Convert to Deal")
    );
    expect(convertButton).toBeTruthy();

    await act(async () => {
      convertButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(mocks.convertLeadToOpportunityMock).not.toHaveBeenCalled();
    expect(mocks.navigateMock).toHaveBeenCalledWith("/deals/new");
  });
});
