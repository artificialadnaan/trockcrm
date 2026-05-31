// @vitest-environment jsdom

import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import type { ReactNode } from "react";
import { ContractsSignedPage, formatSignedDate } from "./contracts-signed-page";

const mocks = vi.hoisted(() => ({
  useAuthMock: vi.fn(),
  useDealsMock: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  useAuth: mocks.useAuthMock,
}));

vi.mock("@/hooks/use-deals", () => ({
  useDeals: mocks.useDealsMock,
}));

vi.mock("@/components/layout/page-header", () => ({
  PageHeader: ({ title, description }: { title: string; description?: string }) => (
    <header>
      <h1>{title}</h1>
      <p>{description}</p>
    </header>
  ),
}));

vi.mock("@/components/ui/card", () => ({
  Card: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CardContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children }: { children: ReactNode }) => <button>{children}</button>,
}));

function renderPage(path = "/dashboard/contracts-signed?period=ytd") {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[path]}>
      <ContractsSignedPage />
    </MemoryRouter>
  );
}

describe("formatSignedDate", () => {
  beforeEach(() => {
    mocks.useAuthMock.mockReturnValue({
      user: { id: "rep-1" },
      loading: false,
    });
    mocks.useDealsMock.mockReturnValue({
      deals: [],
      loading: false,
      error: null,
    });
  });

  it("formats date-only contract signed dates without timezone drift", () => {
    expect(formatSignedDate("2026-05-01")).toBe("May 1, 2026");
  });

  it("formats ISO timestamps with milliseconds", () => {
    expect(formatSignedDate("2026-05-01T00:00:00.000Z")).toBe("May 1, 2026");
  });

  it("formats ISO timestamps without milliseconds", () => {
    expect(formatSignedDate("2026-05-01T18:30:00Z")).toBe("May 1, 2026");
  });

  it("preserves the existing empty value placeholder", () => {
    expect(formatSignedDate(null)).toBe("—");
  });

  it("matches the rep dashboard card raw awarded-amount semantics for signed contracts", () => {
    mocks.useDealsMock.mockReturnValue({
      deals: [
        {
          id: "deal-1",
          name: "No Award Yet",
          dealNumber: "TR-1",
          propertyAddress: null,
          propertyCity: "Dallas",
          propertyState: "TX",
          contractSignedDate: "2026-05-01",
          contractSignedAt: null,
          awardedAmount: null,
          bidEstimate: "250000",
          ddEstimate: "200000",
          onHold: false,
        },
        {
          id: "deal-2",
          name: "Awarded Deal",
          dealNumber: "TR-2",
          propertyAddress: null,
          propertyCity: "Dallas",
          propertyState: "TX",
          contractSignedDate: "2026-05-02",
          contractSignedAt: null,
          awardedAmount: "125000",
          bidEstimate: "300000",
          ddEstimate: "280000",
          onHold: false,
        },
        {
          id: "deal-3",
          name: "Held Deal",
          dealNumber: "TR-3",
          propertyAddress: null,
          propertyCity: "Dallas",
          propertyState: "TX",
          contractSignedDate: "2026-05-03",
          contractSignedAt: null,
          awardedAmount: "900000",
          bidEstimate: "900000",
          ddEstimate: "900000",
          onHold: true,
        },
      ],
      loading: false,
      error: null,
    });

    const html = renderPage();

    expect(mocks.useDealsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        isActive: "all",
      })
    );
    // Now uses the SAFE deal-utils formatCurrency (full $, NaN-guarded) instead of the unsafe compact one.
    expect(html).toContain("$1,025,000"); // total awarded (raw awarded sums, incl. the held deal)
    expect(html).toContain("$125,000");
    expect(html).toContain("$900,000");
    expect(html).toContain("No Award Yet");
    expect(html).toContain("Held Deal");
    expect(html).not.toContain("$375,000"); // never sums bid estimates
  });
});

describe("ContractsSignedPage (GREY UI-accuracy fixes)", () => {
  beforeEach(() => {
    mocks.useAuthMock.mockReturnValue({ user: { id: "rep-1" }, loading: false });
    mocks.useDealsMock.mockReturnValue({ deals: [], loading: false, error: null });
  });

  it("renders '--' (not $NaN) when an awarded amount is non-numeric — the safe formatter guards it", () => {
    mocks.useDealsMock.mockReturnValue({
      deals: [
        {
          id: "deal-x",
          name: "Garbled Award",
          dealNumber: "TR-9",
          propertyCity: "Dallas",
          propertyState: "TX",
          contractSignedDate: "2026-05-01",
          contractSignedAt: null,
          awardedAmount: "not-a-number",
          stageName: "Won",
          onHold: false,
        },
      ],
      loading: false,
      error: null,
    });
    const html = renderPage();
    expect(html).not.toContain("NaN");
    expect(html).toContain("--");
  });

  it("runs ALL hooks before the invalid-period redirect (no rules-of-hooks 'rendered fewer hooks' crash) (GREY)", () => {
    mocks.useDealsMock.mockClear();
    // An invalid ?period must NOT early-return before useMemo/useDeals — otherwise an in-place period
    // change to a bad value changes the hook count between renders and React crashes the page.
    const html = renderPage("/dashboard/contracts-signed?period=bogus");
    expect(mocks.useDealsMock).toHaveBeenCalled(); // hooks ran despite the redirect
    expect(html).not.toContain("Contracts Signed"); // it still redirects (renders <Navigate/>, no header)
  });

  it("labels each row with the deal's actual stage, not a hardcoded 'Open deal' (the list is isActive:all)", () => {
    mocks.useDealsMock.mockReturnValue({
      deals: [
        {
          id: "deal-y",
          name: "Closed Won Deal",
          dealNumber: "TR-10",
          propertyCity: "Dallas",
          propertyState: "TX",
          contractSignedDate: "2026-05-01",
          contractSignedAt: null,
          awardedAmount: "50000",
          stageName: "Won",
          onHold: false,
        },
      ],
      loading: false,
      error: null,
    });
    const html = renderPage();
    expect(html).toContain("Won");
    expect(html).not.toContain("Open deal");
  });
});
