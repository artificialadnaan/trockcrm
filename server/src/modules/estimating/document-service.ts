import { and, eq, isNull, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "@trock-crm/shared/schema";
import { estimateSourceDocuments } from "@trock-crm/shared/schema";
import { AppError } from "../../middleware/error-handler.js";

type TenantDb = NodePgDatabase<typeof schema>;

export interface CreateEstimateSourceDocumentArgs {
  tenantDb: TenantDb;
  enqueueEstimateDocumentOcr: (payload: {
    documentId: string;
    dealId: string;
    officeId: string | null;
    parseProvider?: string | null;
    parseProfile?: string | null;
    parseMeasurementsEnabled?: boolean;
  }) => Promise<void>;
  input: {
    dealId: string;
    projectId?: string | null;
    fileId: string;
    rootFileId?: string | null;
    filename: string;
    storageKey?: string | null;
    mimeType: string;
    fileSize?: number | null;
    versionLabel?: string | null;
    contentHash?: string | null;
    documentType?: string | null;
    userId: string;
    officeId: string | null;
    reprocessExisting?: boolean;
    parseMeasurementsEnabled?: boolean;
  };
}

export interface ReprocessEstimateSourceDocumentArgs {
  tenantDb: TenantDb;
  enqueueEstimateDocumentOcr: (payload: {
    documentId: string;
    dealId: string;
    officeId: string | null;
    parseProvider?: string | null;
    parseProfile?: string | null;
    parseMeasurementsEnabled?: boolean;
  }) => Promise<void>;
  input: {
    dealId: string;
    documentId: string;
    userId: string;
    officeId: string | null;
    parseProvider?: string | null;
    parseProfile?: string | null;
    parseMeasurementsEnabled?: boolean;
  };
}

export function classifyEstimateDocument(input: { filename: string; mimeType: string }) {
  if (/spec/i.test(input.filename)) return "spec";
  if (/plan|blueprint/i.test(input.filename)) return "plan";
  return "supporting_package";
}

function normalizeParseOption(value: string | null | undefined, fallback: string) {
  if (value == null) return fallback;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

export async function enqueueEstimateDocumentOcrJob(
  tenantDb: TenantDb,
  payload: {
    documentId: string;
    dealId: string;
    officeId: string | null;
    parseProvider?: string | null;
    parseProfile?: string | null;
    parseMeasurementsEnabled?: boolean;
  }
) {
  await tenantDb.execute(
    sql`INSERT INTO public.job_queue (job_type, payload, office_id, status, run_after)
        VALUES (
          'estimate_document_ocr',
          ${JSON.stringify({
            documentId: payload.documentId,
            dealId: payload.dealId,
            parseProvider: payload.parseProvider ?? null,
            parseProfile: payload.parseProfile ?? null,
            parseMeasurementsEnabled: payload.parseMeasurementsEnabled ?? false,
          })}::jsonb,
          ${payload.officeId}::uuid,
          'pending',
          NOW()
        )`
  );
}

export async function createEstimateSourceDocument({
  tenantDb,
  enqueueEstimateDocumentOcr,
  input,
}: CreateEstimateSourceDocumentArgs) {
  const existing = input.fileId && input.contentHash
    ? await tenantDb
        .select({
          id: estimateSourceDocuments.id,
          fileId: estimateSourceDocuments.fileId,
          rootFileId: estimateSourceDocuments.rootFileId,
          contentHash: estimateSourceDocuments.contentHash,
          dealId: estimateSourceDocuments.dealId,
          filename: estimateSourceDocuments.filename,
          parseStatus: estimateSourceDocuments.parseStatus,
          activeParseRunId: estimateSourceDocuments.activeParseRunId,
          parseProfile: estimateSourceDocuments.parseProfile,
          parseProvider: estimateSourceDocuments.parseProvider,
          parseMeasurementsEnabled: estimateSourceDocuments.parseMeasurementsEnabled,
          parseErrorSummary: estimateSourceDocuments.parseErrorSummary,
        })
        .from(estimateSourceDocuments)
        .where(
          and(
            eq(estimateSourceDocuments.dealId, input.dealId),
            input.projectId
              ? eq(estimateSourceDocuments.projectId, input.projectId)
              : isNull(estimateSourceDocuments.projectId),
            eq(estimateSourceDocuments.contentHash, input.contentHash)
          )
        )
    : [];

  if (existing[0] && input.reprocessExisting !== true) {
    return existing[0];
  }

  const [document] = await tenantDb
    .insert(estimateSourceDocuments)
    .values({
      dealId: input.dealId,
      projectId: input.projectId ?? null,
      fileId: input.fileId,
      rootFileId: input.rootFileId ?? input.fileId,
      documentType:
        input.documentType ??
        classifyEstimateDocument({
          filename: input.filename,
          mimeType: input.mimeType,
        }),
      filename: input.filename,
      storageKey: input.storageKey ?? null,
      mimeType: input.mimeType,
      fileSize: input.fileSize ?? null,
      versionLabel: input.versionLabel ?? null,
      contentHash: input.contentHash ?? null,
      parseStatus: "queued",
      activeParseRunId: null,
      parseProfile: null,
      parseProvider: null,
      parseMeasurementsEnabled: input.parseMeasurementsEnabled ?? false,
      parseErrorSummary: null,
      ocrStatus: "queued",
      uploadedByUserId: input.userId,
    })
    .returning();

  await enqueueEstimateDocumentOcr({
    documentId: document.id,
    dealId: document.dealId,
    officeId: input.officeId,
    parseProvider: normalizeParseOption(document.parseProvider, "default"),
    parseProfile: normalizeParseOption(document.parseProfile, "balanced"),
    parseMeasurementsEnabled: document.parseMeasurementsEnabled,
  });

  return document;
}

export async function reprocessEstimateSourceDocument({
  tenantDb,
  enqueueEstimateDocumentOcr,
  input,
}: ReprocessEstimateSourceDocumentArgs) {
  const [currentDocument] = await tenantDb
    .select({
      documentType: estimateSourceDocuments.documentType,
      parseProvider: estimateSourceDocuments.parseProvider,
      parseProfile: estimateSourceDocuments.parseProfile,
      parseMeasurementsEnabled: estimateSourceDocuments.parseMeasurementsEnabled,
    })
    .from(estimateSourceDocuments)
    .where(
      and(
        eq(estimateSourceDocuments.id, input.documentId),
        eq(estimateSourceDocuments.dealId, input.dealId)
      )
    )
    .limit(1);

  if (!currentDocument) {
    return null;
  }

  // DATA LOSS, refused. Reprocessing means "throw the parse away and derive it again from the file",
  // which is coherent for a plan set and destructive for a walkthrough.
  //
  // A walkthrough document's extractions were not parsed out of its file — they were ingested from
  // TROCK Scope, where a human spoke them (walkthrough-ingress-service.ts). Its "file" is only a
  // contact-sheet image of the evidence frames. Run this function on one and: the UPDATE below clears
  // `active_parse_run_id` and queues the generic OCR worker; the worker parses the CONTACT SHEET,
  // produces filename-derived stubs, and `activateCompletedParseRun`
  // (document-parse-orchestrator.ts:173-182) then rewrites every extraction's `activeArtifact` to
  // `metadata_json->>'sourceParseRunId' = <new run>`. The real walkthrough rows do not match the new
  // run, so all of them flip to inactive and vanish from the workbench
  // (workbench-service.ts:153-172), replaced by priced stubs invented from an image filename. The
  // scope an estimator collected on site is silently gone, and nothing sweeps it back.
  //
  // Refused rather than made safe: the correct way to rebuild these rows is to re-ingest the
  // walkthrough from TROCK Scope, which is idempotent on (deal, walkthrough) and rewrites them from
  // the source of truth. There is nothing for a re-parse to recover here.
  if (currentDocument.documentType === "walkthrough") {
    throw new AppError(
      400,
      `Document ${input.documentId} is a TROCK Scope walkthrough and cannot be reprocessed. Its ` +
        `scope rows were ingested from the walkthrough, not parsed out of its contact-sheet image, so ` +
        `re-parsing would replace them with stubs derived from the image filename and hide the real ` +
        `rows. Re-ingest the walkthrough from TROCK Scope to rebuild them.`
    );
  }

  const nextParseProvider =
    input.parseProvider != null
      ? normalizeParseOption(input.parseProvider, "default")
      : normalizeParseOption(currentDocument.parseProvider, "default");
  const nextParseProfile =
    input.parseProfile != null
      ? normalizeParseOption(input.parseProfile, "balanced")
      : normalizeParseOption(currentDocument.parseProfile, "balanced");
  const nextParseMeasurementsEnabled =
    input.parseMeasurementsEnabled ?? currentDocument.parseMeasurementsEnabled ?? false;

  const [document] = await tenantDb
    .update(estimateSourceDocuments)
    .set({
      parseStatus: "queued",
      activeParseRunId: null,
      parseProfile: nextParseProfile,
      parseProvider: nextParseProvider,
      parseMeasurementsEnabled: nextParseMeasurementsEnabled,
      parseErrorSummary: null,
      ocrStatus: "queued",
      parsedAt: null,
    })
    .where(
      and(
        eq(estimateSourceDocuments.id, input.documentId),
        eq(estimateSourceDocuments.dealId, input.dealId)
      )
    )
    .returning();

  if (!document) {
    return null;
  }

  await enqueueEstimateDocumentOcr({
    documentId: document.id,
    dealId: document.dealId,
    officeId: input.officeId,
    parseProvider: document.parseProvider,
    parseProfile: document.parseProfile,
    parseMeasurementsEnabled: document.parseMeasurementsEnabled,
  });

  return document;
}
