import { eq, sql } from "drizzle-orm";
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

async function getCurrentDocumentState(tenantDb: TenantDb, documentId: string) {
  const [currentDocument] = await tenantDb
    .select()
    .from(estimateSourceDocuments)
    .where(eq(estimateSourceDocuments.id, documentId))
    .limit(1);

  return currentDocument ?? null;
}

async function claimDocumentProcessingRun(args: {
  tenantDb: TenantDb;
  documentId: string;
  parseRun: {
    id: string;
    startedAt: Date | string | null;
    createdAt: Date | string | null;
  };
  options: { provider: string; profile: string };
}) {
  await args.tenantDb.execute(sql`
    update estimate_source_documents as document
    set
      parse_status = 'processing',
      ocr_status = 'processing',
      active_parse_run_id = ${args.parseRun.id},
      parse_provider = ${args.options.provider},
      parse_profile = ${args.options.profile},
      parse_error_summary = null
    where document.id = ${args.documentId}
      and not exists (
        select 1
        from estimate_document_parse_runs as owning_run
        where owning_run.id = document.active_parse_run_id
          and (
            owning_run.started_at > ${args.parseRun.startedAt}
            or (
              owning_run.started_at = ${args.parseRun.startedAt}
              and owning_run.created_at > ${args.parseRun.createdAt}
            )
            or (
              owning_run.started_at = ${args.parseRun.startedAt}
              and owning_run.created_at = ${args.parseRun.createdAt}
              and owning_run.id > ${args.parseRun.id}
            )
          )
      )
  `);
}

async function activateCompletedParseRun(args: {
  tenantDb: TenantDb;
  documentId: string;
  parseRunId: string;
  options: { provider: string; profile: string };
}) {
  await args.tenantDb.execute(sql`
    with candidate_run as (
      select id, document_id, started_at, created_at
      from estimate_document_parse_runs
      where id = ${args.parseRunId}
        and document_id = ${args.documentId}
    ),
    updated_document as (
      update estimate_source_documents as document
      set
        parse_status = 'completed',
        ocr_status = 'completed',
        active_parse_run_id = ${args.parseRunId},
        parse_provider = ${args.options.provider},
        parse_profile = ${args.options.profile},
        parse_error_summary = null,
        parsed_at = now()
      from candidate_run
      where document.id = candidate_run.document_id
        and document.active_parse_run_id = candidate_run.id
        and not exists (
          select 1
          from estimate_document_parse_runs as newer_run
          where newer_run.document_id = candidate_run.document_id
            and newer_run.status != 'failed'
            and (
              newer_run.started_at > candidate_run.started_at
              or (
                newer_run.started_at = candidate_run.started_at
                and newer_run.created_at > candidate_run.created_at
              )
              or (
                newer_run.started_at = candidate_run.started_at
                and newer_run.created_at = candidate_run.created_at
                and newer_run.id > candidate_run.id
              )
            )
        )
      returning document.id
    ),
    updated_pages as (
      update estimate_document_pages as page
      set metadata_json =
        coalesce(page.metadata_json, '{}'::jsonb)
        || jsonb_build_object(
          'activeArtifact',
          page.metadata_json->>'sourceParseRunId' = ${args.parseRunId}
        )
      from updated_document
      where page.document_id = updated_document.id
      returning 1
    )
    update estimate_extractions as extraction
    set metadata_json =
      coalesce(extraction.metadata_json, '{}'::jsonb)
      || jsonb_build_object(
        'activeArtifact',
        extraction.metadata_json->>'sourceParseRunId' = ${args.parseRunId}
      )
    from updated_document
    where extraction.document_id = updated_document.id
  `);

  return getCurrentDocumentState(args.tenantDb, args.documentId);
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
  const [parseRun] = await args.tenantDb
    .update(estimateDocumentParseRuns)
    .set({
      status: "failed",
      errorSummary: args.errorSummary,
      completedAt: new Date(),
    })
    .where(eq(estimateDocumentParseRuns.id, args.parseRunId))
    .returning();

  await args.tenantDb.execute(sql`
    update estimate_source_documents as document
    set
      parse_status = 'failed',
      ocr_status = 'failed',
      parse_provider = ${args.options.provider},
      parse_profile = ${args.options.profile},
      parse_error_summary = ${args.errorSummary},
      active_parse_run_id = null
    where document.id = ${args.document.id}
      and document.active_parse_run_id = ${args.parseRunId}
  `);

  const documentUpdate = await getCurrentDocumentState(args.tenantDb, args.document.id);

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

  await claimDocumentProcessingRun({
    tenantDb: args.tenantDb,
    documentId: args.document.id,
    parseRun,
    options,
  });

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

    let documentUpdate = await getCurrentDocumentState(args.tenantDb, args.document.id);
    documentUpdate = await activateCompletedParseRun({
      tenantDb: args.tenantDb,
      documentId: args.document.id,
      parseRunId: parseRun.id,
      options,
    });

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
