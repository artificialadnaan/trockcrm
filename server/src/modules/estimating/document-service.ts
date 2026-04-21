import { and, eq, isNull, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "@trock-crm/shared/schema";
import { estimateSourceDocuments } from "@trock-crm/shared/schema";

type TenantDb = NodePgDatabase<typeof schema>;

export interface CreateEstimateSourceDocumentArgs {
  tenantDb: TenantDb;
  enqueueEstimateDocumentOcr: (payload: {
    documentId: string;
    dealId: string;
    officeId: string | null;
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

export async function enqueueEstimateDocumentOcrJob(
  tenantDb: TenantDb,
  payload: {
    documentId: string;
    dealId: string;
    officeId: string | null;
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

  const nextParseProvider = input.parseProvider ?? currentDocument.parseProvider ?? null;
  const nextParseProfile = input.parseProfile ?? currentDocument.parseProfile ?? null;
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
    parseMeasurementsEnabled: document.parseMeasurementsEnabled,
  });

  return document;
}
