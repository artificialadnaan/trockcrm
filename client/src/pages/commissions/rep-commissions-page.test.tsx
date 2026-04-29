import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";

const mocks = vi.hoisted(() => ({
  apiMock: vi.fn(),
}));

vi.mock("@/lib/api", () => ({ api: mocks.apiMock }));
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    user: { id: "rep-1", role: "rep", displayName: "Rep One" },
  }),
}));
vi.mock("recharts", () => ({
  ResponsiveContainer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  BarChart: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Bar: () => <div>Potential bar</div>,
  LineChart: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Line: () => <div>Earned line</div>,
  XAxis: () => null,
  YAxis: () => null,
  CartesianGrid: () => null,
  Tooltip: () => null,
  Legend: () => null,
}));

import { RepCommissionsPage } from "./rep-commissions-page";

describe("RepCommissionsPage", () => {
  beforeEach(() => {
    mocks.apiMock.mockReset();
    mocks.apiMock.mockImplementation((path: string) => {
      if (path.startsWith("/commissions/summary")) {
        return Promise.resolve({
          data: {
            earnedMtd: 7500,
            earnedYtd: 22500,
            potentialPipeline: 30000,
            paidYtd: 120000,
          },
        });
      }
      if (path.startsWith("/commissions/potential")) {
        return Promise.resolve({
          data: {
            formula: "Booked amount = source_value_amount * commission_rate.",
            stageGroups: [
              {
                stageId: "stage-1",
                stageName: "Contract Signed",
                stageSlug: "contract_signed",
                displayOrder: 40,
                dealCount: 2,
                totalDealValue: 300000,
                potentialCommission: 30000,
              },
            ],
          },
        });
      }
      return Promise.resolve({
        data: {
          months: [{ month: "2026-04", earnedCommission: 22500, dealCount: 2 }],
          deals: [
            {
              dealId: "deal-1",
              dealNumber: "D-1001",
              dealName: "North Tower Facade",
              repId: "rep-1",
              repName: "Rep One",
              stageName: "Contract Signed",
              stageSlug: "contract_signed",
              sourceValueAmount: 100000,
              appliedRate: 0.075,
              earnedCommission: 7500,
              contractSignedDate: "2026-04-20",
              paidYtd: 120000,
            },
            {
              dealId: "deal-2",
              dealNumber: "D-1002",
              dealName: "South Tower Facade",
              repId: "rep-1",
              repName: "Rep One",
              stageName: "Production",
              stageSlug: "sent_to_production",
              sourceValueAmount: 200000,
              appliedRate: 0.075,
              earnedCommission: 15000,
              contractSignedDate: "2026-04-21",
              paidYtd: 0,
            },
          ],
        },
      });
    });
  });

  it("renders the rebuilt commission dashboard structure", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <RepCommissionsPage />
      </MemoryRouter>
    );

    expect(html).toContain("Commissions");
    expect(html).toContain("Earned MTD");
    expect(html).toContain("Earned YTD");
    expect(html).toContain("Potential Pipeline");
    expect(html).toContain("Paid YTD");
    expect(html).toContain("Potential by Stage");
    expect(html).toContain("Earned per Month");
    expect(html).toContain("Contributing Deals");
    expect(html).toContain("Raw deal table sum");
  });
});
