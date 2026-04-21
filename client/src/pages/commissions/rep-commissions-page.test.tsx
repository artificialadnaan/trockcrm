import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const mocks = vi.hoisted(() => ({
  useRepDashboardMock: vi.fn(),
}));

vi.mock("@/hooks/use-dashboard", () => ({ useRepDashboard: mocks.useRepDashboardMock }));

import { RepCommissionsPage } from "./rep-commissions-page";

describe("RepCommissionsPage", () => {
  beforeEach(() => {
    mocks.useRepDashboardMock.mockReturnValue({
      loading: false,
      error: null,
      data: {
        commissionSummary: {
          commissionRate: 0.075,
          overrideRate: 0.025,
          rollingFloor: 1000000,
          rollingPaidRevenue: 1250000,
          rollingCommissionableMargin: 200000,
          floorRemaining: 0,
          newCustomerRevenue: 150000,
          newCustomerShare: 0.12,
          newCustomerShareFloor: 0.1,
          meetsNewCustomerShare: true,
          estimatedPaymentCount: 6,
          excludedLowMarginRevenue: 5000,
          directEarnedCommission: 15000,
          overrideEarnedCommission: 2500,
          totalEarnedCommission: 17500,
          potentialRevenue: 2000000,
          potentialMargin: 300000,
          potentialCommission: 22500,
        },
      },
    });
  });

  it("renders commission summary metrics for reps", () => {
    const html = renderToStaticMarkup(<RepCommissionsPage />);

    expect(html).toContain("Commissions");
    expect(html).toContain("Earned");
    expect(html).toContain("$17,500.00");
    expect(html).toContain("7.5%");
    expect(html).toContain("Payment events counted");
  });
});
