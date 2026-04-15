import { describe, expect, it, vi } from "vitest";

const {
  htmlToPlainText,
  buildDocumentChunks,
} = await import("../../../src/modules/ai-copilot/document-service.js");
const { searchDealKnowledge } = await import("../../../src/modules/ai-copilot/retrieval-service.js");

describe("AI copilot retrieval service", () => {
  it("normalizes email html into plain text before chunking", () => {
    const text = htmlToPlainText("<div>Hello <strong>team</strong><br/>Need revised pricing.</div>");

    expect(text).toBe("Hello team Need revised pricing.");
  });

  it("builds deterministic chunks with source metadata", () => {
    const chunks = buildDocumentChunks({
      documentId: "doc-1",
      text: "Alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu",
      chunkSize: 5,
      metadata: {
        sourceType: "email_message",
        sourceId: "email-1",
        dealId: "deal-1",
        companyId: "company-1",
        sentAt: "2026-04-15T12:00:00.000Z",
      },
    });

    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toMatchObject({
      documentId: "doc-1",
      chunkIndex: 0,
      metadata: expect.objectContaining({
        sourceType: "email_message",
        sourceId: "email-1",
        dealId: "deal-1",
        companyId: "company-1",
      }),
    });
  });

  it("retrieves only the top-scoring chunks for a deal scope", async () => {
    const tenantDb = {
      execute: vi.fn().mockResolvedValue({
        rows: [
          {
            id: "chunk-1",
            document_id: "doc-1",
            chunk_index: 0,
            text: "Customer asked for revised pricing.",
            metadata_json: { sourceType: "email_message", sourceId: "email-1", dealId: "deal-1" },
            distance: 0.08,
          },
          {
            id: "chunk-2",
            document_id: "doc-2",
            chunk_index: 0,
            text: "Estimator noted missing photos.",
            metadata_json: { sourceType: "activity_note", sourceId: "activity-1", dealId: "deal-1" },
            distance: 0.18,
          },
        ],
      }),
    };

    const results = await searchDealKnowledge(tenantDb as any, {
      dealId: "deal-1",
      embedding: Array.from({ length: 1536 }, () => 0.01),
      limit: 2,
    });

    expect(results.map((row) => row.id)).toEqual(["chunk-1", "chunk-2"]);
    expect(tenantDb.execute).toHaveBeenCalledTimes(1);
  });
});
