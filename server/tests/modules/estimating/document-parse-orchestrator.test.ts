import { describe, expect, it, vi } from "vitest";
import {
  estimateDocumentPages,
  estimateDocumentParseRuns,
  estimateExtractions,
  estimateSourceDocuments,
} from "@trock-crm/shared/schema";
import { runEstimateDocumentParse } from "../../../src/modules/estimating/document-parse-orchestrator.js";

function readSql(query: any) {
  const chunks = query?.queryChunks ?? [];
  const params: any[] = [];
  const text = chunks
    .map((chunk: any) => {
      if (chunk && typeof chunk === "object" && "value" in chunk) {
        return Array.isArray(chunk.value) ? chunk.value.join("") : "";
      }
      params.push(chunk);
      return "?";
    })
    .join("");

  return { text, params };
}

function resolveDocumentAndRunParams(documentId: string, params: any[]) {
  const resolvedDocumentId = params.find((value) => value === documentId) ?? params[0];
  const resolvedParseRunId = params.find((value) => value !== resolvedDocumentId) ?? params[1];

  return {
    documentId: resolvedDocumentId,
    parseRunId: resolvedParseRunId,
  };
}

function createTenantDbMock(options: {
  documentSnapshot: Record<string, any>;
  currentDocument?: Record<string, any>;
  existingParseRuns?: Record<string, any>[];
  existingPages?: Record<string, any>[];
  existingExtractions?: Record<string, any>[];
  failOnDocumentComplete?: boolean;
  concurrentActiveParseRunIdOnFailure?: string | null;
  concurrentDocumentStateOnFailure?: Record<string, any>;
}) {
  const parseRuns = (options.existingParseRuns ?? []).map((row) => structuredClone(row));
  const updatedDocuments: Record<string, any>[] = [];
  const updatedParseRuns: Record<string, any>[] = [];
  const pages = (options.existingPages ?? []).map((row) => structuredClone(row));
  const extractions = (options.existingExtractions ?? []).map((row) => structuredClone(row));
  const documentState = {
    ...structuredClone(options.documentSnapshot),
    ...(options.currentDocument ? structuredClone(options.currentDocument) : {}),
  };

  const tenantDb = {
    insert: vi.fn((table: unknown) => ({
      values: vi.fn((value: Record<string, any> | Record<string, any>[]) => {
        if (table === estimateExtractions) {
          const rows = (Array.isArray(value) ? value : [value]).map((row, index) => ({
            id: `extraction-${extractions.length + index + 1}`,
            ...row,
          }));
          extractions.push(...rows);
          return Promise.resolve(rows);
        }

        return {
          returning: vi.fn().mockImplementation(async () => {
            if (table === estimateDocumentParseRuns) {
              const parseRun = {
                id: "parse-run-1",
                documentId: options.documentSnapshot.id,
                status: "processing",
                parseProfile: "balanced",
                parseProvider: "default",
                errorSummary: null,
                startedAt: new Date("2026-04-20T12:00:00.000Z"),
                completedAt: null,
                createdAt: new Date("2026-04-20T12:00:00.000Z"),
                ...value,
              };
              parseRuns.push(parseRun);
              return [parseRun];
            }

            if (table === estimateDocumentPages) {
              const rows = (Array.isArray(value) ? value : [value]).map((row, index) => ({
                id: `page-${pages.length + index + 1}`,
                ...row,
              }));
              pages.push(...rows);
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
              const previous =
                parseRuns.find((run) => run.id === "parse-run-1") ??
                parseRuns.find((run) => run.documentId === options.documentSnapshot.id);
              const parseRun = {
                ...previous,
                ...value,
              };
              const index = parseRuns.findIndex((run) => run.id === parseRun.id);
              if (index >= 0) {
                parseRuns[index] = parseRun;
              }
              updatedParseRuns.push(parseRun);
              return [parseRun];
            }

            if (table === estimateSourceDocuments) {
              if (value.parseStatus === "completed" && options.failOnDocumentComplete) {
                if (options.concurrentDocumentStateOnFailure) {
                  Object.assign(documentState, options.concurrentDocumentStateOnFailure);
                }
                if (options.concurrentActiveParseRunIdOnFailure !== undefined) {
                  documentState.activeParseRunId = options.concurrentActiveParseRunIdOnFailure;
                }
                throw new Error("simulated completion failure");
              }

              Object.assign(documentState, value);
              const updatedDocument = {
                ...documentState,
              };
              updatedDocuments.push(updatedDocument);
              return [updatedDocument];
            }

            return [];
          }),
        })),
      })),
    })),
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => ({
        where: vi.fn(() => ({
          orderBy: vi.fn(() => ({
            limit: vi.fn().mockImplementation(async () => {
              if (table === estimateDocumentParseRuns) {
                return [...parseRuns]
                  .sort((left, right) => {
                    const startedDiff =
                      new Date(right.startedAt ?? 0).getTime() - new Date(left.startedAt ?? 0).getTime();
                    if (startedDiff !== 0) return startedDiff;
                    return new Date(right.createdAt ?? 0).getTime() - new Date(left.createdAt ?? 0).getTime();
                  })
                  .map((row) => ({ ...row }));
              }
              return [];
            }),
          })),
          limit: vi.fn().mockImplementation(async () => {
            if (table === estimateSourceDocuments) {
              return [{ ...documentState }];
            }
            if (table === estimateDocumentParseRuns) {
              return [...parseRuns].map((row) => ({ ...row }));
            }
            return [];
          }),
        })),
      })),
    })),
    execute: vi.fn().mockImplementation(async (query: any) => {
      const { text, params } = readSql(query);

      if (text.includes("delete from estimate_extractions")) {
        const [documentId, parseRunId] = params;
        for (let index = extractions.length - 1; index >= 0; index -= 1) {
          if (
            extractions[index]?.documentId === documentId &&
            extractions[index]?.metadataJson?.sourceParseRunId === parseRunId
          ) {
            extractions.splice(index, 1);
          }
        }
        return;
      }

      if (text.includes("delete from estimate_document_pages")) {
        const [documentId, parseRunId] = params;
        for (let index = pages.length - 1; index >= 0; index -= 1) {
          if (
            pages[index]?.documentId === documentId &&
            pages[index]?.metadataJson?.sourceParseRunId === parseRunId
          ) {
            pages.splice(index, 1);
          }
        }
        return;
      }

      if (text.includes("update estimate_document_pages")) {
        const { documentId, parseRunId } = resolveDocumentAndRunParams(documentState.id, params);
        for (const page of pages) {
          if (page.documentId === documentId) {
            page.metadataJson = {
              ...(page.metadataJson ?? {}),
              activeArtifact: page.metadataJson?.sourceParseRunId === parseRunId,
            };
          }
        }
        return;
      }

      if (text.includes("update estimate_extractions")) {
        const { documentId, parseRunId } = resolveDocumentAndRunParams(documentState.id, params);
        for (const extraction of extractions) {
          if (extraction.documentId === documentId) {
            extraction.metadataJson = {
              ...(extraction.metadataJson ?? {}),
              activeArtifact: extraction.metadataJson?.sourceParseRunId === parseRunId,
            };
          }
        }
      }
    }),
  } as any;

  return {
    tenantDb,
    pages,
    extractions,
    documentState,
    parseRuns,
    updatedDocuments,
    updatedParseRuns,
  };
}

describe("runEstimateDocumentParse", () => {
  it("creates a parse run, supersedes old active artifacts, and marks the new run active", async () => {
    const documentSnapshot = {
      id: "doc-1",
      dealId: "deal-1",
      projectId: "project-1",
      filename: "A1-plan.pdf",
      documentType: "plan",
      mimeType: "application/pdf",
      storageKey: "stale/storage-key.pdf",
      contentHash: "r2/estimate-documents/doc-1.pdf",
      activeParseRunId: "parse-run-old",
    };
    const { tenantDb, pages, extractions, documentState, updatedDocuments, updatedParseRuns } =
      createTenantDbMock({
        documentSnapshot,
        existingPages: [
          {
            id: "page-old-1",
            documentId: "doc-1",
            pageNumber: 1,
            pageImageKey: "r2/estimate-documents/old.pdf",
            metadataJson: {
              sourceParseRunId: "parse-run-old",
              sourceKind: "pdf_page",
              activeArtifact: true,
            },
          },
        ],
        existingExtractions: [
          {
            id: "extraction-old-1",
            documentId: "doc-1",
            rawLabel: "existing line",
            normalizedLabel: "existing line",
            metadataJson: {
              sourceParseRunId: "parse-run-old",
              activeArtifact: true,
              extractionProvider: "default",
            },
          },
        ],
      });

    const result = await runEstimateDocumentParse({
      tenantDb,
      document: documentSnapshot,
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
    expect(pages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "page-old-1",
          metadataJson: expect.objectContaining({
            sourceParseRunId: "parse-run-old",
            activeArtifact: false,
          }),
        }),
        expect.objectContaining({
          documentId: "doc-1",
          pageNumber: 1,
          pageImageKey: "r2/estimate-documents/doc-1.pdf",
          metadataJson: expect.objectContaining({
            sourceParseRunId: "parse-run-1",
            sourceKind: "pdf_page",
            activeArtifact: true,
          }),
        }),
      ])
    );
    expect(extractions).toHaveLength(3);
    expect(extractions.at(-1)).toEqual(
      expect.objectContaining({
        documentId: "doc-1",
        metadataJson: expect.objectContaining({
          sourceParseRunId: "parse-run-1",
          activeArtifact: true,
          extractionProvider: "default",
        }),
      })
    );
    expect(extractions[0]).toEqual(
      expect.objectContaining({
        id: "extraction-old-1",
        metadataJson: expect.objectContaining({
          sourceParseRunId: "parse-run-old",
          activeArtifact: false,
        }),
      })
    );
    expect(updatedParseRuns.at(-1)).toEqual(
      expect.objectContaining({
        id: "parse-run-1",
        status: "completed",
      })
    );
    expect(updatedDocuments[0]).toEqual(
      expect.objectContaining({
        parseStatus: "processing",
        ocrStatus: "processing",
        activeParseRunId: "parse-run-1",
      })
    );
    expect(updatedDocuments.at(-1)).toEqual(expect.objectContaining({ activeParseRunId: "parse-run-1" }));
    expect(documentState.activeParseRunId).toBe("parse-run-1");
  });

  it("marks the parse and document failed when an unsupported mime type reaches the orchestrator", async () => {
    const documentSnapshot = {
      id: "doc-unsupported",
      dealId: "deal-1",
      projectId: null,
      filename: "notes.txt",
      documentType: "supporting_package",
      mimeType: "text/plain",
      storageKey: "files/notes.txt",
      contentHash: "r2/estimate-documents/notes.txt",
    };
    const { tenantDb, pages, extractions, updatedDocuments, updatedParseRuns } = createTenantDbMock({
      documentSnapshot,
    });

    await expect(
      runEstimateDocumentParse({
        tenantDb,
        document: documentSnapshot,
        options: {
          provider: "default",
          profile: "balanced",
        },
      })
    ).rejects.toThrow("Unsupported estimate document type: text/plain");

    expect(pages).toHaveLength(0);
    expect(extractions).toHaveLength(0);
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

  it("cleans up failed-run artifacts and preserves the current document state when the failure is stale", async () => {
    const documentSnapshot = {
      id: "doc-2",
      dealId: "deal-1",
      projectId: "project-1",
      filename: "A2-plan.pdf",
      documentType: "plan",
      mimeType: "application/pdf",
      storageKey: "stale/storage-key-a2.pdf",
      contentHash: "r2/estimate-documents/doc-2.pdf",
      activeParseRunId: "parse-run-stale",
    };
    const { tenantDb, pages, extractions, documentState, updatedDocuments, updatedParseRuns } =
      createTenantDbMock({
        documentSnapshot,
        currentDocument: {
          activeParseRunId: "parse-run-current",
          parseStatus: "processing",
          ocrStatus: "processing",
          parseProvider: "newer-provider",
          parseProfile: "balanced",
          parseErrorSummary: null,
        },
        existingPages: [
          {
            id: "page-current-1",
            documentId: "doc-2",
            pageNumber: 1,
            pageImageKey: "r2/estimate-documents/current.pdf",
            metadataJson: {
              sourceParseRunId: "parse-run-current",
              sourceKind: "pdf_page",
              activeArtifact: true,
            },
          },
        ],
        existingExtractions: [
          {
            id: "extraction-current-1",
            documentId: "doc-2",
            rawLabel: "current line",
            normalizedLabel: "current line",
            metadataJson: {
              sourceParseRunId: "parse-run-current",
              activeArtifact: true,
              extractionProvider: "default",
            },
          },
        ],
        failOnDocumentComplete: true,
        concurrentActiveParseRunIdOnFailure: "parse-run-newer",
      });

    await expect(
      runEstimateDocumentParse({
        tenantDb,
        document: documentSnapshot,
        options: {
          provider: "default",
          profile: "balanced",
        },
      })
    ).rejects.toThrow("simulated completion failure");

    expect(pages).toEqual([
      expect.objectContaining({
        id: "page-current-1",
        metadataJson: expect.objectContaining({
          sourceParseRunId: "parse-run-current",
          activeArtifact: true,
        }),
      }),
    ]);
    expect(extractions).toEqual([
      expect.objectContaining({
        id: "extraction-current-1",
        metadataJson: expect.objectContaining({
          sourceParseRunId: "parse-run-current",
          activeArtifact: true,
        }),
      }),
    ]);
    expect(updatedParseRuns.at(-1)).toEqual(
      expect.objectContaining({
        id: "parse-run-1",
        status: "failed",
        errorSummary: "simulated completion failure",
      })
    );
    expect(updatedDocuments).toEqual(
      expect.not.arrayContaining([
        expect.objectContaining({
          parseStatus: "failed",
          parseErrorSummary: "simulated completion failure",
        }),
      ])
    );
    expect(documentState).toEqual(
      expect.objectContaining({
        parseStatus: "processing",
        ocrStatus: "processing",
        activeParseRunId: "parse-run-newer",
        parseErrorSummary: null,
      })
    );
    expect(documentState.activeParseRunId).toBe("parse-run-newer");
  });

  it("does not clobber a newer queued requeue state when a stale run fails with no active parse run", async () => {
    const documentSnapshot = {
      id: "doc-4",
      dealId: "deal-1",
      projectId: "project-1",
      filename: "A4-plan.pdf",
      documentType: "plan",
      mimeType: "application/pdf",
      storageKey: "stale/storage-key-a4.pdf",
      contentHash: "r2/estimate-documents/doc-4.pdf",
      activeParseRunId: "parse-run-old-active",
    };
    const { tenantDb, pages, extractions, documentState, updatedDocuments, updatedParseRuns } =
      createTenantDbMock({
        documentSnapshot,
        currentDocument: {
          activeParseRunId: "parse-run-old-active",
          parseStatus: "processing",
          ocrStatus: "processing",
          parseProvider: "default",
          parseProfile: "balanced",
          parseErrorSummary: null,
        },
        existingPages: [
          {
            id: "page-queued-1",
            documentId: "doc-4",
            pageNumber: 1,
            pageImageKey: "r2/estimate-documents/last-good.pdf",
            metadataJson: {
              sourceParseRunId: "parse-run-old-active",
              sourceKind: "pdf_page",
              activeArtifact: true,
            },
          },
        ],
        existingExtractions: [
          {
            id: "extraction-queued-1",
            documentId: "doc-4",
            rawLabel: "last good line",
            normalizedLabel: "last good line",
            metadataJson: {
              sourceParseRunId: "parse-run-old-active",
              activeArtifact: true,
              extractionProvider: "default",
            },
          },
        ],
        failOnDocumentComplete: true,
        concurrentDocumentStateOnFailure: {
          activeParseRunId: null,
          parseStatus: "queued",
          ocrStatus: "queued",
          parseProvider: null,
          parseProfile: null,
          parseErrorSummary: null,
          parsedAt: null,
        },
      });

    await expect(
      runEstimateDocumentParse({
        tenantDb,
        document: documentSnapshot,
        options: {
          provider: "default",
          profile: "balanced",
        },
      })
    ).rejects.toThrow("simulated completion failure");

    expect(updatedParseRuns.at(-1)).toEqual(
      expect.objectContaining({
        id: "parse-run-1",
        status: "failed",
        errorSummary: "simulated completion failure",
      })
    );
    expect(updatedDocuments).toEqual(
      expect.not.arrayContaining([
        expect.objectContaining({
          parseStatus: "failed",
          ocrStatus: "failed",
          parseErrorSummary: "simulated completion failure",
        }),
      ])
    );
    expect(documentState).toEqual(
      expect.objectContaining({
        activeParseRunId: null,
        parseStatus: "queued",
        ocrStatus: "queued",
        parseErrorSummary: null,
      })
    );
    expect(pages).toEqual([
      expect.objectContaining({
        id: "page-queued-1",
        metadataJson: expect.objectContaining({
          sourceParseRunId: "parse-run-old-active",
          activeArtifact: true,
        }),
      }),
    ]);
    expect(extractions).toEqual([
      expect.objectContaining({
        id: "extraction-queued-1",
        metadataJson: expect.objectContaining({
          sourceParseRunId: "parse-run-old-active",
          activeArtifact: true,
        }),
      }),
    ]);
  });

  it("does not let an older run steal activation from a newer run that is already current", async () => {
    const documentSnapshot = {
      id: "doc-3",
      dealId: "deal-1",
      projectId: "project-1",
      filename: "A3-plan.pdf",
      documentType: "plan",
      mimeType: "application/pdf",
      storageKey: "stale/storage-key-a3.pdf",
      contentHash: "r2/estimate-documents/doc-3.pdf",
      activeParseRunId: "parse-run-old-active",
    };
    const { tenantDb, pages, extractions, documentState, parseRuns, updatedDocuments, updatedParseRuns } =
      createTenantDbMock({
        documentSnapshot,
        currentDocument: {
          activeParseRunId: "parse-run-newer",
          parseStatus: "processing",
          ocrStatus: "processing",
        },
        existingParseRuns: [
          {
            id: "parse-run-newer",
            documentId: "doc-3",
            status: "processing",
            parseProfile: "balanced",
            parseProvider: "default",
            errorSummary: null,
            startedAt: new Date("2026-04-20T12:05:00.000Z"),
            completedAt: null,
            createdAt: new Date("2026-04-20T12:05:00.000Z"),
          },
        ],
        existingPages: [
          {
            id: "page-newer-1",
            documentId: "doc-3",
            pageNumber: 1,
            pageImageKey: "r2/estimate-documents/newer.pdf",
            metadataJson: {
              sourceParseRunId: "parse-run-newer",
              sourceKind: "pdf_page",
              activeArtifact: true,
            },
          },
        ],
        existingExtractions: [
          {
            id: "extraction-newer-1",
            documentId: "doc-3",
            rawLabel: "newer line",
            normalizedLabel: "newer line",
            metadataJson: {
              sourceParseRunId: "parse-run-newer",
              activeArtifact: true,
              extractionProvider: "default",
            },
          },
        ],
      });

    const result = await runEstimateDocumentParse({
      tenantDb,
      document: documentSnapshot,
      options: {
        provider: "default",
        profile: "balanced",
      },
    });

    expect(result.parseRun).toEqual(
      expect.objectContaining({
        id: "parse-run-1",
        status: "completed",
      })
    );
    expect(result.documentUpdate).toEqual(
      expect.objectContaining({
        activeParseRunId: "parse-run-newer",
        parseStatus: "processing",
        ocrStatus: "processing",
      })
    );
    expect(parseRuns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "parse-run-1",
          status: "completed",
        }),
        expect.objectContaining({
          id: "parse-run-newer",
          status: "processing",
        }),
      ])
    );
    expect(updatedDocuments).toEqual(
      expect.not.arrayContaining([
        expect.objectContaining({
          activeParseRunId: "parse-run-1",
        }),
      ])
    );
    expect(documentState.activeParseRunId).toBe("parse-run-newer");
    expect(pages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "page-newer-1",
          metadataJson: expect.objectContaining({
            sourceParseRunId: "parse-run-newer",
            activeArtifact: true,
          }),
        }),
        expect.objectContaining({
          documentId: "doc-3",
          metadataJson: expect.objectContaining({
            sourceParseRunId: "parse-run-1",
            activeArtifact: false,
          }),
        }),
      ])
    );
    expect(extractions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "extraction-newer-1",
          metadataJson: expect.objectContaining({
            sourceParseRunId: "parse-run-newer",
            activeArtifact: true,
          }),
        }),
        expect.objectContaining({
          documentId: "doc-3",
          metadataJson: expect.objectContaining({
            sourceParseRunId: "parse-run-1",
            activeArtifact: false,
          }),
        }),
      ])
    );
    expect(updatedParseRuns.at(-1)).toEqual(
      expect.objectContaining({
        id: "parse-run-1",
        status: "completed",
      })
    );
  });
});
