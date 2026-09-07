// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/use-reports", () => ({ useServiceRfpReport: () => ({
  data: {
    dateFrom: "2026-09-07", dateTo: "2026-09-13", timezone: "America/Chicago", total: 1, historicalCount: 0, missingEvidenceCount: 1,
    weeks: ["2026-09-07"], reps: [{ repId: "rep-1", repName: "Seller Name", total: 1, weekly: { "2026-09-07": 1 } }],
    deals: [{ dealId: "deal-1", dealName: "Leaking roof", repId: "rep-1", repName: "Seller Name", submittedAt: "2026-09-07T05:00:00Z", week: "2026-09-07", basis: "first_submission" }],
    missingEvidence: [{ dealId: "deal-2", dealName: "Not submitted", repId: null, repName: "Unattributed", submittedAt: null, week: null, basis: "missing" }],
  }, loading: false, error: null, refetch: vi.fn(),
}) }));
vi.mock("@/components/reports/report-filter-bar", () => ({
  useReportFilters: () => ({ query: {} }), ReportFilterBar: () => <div>Filters</div>,
}));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ user: { role: "admin" } }) }));

import { ServiceRfpPage } from "./service-rfp-page";

describe("service RFP contribution report", () => {
  it("renders weekly contributions with scoped evidence links and historical disclosure", () => {
    const html = renderToStaticMarkup(<MemoryRouter initialEntries={["/reports/sales/service-rfps?officeId=office-1"]}><ServiceRfpPage /></MemoryRouter>);
    expect(html).toContain("Service RFPs by Sales Rep");
    expect(html).toContain("Seller Name");
    expect(html).toContain("2026-09-07");
    expect(html).toContain("/deals/deal-1?officeId=office-1");
    expect(html).toContain("America/Chicago");
    expect(html).toContain("First submission; captured rep");
    expect(html).toContain("Without evidence (1)");
    expect(html).toContain("earlier submissions and original attribution may be unavailable");
  });
});
