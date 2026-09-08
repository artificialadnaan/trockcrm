// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ role: "admin", query: vi.fn() }));

vi.mock("@/hooks/use-reports", () => ({ useServiceRfpReport: (query: unknown) => { state.query(query); return ({
  data: {
    dateFrom: "2026-09-07", dateTo: "2026-09-13", timezone: "America/Chicago", total: 1, historicalCount: 0, missingEvidenceCount: 1,
    weeks: ["2026-09-07"], reps: [{ repId: "rep-1", repName: "Seller Name", total: 1, weekly: { "2026-09-07": 1 } }],
    deals: [{ dealId: "deal-1", dealName: "Leaking roof", repId: "rep-1", repName: "Seller Name", submittedAt: "2026-09-07T05:00:00Z", week: "2026-09-07", basis: "first_submission" }],
    missingEvidence: [{ dealId: "deal-2", dealName: "Not submitted", repId: null, repName: "Unattributed", submittedAt: null, week: null, basis: "missing" }],
  }, loading: false, error: null, refetch: vi.fn(),
}); } }));
vi.mock("@/components/reports/report-filter-bar", () => ({
  useReportFilters: () => ({ query: { ownerIds: ["other"], ownerNames: ["Other Rep"], ownerEmails: ["other@example.com"] } }),
  ReportFilterBar: ({ ownerPickerPurpose, showOwner }: { ownerPickerPurpose?: string; showOwner?: boolean }) => <div data-owner-picker={ownerPickerPurpose} data-show-owner={showOwner}>Filters</div>,
}));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ user: { role: state.role, id: "self-rep" } }) }));

import { ServiceRfpPage } from "./service-rfp-page";

describe("service RFP contribution report", () => {
  beforeEach(() => { state.role = "admin"; state.query.mockClear(); });
  it("hides the owner picker for reps and sends self attribution despite a colleague's bookmarked filter", () => {
    state.role = "rep";
    const html = renderToStaticMarkup(<MemoryRouter><ServiceRfpPage /></MemoryRouter>);
    expect(html).toContain('data-show-owner="false"');
    expect(html).toContain("This report is limited to your assigned submissions.");
    expect(state.query).toHaveBeenCalledWith(expect.objectContaining({ ownerIds: ["self-rep"], ownerNames: [], ownerEmails: [] }));
  });
  it("renders weekly contributions with scoped evidence links and historical disclosure", () => {
    const html = renderToStaticMarkup(<MemoryRouter initialEntries={["/reports/sales/service-rfps?officeId=office-1"]}><ServiceRfpPage /></MemoryRouter>);
    expect(html).toContain("Service RFPs by Sales Rep");
    expect(html).toContain('data-owner-picker="service-rfp-report"');
    expect(html).toContain("Seller Name");
    expect(html).toContain("2026-09-07");
    expect(html).toContain("/deals/deal-1?officeId=office-1");
    expect(html).toContain("America/Chicago");
    expect(html).toContain("First submission; captured rep");
    expect(html).toContain("Without evidence (1)");
    expect(html).toContain("earlier submissions and original attribution may be unavailable");
  });
});
