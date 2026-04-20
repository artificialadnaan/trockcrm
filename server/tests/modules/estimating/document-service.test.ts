import { describe, expect, it, vi } from "vitest";
import { classifyEstimateDocument, createEstimateSourceDocument } from "../../../src/modules/estimating/document-service.js";

describe("createEstimateSourceDocument", () => {
  it("creates an uploaded estimating document and queues OCR", async () => {
    const enqueueEstimateDocumentOcr = vi.fn().mockResolvedValue(undefined);
    const returningDocument = {
      id: "doc-1",
      dealId: "deal-1",
      filename: "plans.pdf",
    };

    const tenantDb = {
      insert: vi.fn(() => ({
        values: vi.fn(() => ({
          returning: vi.fn().mockResolvedValue([returningDocument]),
        })),
      })),
    } as any;

    const result = await createEstimateSourceDocument({
      tenantDb,
      enqueueEstimateDocumentOcr,
      input: {
        dealId: "deal-1",
        fileId: "file-1",
        filename: "plans.pdf",
        mimeType: "application/pdf",
        userId: "user-1",
        officeId: "office-1",
      },
    });

    expect(result.filename).toBe("plans.pdf");
    expect(enqueueEstimateDocumentOcr).toHaveBeenCalledWith({
      documentId: "doc-1",
      dealId: "deal-1",
      officeId: "office-1",
    });
  });

  it("classifies spec files separately from plan files", () => {
    expect(classifyEstimateDocument({ filename: "project-spec-book.pdf", mimeType: "application/pdf" })).toBe("spec");
    expect(classifyEstimateDocument({ filename: "roof-plan-a101.pdf", mimeType: "application/pdf" })).toBe("plan");
    expect(classifyEstimateDocument({ filename: "bid-package.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" })).toBe("supporting_package");
  });
});
