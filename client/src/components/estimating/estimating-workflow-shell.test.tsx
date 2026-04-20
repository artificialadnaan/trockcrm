import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { EstimatingWorkflowShell } from "./estimating-workflow-shell";

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
              versionLabel: "v1",
              createdAt: "2026-04-20T10:00:00.000Z",
            },
            {
              id: "doc-2",
              filename: "addendum-a.pdf",
              documentType: "supporting_package",
              ocrStatus: "queued",
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
    expect(html).toContain("Documents");
    expect(html).toContain("addendum-a.pdf");
  });
});
