import { desc, eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "@trock-crm/shared/schema";
import {
  estimateDocumentPages,
  estimateDocumentParseRuns,
  estimateExtractions,
  estimateSourceDocuments,
} from "@trock-crm/shared/schema";
import { normalizeEstimateDocumentPages } from "./document-page-extractor.js";
import { extractEstimateScopeRows } from "./extraction-service.js";

type TenantDb = NodePgDatabase<typeof schema>;

export interface EstimateDocumentParseOptions {
  provider?: string | null;
  profile?: string | null;
}

export interface EstimateDocumentParseDocument {
  id: string;
  dealId: string;
  projectId?: string | null;
  filename: string;
  documentType?: string | null;
  mimeType: string;
  storageKey?: string | null;
  contentHash?: string | null;
  activeParseRunId?: string | null;
}

export interface EstimateDocumentParseResult {
  parseRun: Record<string, any>;
  documentUpdate: Record<string, any>;
  pageCount: number;
  extractionCount: number;
}

function resolveParseOptions(options?: EstimateDocumentParseOptions) {
  return {
    provider: options?.provider ?? "default",
    profile: options?.profile ?? "balanced",
  };
}

function buildDeterministicPageContent(input: {
  document: EstimateDocumentParseDocument;
  pageNumber: number;
}) {
  const filenameStem = input.document.filename.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim();
  const documentType = (input.document.documentType ?? "document").replace(/_/g, " ").trim();

  return {
    text: [filenameStem, `${documentType} page ${input.pageNumber}`].filter(Boolean).join("\n"),
    blocks: [
      { text: filenameStem || input.document.filename },
      { text: `${documentType} page ${input.pageNumber}`.trim() },
    ],
  };
}

async function markArtifactsInactive(
  tenantDb: TenantDb,
  documentId: string,
  parseRunId: string
) {
  await tenantDb.execute(sql`
    update estimate_document_pages
    set metadata_json =
      coalesce(metadata_json, '{}'::jsonb)
      || jsonb_build_object(
        'activeArtifact',
        metadata_json->>'sourceParseRunId' = ${parseRunId}
      )
    where document_id = ${documentId}
  `);

  await tenantDb.execute(sql`
    update estimate_extractions
    set metadata_json =
      coalesce(metadata_json, '{}'::jsonb)
      || jsonb_build_object(
        'activeArtifact',
        metadata_json->>'sourceParseRunId' = ${parseRunId}
      )
    where document_id = ${documentId}
  `);
}

async function getCurrentDocumentState(tenantDb: TenantDb, documentId: string) {
  const [currentDocument] = await tenantDb
    .select()
    .from(estimateSourceDocuments)
    .where(eq(estimateSourceDocuments.id, documentId))
    .limit(1);

  return currentDocument ?? null;
}

async function isFreshestEligibleParseRun(
  tenantDb: TenantDb,
  documentId: string,
  parseRunId: string
) {
  const parseRuns = await tenantDb
    .select()
    .from(estimateDocumentParseRuns)
    .where(eq(estimateDocumentParseRuns.documentId, documentId))
    .orderBy(
      desc(estimateDocumentParseRuns.startedAt),
      desc(estimateDocumentParseRuns.createdAt)
    )
    .limit(10);

  const newestEligibleRun = parseRuns.find((run) => run.status !== "failed");
  return newestEligibleRun?.id === parseRunId;
}

async function cleanupFailedParseArtifacts(
  tenantDb: TenantDb,
  documentId: string,
  parseRunId: string
) {
  await tenantDb.execute(sql`
    delete from estimate_extractions
    where document_id = ${documentId}
      and metadata_json->>'sourceParseRunId' = ${parseRunId}
  `);

  await tenantDb.execute(sql`
    delete from estimate_document_pages
    where document_id = ${documentId}
      and metadata_json->>'sourceParseRunId' = ${parseRunId}
  `);
}

async function markParseFailed(args: {
  tenantDb: TenantDb;
  document: EstimateDocumentParseDocument;
  parseRunId: string;
  options: { provider: string; profile: string };
  errorSummary: string;
}) {
  const currentDocument = await getCurrentDocumentState(args.tenantDb, args.document.id);

  const [parseRun] = await args.tenantDb
    .update(estimateDocumentParseRuns)
    .set({
      status: "failed",
      errorSummary: args.errorSummary,
      completedAt: new Date(),
    })
    .where(eq(estimateDocumentParseRuns.id, args.parseRunId))
    .returning();

  const hasSupersededActiveRun =
    currentDocument?.activeParseRunId != null &&
    currentDocument.activeParseRunId !== args.parseRunId;
  const isQueuedRequeueState =
    currentDocument?.activeParseRunId == null &&
    currentDocument?.parseStatus === "queued" &&
    currentDocument?.ocrStatus === "queued";

  if (hasSupersededActiveRun || isQueuedRequeueState) {
    return { parseRun, documentUpdate: currentDocument };
  }

  const [documentUpdate] = await args.tenantDb
    .update(estimateSourceDocuments)
    .set({
      parseStatus: "failed",
      ocrStatus: "failed",
      parseProvider: args.options.provider,
      parseProfile: args.options.profile,
      parseErrorSummary: args.errorSummary,
      activeParseRunId:
        currentDocument?.activeParseRunId === args.parseRunId
          ? null
          : currentDocument?.activeParseRunId ?? null,
    })
    .where(eq(estimateSourceDocuments.id, args.document.id))
    .returning();

  return { parseRun, documentUpdate };
}

export async function runEstimateDocumentParse(args: {
  tenantDb: TenantDb;
  document: EstimateDocumentParseDocument;
  options?: EstimateDocumentParseOptions;
}): Promise<EstimateDocumentParseResult> {
  const options = resolveParseOptions(args.options);

  const [parseRun] = await args.tenantDb
    .insert(estimateDocumentParseRuns)
    .values({
      documentId: args.document.id,
      status: "processing",
      parseProvider: options.provider,
      parseProfile: options.profile,
    })
    .returning();

  await args.tenantDb
    .update(estimateSourceDocuments)
    .set({
      parseStatus: "processing",
      ocrStatus: "processing",
      parseProvider: options.provider,
      parseProfile: options.profile,
      parseErrorSummary: null,
    })
    .where(eq(estimateSourceDocuments.id, args.document.id))
    .returning();

  try {
    const normalizedPages = await normalizeEstimateDocumentPages({
      filename: args.document.filename,
      mimeType: args.document.mimeType,
      storageKey: args.document.storageKey ?? null,
      sourceObjectKey: args.document.contentHash ?? null,
    });

    if (normalizedPages.length === 0) {
      throw new Error(`No normalized pages produced for estimate document ${args.document.id}`);
    }

    const pageValues = normalizedPages.map((page) => {
      const parsed = buildDeterministicPageContent({
        document: args.document,
        pageNumber: page.pageNumber,
      });

      return {
        documentId: args.document.id,
        pageNumber: page.pageNumber,
        sheetLabel: `AUTO-${page.pageNumber}`,
        sheetType: args.document.documentType ?? null,
        ocrText: parsed.text,
        pageImageKey: page.pageImageKey,
        metadataJson: {
          sourceKind: page.sourceKind,
          sourceParseRunId: parseRun.id,
          pageWidth: page.width,
          pageHeight: page.height,
          ocrProvider: options.provider,
          ocrMethod: "deterministic_normalizer",
          activeArtifact: false,
          blocks: parsed.blocks,
        },
      };
    });

    const insertedPages = await args.tenantDb
      .insert(estimateDocumentPages)
      .values(pageValues)
      .returning();

    const extractionRows = extractEstimateScopeRows({
      documentId: args.document.id,
      dealId: args.document.dealId,
      projectId: args.document.projectId ?? null,
      parseRunId: parseRun.id,
      pages: insertedPages.map((page) => ({
        pageId: page.id,
        pageNumber: page.pageNumber,
        text: page.ocrText ?? "",
        provider: options.provider,
        method: "deterministic_normalizer",
        blocks: Array.isArray(page.metadataJson?.blocks) ? page.metadataJson.blocks : undefined,
        metadata: {
          sourceKind: page.metadataJson?.sourceKind ?? null,
          activeArtifact: false,
        },
      })),
    });

    if (extractionRows.length === 0) {
      throw new Error(`No extraction rows produced for estimate document ${args.document.id}`);
    }

    await args.tenantDb.insert(estimateExtractions).values(
      extractionRows.map((row) => ({
        dealId: row.dealId,
        projectId: row.projectId,
        documentId: args.document.id,
        pageId: row.pageId,
        extractionType: row.extractionType,
        rawLabel: row.rawLabel,
        normalizedLabel: row.normalizedLabel,
        quantity: row.quantity,
        unit: row.unit,
        divisionHint: row.divisionHint,
        confidence: row.confidence,
        evidenceText: row.evidenceText,
        evidenceBboxJson: row.evidenceBboxJson,
        metadataJson: row.metadataJson,
      }))
    );

    const [completedParseRun] = await args.tenantDb
      .update(estimateDocumentParseRuns)
      .set({
        status: "completed",
        completedAt: new Date(),
        errorSummary: null,
      })
      .where(eq(estimateDocumentParseRuns.id, parseRun.id))
      .returning();

    const canActivate = await isFreshestEligibleParseRun(
      args.tenantDb,
      args.document.id,
      parseRun.id
    );

    let documentUpdate = await getCurrentDocumentState(args.tenantDb, args.document.id);
    if (canActivate) {
      const [activatedDocument] = await args.tenantDb
        .update(estimateSourceDocuments)
        .set({
          parseStatus: "completed",
          ocrStatus: "completed",
          activeParseRunId: parseRun.id,
          parseProvider: options.provider,
          parseProfile: options.profile,
          parseErrorSummary: null,
          parsedAt: new Date(),
        })
        .where(eq(estimateSourceDocuments.id, args.document.id))
        .returning();

      await markArtifactsInactive(args.tenantDb, args.document.id, parseRun.id);
      documentUpdate = activatedDocument;
    }

    return {
      parseRun: completedParseRun,
      documentUpdate,
      pageCount: insertedPages.length,
      extractionCount: extractionRows.length,
    };
  } catch (error) {
    const errorSummary =
      error instanceof Error ? error.message : "estimate document parse failed";

    await cleanupFailedParseArtifacts(args.tenantDb, args.document.id, parseRun.id);
    await markParseFailed({
      tenantDb: args.tenantDb,
      document: args.document,
      parseRunId: parseRun.id,
      options,
      errorSummary,
    });

    throw error;
  }
}
