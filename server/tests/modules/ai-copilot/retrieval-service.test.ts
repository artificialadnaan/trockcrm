import { describe, expect, it, vi } from "vitest";

const {
  htmlToPlainText,
  buildDocumentChunks,
  buildDealRetrievalQuery,
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

  it("builds a retrieval query from deal context, signals, and recent activity", () => {
    const query = buildDealRetrievalQuery({
      context: {
        deal: {
          name: "Alpha Plaza",
          stageName: "Estimating",
          proposalStatus: "revision_requested",
        },
        recentActivities: [
          { subject: "Estimator follow-up", body: "Waiting on site photos from customer." },
        ],
        recentEmails: [
          { subject: "Re: pricing revision", bodyPreview: "Can you update the allowance and send it today?" },
        ],
      },
      signals: [
        { signalType: "missing_next_task", summary: "Deal has no active follow-up task" },
      ],
    });

    expect(query).toContain("Alpha Plaza");
    expect(query).toContain("Estimating");
    expect(query).toContain("revision requested");
    expect(query).toContain("missing next task");
    expect(query).toContain("pricing revision");
    expect(query).toContain("Waiting on site photos");
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

  it("falls back to recent indexed chunks when embeddings are unavailable", async () => {
    const tenantDb = {
      execute: vi
        .fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({
          rows: [
            {
              id: "chunk-9",
              document_id: "doc-9",
              chunk_index: 0,
              text: "Recent inbound email mentioned revised scope.",
              metadata_json: { sourceType: "email_message", sentAt: "2026-04-15T12:00:00.000Z" },
              distance: null,
            },
          ],
        }),
    };

    const results = await searchDealKnowledge(tenantDb as any, {
      dealId: "deal-1",
      embedding: Array.from({ length: 1536 }, () => 0),
      limit: 1,
    });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      id: "chunk-9",
      distance: 1,
    });
    expect(tenantDb.execute).toHaveBeenCalledTimes(2);
  });

  it("uses lexical retrieval before recency fallback when query text is available", async () => {
    const tenantDb = {
      execute: vi
        .fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({
          rows: [
            {
              id: "chunk-lex",
              document_id: "doc-lex",
              chunk_index: 0,
              text: "Customer asked for updated pricing and revised allowance.",
              metadata_json: { sourceType: "email_message", sourceId: "email-44" },
              distance: 0.22,
            },
          ],
        }),
    };

    const results = await searchDealKnowledge(tenantDb as any, {
      dealId: "deal-1",
      embedding: Array.from({ length: 1536 }, () => 0),
      queryText: "updated pricing revised allowance",
      limit: 1,
    });

    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("chunk-lex");
    expect(tenantDb.execute).toHaveBeenCalledTimes(2);
  });
});
