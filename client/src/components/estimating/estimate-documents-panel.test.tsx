import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  EstimateDocumentsPanel,
  runEstimateDocumentRerunAction,
  runEstimateDocumentUploadAction,
} from "./estimate-documents-panel";

const mocks = vi.hoisted(() => ({
  apiMock: vi.fn(),
  uploadFileMock: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  api: mocks.apiMock,
}));

vi.mock("@/hooks/use-files", () => ({
  uploadFile: mocks.uploadFileMock,
}));

describe("EstimateDocumentsPanel", () => {
  beforeEach(() => {
    mocks.apiMock.mockReset();
    mocks.uploadFileMock.mockReset();
  });

  it("renders parse status, measurement cues, and rerun controls", () => {
    const html = renderToStaticMarkup(
      <EstimateDocumentsPanel
        dealId="deal-1"
        documents={[
          {
            id: "doc-1",
            filename: "roof-plan-a101.pdf",
            documentType: "plan",
            ocrStatus: "completed",
            parseStatus: "completed",
            parseProvider: "default",
            parseProfile: "measurement-heavy",
            parseMeasurementsEnabled: true,
            parseErrorSummary: null,
            versionLabel: "v3",
            createdAt: "2026-04-20T11:00:00.000Z",
          },
        ]}
        onRefresh={vi.fn().mockResolvedValue(undefined)}
      />
    );

    expect(html).toContain("Documents");
    expect(html).toContain("Upload Plans Here");
    expect(html).toContain("Re-run Parsing");
    expect(html).toContain("Parsed");
    expect(html).toContain("OCR Complete");
    expect(html).toContain("Provider default");
    expect(html).toContain("Profile measurement-heavy");
    expect(html).toContain("Measurements enabled");
    expect(html).toContain("roof-plan-a101.pdf");
  });

  it("submits rerun parsing options through the helper and refreshes", async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    mocks.apiMock.mockResolvedValue({});

    await runEstimateDocumentRerunAction({
      dealId: "deal-1",
      documentId: "doc-1",
      options: {
        parseProvider: "default",
        parseProfile: "measurement-heavy",
        parseMeasurementsEnabled: true,
      },
      refresh,
    });

    expect(mocks.apiMock).toHaveBeenCalledWith(
      "/deals/deal-1/estimating/documents/doc-1/reprocess",
      {
        method: "POST",
        json: {
          parseProvider: "default",
          parseProfile: "measurement-heavy",
          parseMeasurementsEnabled: true,
        },
      }
    );
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("normalizes blank rerun provider and profile values before sending", async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    mocks.apiMock.mockResolvedValue({});

    await runEstimateDocumentRerunAction({
      dealId: "deal-1",
      documentId: "doc-1",
      options: {
        parseProvider: "   ",
        parseProfile: "\t",
        parseMeasurementsEnabled: false,
      },
      refresh,
    });

    expect(mocks.apiMock).toHaveBeenCalledWith(
      "/deals/deal-1/estimating/documents/doc-1/reprocess",
      {
        method: "POST",
        json: {
          parseProvider: "default",
          parseProfile: "balanced",
          parseMeasurementsEnabled: false,
        },
      }
    );
  });

  it("uploads files into estimating documents and refreshes once complete", async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    const file = new File(["plan"], "site-plan.pdf", { type: "application/pdf" });

    mocks.uploadFileMock.mockResolvedValue({
      id: "file-1",
    });
    mocks.apiMock.mockResolvedValue({});

    await runEstimateDocumentUploadAction({
      dealId: "deal-1",
      files: [file],
      parseMeasurementsEnabled: true,
      refresh,
    });

    expect(mocks.uploadFileMock).toHaveBeenCalledWith(
      expect.objectContaining({
        file,
        category: "estimate",
        dealId: "deal-1",
      })
    );
    expect(mocks.apiMock).toHaveBeenCalledWith("/deals/deal-1/estimating/documents", {
      method: "POST",
      json: {
        fileId: "file-1",
        parseMeasurementsEnabled: true,
      },
    });
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
