import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import {
  EstimateExtractionReviewTable,
  runEstimateExtractionReviewAction,
} from "./estimate-extraction-review-table";

const mocks = vi.hoisted(() => ({
  apiMock: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  api: mocks.apiMock,
}));

function renderTable(rows: any[], onRefresh = vi.fn().mockResolvedValue(undefined)) {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={["/deals/deal-1/estimates"]}>
      <Routes>
        <Route
          path="/deals/:dealId/estimates"
          element={<EstimateExtractionReviewTable rows={rows} onRefresh={onRefresh} />}
        />
      </Routes>
    </MemoryRouter>
  );
}

describe("EstimateExtractionReviewTable", () => {
  beforeEach(() => {
    mocks.apiMock.mockReset();
  });

  it("renders dense extraction review rows with estimator actions", () => {
    const html = renderTable([
      {
        id: "ext-1",
        status: "pending",
        extractionType: "material",
        normalizedLabel: "TPO membrane",
        rawLabel: "60mil white TPO",
        quantity: "1200",
        unit: "sqft",
        divisionHint: "Roofing",
        confidence: "0.92",
        sourceDocumentId: "doc-1",
        pageId: "page-4",
        evidenceText: "Install 1,200 SF of white TPO membrane",
      },
    ]);

    expect(html).toContain("Extraction");
    expect(html).toContain("TPO membrane");
    expect(html).toContain("60mil white TPO");
    expect(html).toContain("1200 sqft");
    expect(html).toContain("Approve");
    expect(html).toContain("Reject");
    expect(html).toContain("Selected");
  });

  it("posts approve and reject actions then refreshes", async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    mocks.apiMock.mockResolvedValue({});

    await runEstimateExtractionReviewAction({
      action: "approve",
      dealId: "deal-1",
      extractionId: "ext-1",
      refresh,
    });

    await runEstimateExtractionReviewAction({
      action: "reject",
      dealId: "deal-1",
      extractionId: "ext-1",
      refresh,
    });

    expect(mocks.apiMock).toHaveBeenNthCalledWith(
      1,
      "/deals/deal-1/estimating/extractions/ext-1/approve",
      { method: "POST" }
    );
    expect(mocks.apiMock).toHaveBeenNthCalledWith(
      2,
      "/deals/deal-1/estimating/extractions/ext-1/reject",
      { method: "POST" }
    );
    expect(refresh).toHaveBeenCalledTimes(2);
  });
});
