import { describe, expect, it, vi } from "vitest";
import {
  estimateDocumentPages,
  estimateDocumentParseRuns,
  estimateExtractions,
  estimateSourceDocuments,
} from "@trock-crm/shared/schema";
import { runEstimateDocumentParse } from "../../../src/modules/estimating/document-parse-orchestrator.js";

function createTenantDbMock(document: Record<string, any>) {
  const insertedPages: Record<string, any>[] = [];
  const insertedExtractions: Record<string, any>[] = [];
  const insertedParseRuns: Record<string, any>[] = [];
  const updatedDocuments: Record<string, any>[] = [];
  const updatedParseRuns: Record<string, any>[] = [];

  const tenantDb = {
    insert: vi.fn((table: unknown) => ({
      values: vi.fn((value: Record<string, any> | Record<string, any>[]) => {
        if (table === estimateExtractions) {
          const rows = (Array.isArray(value) ? value : [value]).map((row, index) => ({
            id: `extraction-${index + 1}`,
            ...row,
          }));
          insertedExtractions.push(...rows);
          return Promise.resolve(rows);
        }

        return {
          returning: vi.fn().mockImplementation(async () => {
            if (table === estimateDocumentParseRuns) {
              const parseRun = {
                id: "parse-run-1",
                documentId: document.id,
                status: "processing",
                parseProfile: "balanced",
                parseProvider: "default",
                errorSummary: null,
                startedAt: new Date("2026-04-20T12:00:00.000Z"),
                completedAt: null,
                createdAt: new Date("2026-04-20T12:00:00.000Z"),
                ...value,
              };
              insertedParseRuns.push(parseRun);
              return [parseRun];
            }

            if (table === estimateDocumentPages) {
              const rows = (Array.isArray(value) ? value : [value]).map((row, index) => ({
                id: `page-${index + 1}`,
                ...row,
              }));
              insertedPages.push(...rows);
              return rows;
            }

            return [];
          }),
        };
      }),
    })),
    update: vi.fn((table: unknown) => ({
      set: vi.fn((value: Record<string, any>) => ({
        where: vi.fn(() => ({
          returning: vi.fn().mockImplementation(async () => {
            if (table === estimateDocumentParseRuns) {
              const parseRun = {
                ...insertedParseRuns[0],
                ...value,
              };
              updatedParseRuns.push(parseRun);
              return [parseRun];
            }

            if (table === estimateSourceDocuments) {
              const updatedDocument = {
                ...document,
                ...value,
              };
              updatedDocuments.push(updatedDocument);
              return [updatedDocument];
            }

            return [];
          }),
        })),
      })),
    })),
    execute: vi.fn().mockResolvedValue(undefined),
  } as any;

  return {
    tenantDb,
    insertedPages,
    insertedExtractions,
    updatedDocuments,
    updatedParseRuns,
  };
}

describe("runEstimateDocumentParse", () => {
  it("creates a parse run, persists active outputs, and marks the document completed", async () => {
    const document = {
      id: "doc-1",
      dealId: "deal-1",
      projectId: "project-1",
      filename: "A1-plan.pdf",
      documentType: "plan",
      mimeType: "application/pdf",
      storageKey: "stale/storage-key.pdf",
      contentHash: "r2/estimate-documents/doc-1.pdf",
    };
    const { tenantDb, insertedPages, insertedExtractions, updatedDocuments, updatedParseRuns } =
      createTenantDbMock(document);

    const result = await runEstimateDocumentParse({
      tenantDb,
      document,
      options: {
        provider: "default",
        profile: "balanced",
      },
    });

    expect(result.parseRun.status).toBe("completed");
    expect(result.documentUpdate).toEqual(
      expect.objectContaining({
        parseStatus: "completed",
        ocrStatus: "completed",
        activeParseRunId: "parse-run-1",
        parseProvider: "default",
        parseProfile: "balanced",
      })
    );
    expect(insertedPages).toEqual([
      expect.objectContaining({
        documentId: "doc-1",
        pageNumber: 1,
        pageImageKey: "r2/estimate-documents/doc-1.pdf",
        metadataJson: expect.objectContaining({
          sourceParseRunId: "parse-run-1",
          sourceKind: "pdf_page",
          activeArtifact: false,
        }),
      }),
    ]);
    expect(insertedExtractions).not.toHaveLength(0);
    expect(insertedExtractions[0]).toEqual(
      expect.objectContaining({
        documentId: "doc-1",
        metadataJson: expect.objectContaining({
          sourceParseRunId: "parse-run-1",
          activeArtifact: false,
          extractionProvider: "default",
        }),
      })
    );
    expect(tenantDb.execute).toHaveBeenCalledTimes(4);
    expect(updatedParseRuns.at(-1)).toEqual(
      expect.objectContaining({
        id: "parse-run-1",
        status: "completed",
      })
    );
    expect(updatedDocuments.at(-1)).toEqual(
      expect.objectContaining({
        activeParseRunId: "parse-run-1",
        parseStatus: "completed",
      })
    );
  });

  it("marks the parse and document failed when an unsupported mime type reaches the orchestrator", async () => {
    const document = {
      id: "doc-unsupported",
      dealId: "deal-1",
      projectId: null,
      filename: "notes.txt",
      documentType: "supporting_package",
      mimeType: "text/plain",
      storageKey: "files/notes.txt",
      contentHash: "r2/estimate-documents/notes.txt",
    };
    const { tenantDb, insertedPages, insertedExtractions, updatedDocuments, updatedParseRuns } =
      createTenantDbMock(document);

    await expect(
      runEstimateDocumentParse({
        tenantDb,
        document,
        options: {
          provider: "default",
          profile: "balanced",
        },
      })
    ).rejects.toThrow("Unsupported estimate document type: text/plain");

    expect(insertedPages).toHaveLength(0);
    expect(insertedExtractions).toHaveLength(0);
    expect(updatedParseRuns.at(-1)).toEqual(
      expect.objectContaining({
        id: "parse-run-1",
        status: "failed",
        errorSummary: "Unsupported estimate document type: text/plain",
      })
    );
    expect(updatedDocuments.at(-1)).toEqual(
      expect.objectContaining({
        parseStatus: "failed",
        ocrStatus: "failed",
        parseErrorSummary: "Unsupported estimate document type: text/plain",
      })
    );
  });
});
