import { describe, expect, it, vi, afterEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { EstimatingWorkflowShell } from "./estimating-workflow-shell";

const mocks = vi.hoisted(() => ({
  activePanel: null as string | null,
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();

  return {
    ...actual,
    useState: <T,>(initialState: T) => {
      if (mocks.activePanel !== null && initialState === "documents") {
        return [mocks.activePanel as T, vi.fn()] as const;
      }

      return actual.useState(initialState);
    },
  };
});

vi.mock("./estimate-extraction-review-table", () => ({
  EstimateExtractionReviewTable: ({ onRefresh }: { onRefresh?: unknown }) => (
    <div>Extraction refresh {typeof onRefresh}</div>
  ),
}));

vi.mock("./estimate-catalog-match-table", () => ({
  EstimateCatalogMatchTable: ({ onRefresh }: { onRefresh?: unknown }) => (
    <div>Match refresh {typeof onRefresh}</div>
  ),
}));

vi.mock("./estimate-pricing-review-table", () => ({
  EstimatePricingReviewTable: ({ onRefresh }: { onRefresh?: unknown }) => (
    <div>Pricing refresh {typeof onRefresh}</div>
  ),
}));

afterEach(() => {
  mocks.activePanel = null;
  vi.restoreAllMocks();
});

describe("EstimatingWorkflowShell", () => {
  it("renders the split-pane workbench structure and summary strip content", () => {
    const html = renderToStaticMarkup(
      <EstimatingWorkflowShell
        dealId="deal-1"
        workflow={{
          documents: [
            {
              id: "doc-1",
              filename: "project-spec.pdf",
              documentType: "spec",
              ocrStatus: "completed",
              parseStatus: "completed",
              parseProvider: "default",
              parseProfile: "measurement-heavy",
              parseMeasurementsEnabled: true,
              versionLabel: "v1",
              createdAt: "2026-04-20T10:00:00.000Z",
            },
            {
              id: "doc-2",
              filename: "addendum-a.pdf",
              documentType: "supporting_package",
              ocrStatus: "queued",
              parseStatus: "queued",
              parseProvider: null,
              parseProfile: null,
              parseMeasurementsEnabled: false,
              versionLabel: null,
              createdAt: "2026-04-20T11:00:00.000Z",
            },
          ],
          extractionRows: [
            { id: "ext-1", status: "pending", sourceDocumentId: "doc-1" },
            { id: "ext-2", status: "approved", sourceDocumentId: "doc-1" },
          ],
          matchRows: [{ id: "match-1", status: "suggested" }],
          pricingRows: [
            {
              id: "price-1",
              status: "approved",
              createdByRunId: "run-1",
            },
          ],
          reviewEvents: [
            {
              id: "event-1",
              eventType: "document_reprocessed",
              entityType: "estimate_source_document",
              createdAt: "2026-04-20T12:00:00.000Z",
              payloadJson: { filename: "addendum-a.pdf" },
            },
          ],
          summary: {
            documents: { total: 2, queued: 1, failed: 0 },
            extractions: {
              total: 2,
              pending: 1,
              approved: 1,
              rejected: 0,
              unmatched: 0,
            },
            matches: { total: 1, suggested: 1, selected: 0, rejected: 0 },
            pricing: {
              total: 1,
              pending: 0,
              approved: 1,
              overridden: 0,
              rejected: 0,
              readyToPromote: 1,
            },
          },
          promotionReadiness: {
            canPromote: true,
            generationRunIds: ["run-1"],
          },
        }}
        onRefresh={async () => {}}
        copilotEnabled
      />
    );

    expect(html).toContain("Estimator Workbench");
    expect(html).toContain("Review-ready");
    expect(html).toContain("2 source docs");
    expect(html).toContain("1 OCR queued");
    expect(html).toContain("Documents");
    expect(html).toContain("Review Log");
    expect(html).toContain("Current panel");
    expect(html).toContain("Queued for OCR");
    expect(html).toContain("Parsed");
    expect(html).toContain("Measurements enabled");
    expect(html).toContain("Re-run Parsing");
    expect(html).toContain("Documents");
    expect(html).toContain("addendum-a.pdf");
  });

  it("threads the scoped refresh callback into the extraction panel", () => {
    mocks.activePanel = "extraction";

    const html = renderToStaticMarkup(
      <EstimatingWorkflowShell
        dealId="deal-1"
        workflow={{
          documents: [],
          extractionRows: [{ id: "ext-1", status: "pending" }],
          matchRows: [],
          pricingRows: [],
          reviewEvents: [],
          summary: {
            documents: { total: 0, queued: 0, failed: 0 },
            extractions: { total: 1, pending: 1, approved: 0, rejected: 0, unmatched: 0 },
            matches: { total: 0, suggested: 0, selected: 0, rejected: 0 },
            pricing: {
              total: 0,
              pending: 0,
              approved: 0,
              overridden: 0,
              rejected: 0,
              readyToPromote: 0,
            },
          },
          promotionReadiness: { canPromote: false, generationRunIds: [] },
        }}
        onRefresh={async () => {}}
      />
    );

    expect(html).toContain("Extraction refresh function");
  });

  it("threads the scoped refresh callback into the match panel", () => {
    mocks.activePanel = "match";

    const html = renderToStaticMarkup(
      <EstimatingWorkflowShell
        dealId="deal-1"
        workflow={{
          documents: [],
          extractionRows: [],
          matchRows: [{ id: "match-1", status: "suggested" }],
          pricingRows: [],
          reviewEvents: [],
          summary: {
            documents: { total: 0, queued: 0, failed: 0 },
            extractions: { total: 0, pending: 0, approved: 0, rejected: 0, unmatched: 0 },
            matches: { total: 1, suggested: 1, selected: 0, rejected: 0 },
            pricing: {
              total: 0,
              pending: 0,
              approved: 0,
              overridden: 0,
              rejected: 0,
              readyToPromote: 0,
            },
          },
          promotionReadiness: { canPromote: false, generationRunIds: [] },
        }}
        onRefresh={async () => {}}
      />
    );

    expect(html).toContain("Match refresh function");
  });

  it("threads the scoped refresh callback into the pricing panel", () => {
    mocks.activePanel = "pricing";

    const html = renderToStaticMarkup(
      <EstimatingWorkflowShell
        dealId="deal-1"
        workflow={{
          documents: [],
          extractionRows: [],
          matchRows: [],
          pricingRows: [{ id: "price-1", status: "pending" }],
          reviewEvents: [],
          summary: {
            documents: { total: 0, queued: 0, failed: 0 },
            extractions: { total: 0, pending: 0, approved: 0, rejected: 0, unmatched: 0 },
            matches: { total: 0, suggested: 0, selected: 0, rejected: 0 },
            pricing: {
              total: 1,
              pending: 1,
              approved: 0,
              overridden: 0,
              rejected: 0,
              readyToPromote: 0,
            },
          },
          promotionReadiness: { canPromote: false, generationRunIds: [] },
        }}
        onRefresh={async () => {}}
      />
    );

    expect(html).toContain("Pricing refresh function");
  });
});
