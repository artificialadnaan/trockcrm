import { describe, expect, it, vi } from "vitest";
import {
  classifyEstimateDocument,
  createEstimateSourceDocument,
  reprocessEstimateSourceDocument,
} from "../../../src/modules/estimating/document-service.js";

describe("createEstimateSourceDocument", () => {
  it("creates an uploaded estimating document and queues OCR", async () => {
    const enqueueEstimateDocumentOcr = vi.fn().mockResolvedValue(undefined);
    const returningDocument = {
      id: "doc-1",
      dealId: "deal-1",
      filename: "plans.pdf",
      parseStatus: "queued",
      activeParseRunId: null,
      parseProfile: null,
      parseProvider: null,
      parseErrorSummary: null,
    };

    const returning = vi.fn().mockResolvedValue([returningDocument]);
    const values = vi.fn(() => ({
      returning,
    }));

    const tenantDb = {
      insert: vi.fn(() => ({
        values,
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

    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        parseStatus: "queued",
        activeParseRunId: null,
      })
    );
    expect(result.filename).toBe("plans.pdf");
    expect(result.parseStatus).toBe("queued");
    expect(result.activeParseRunId).toBeNull();
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

describe("reprocessEstimateSourceDocument", () => {
  it("requeues the existing document in place and preserves the document id", async () => {
    const enqueueEstimateDocumentOcr = vi.fn().mockResolvedValue(undefined);
    const updatedDocument = {
      id: "doc-1",
      dealId: "deal-1",
      filename: "plans.pdf",
      parseStatus: "queued",
      activeParseRunId: null,
      parseProfile: null,
      parseProvider: null,
      parseErrorSummary: null,
      ocrStatus: "queued",
      parsedAt: null,
    };

    const updateReturning = vi.fn().mockResolvedValue([updatedDocument]);
    const updateWhere = vi.fn(() => ({
      returning: updateReturning,
    }));
    const updateSet = vi.fn(() => ({
      where: updateWhere,
    }));

    const tenantDb = {
      update: vi.fn(() => ({
        set: updateSet,
      })),
    } as any;

    const result = await reprocessEstimateSourceDocument({
      tenantDb,
      enqueueEstimateDocumentOcr,
      input: {
        dealId: "deal-1",
        documentId: "doc-1",
        userId: "user-1",
        officeId: "office-1",
      },
    });

    expect(tenantDb.update).toHaveBeenCalled();
    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        parseStatus: "queued",
        activeParseRunId: null,
        parseProfile: null,
        parseProvider: null,
        parseErrorSummary: null,
        ocrStatus: "queued",
        parsedAt: null,
      })
    );
    expect(result).toEqual(updatedDocument);
    expect(enqueueEstimateDocumentOcr).toHaveBeenCalledWith({
      documentId: "doc-1",
      dealId: "deal-1",
      officeId: "office-1",
    });
  });

  it("returns null when the document does not exist for the deal", async () => {
    const enqueueEstimateDocumentOcr = vi.fn().mockResolvedValue(undefined);
    const updateReturning = vi.fn().mockResolvedValue([]);
    const updateWhere = vi.fn(() => ({
      returning: updateReturning,
    }));
    const updateSet = vi.fn(() => ({
      where: updateWhere,
    }));

    const tenantDb = {
      update: vi.fn(() => ({
        set: updateSet,
      })),
    } as any;

    const result = await reprocessEstimateSourceDocument({
      tenantDb,
      enqueueEstimateDocumentOcr,
      input: {
        dealId: "deal-1",
        documentId: "missing-doc",
        userId: "user-1",
        officeId: "office-1",
      },
    });

    expect(result).toBeNull();
    expect(enqueueEstimateDocumentOcr).not.toHaveBeenCalled();
  });
});
