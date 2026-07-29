// Walkthrough ingress: turning a TROCK Scope job-site walkthrough into estimating rows.
//
// `estimate_extractions.document_id` is NOT NULL with an FK to `estimate_source_documents`, which in
// turn requires a `files` row — so a walkthrough has to synthesize a document chain before its scope
// rows can land. The synthetic "document" is a contact-sheet image of the walkthrough's evidence
// frames: a real artifact a human can open, and `image/*` is one of only two mime families the
// estimating path accepts. This module builds that chain link by link: the `files` row, then the
// already-parsed source document and its activated parse run.
import { eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "@trock-crm/shared/schema";
import {
  estimateDocumentParseRuns,
  estimateExtractions,
  estimateSourceDocuments,
  files,
} from "@trock-crm/shared/schema";
import type { WalkthroughScopeRow } from "@trock-crm/shared/types";
import { resolvePricingScopeFromExtraction } from "./pricing-service.js";

/** Same alias document-service.ts:6 uses. */
type TenantDb = NodePgDatabase<typeof schema>;

/** Narrow, storage-shaped input for ONE link of the chain; `WalkthroughIngressPayload`'s wire names
 *  (contactSheetR2Key/…) are mapped onto it in `ingestWalkthrough`. */
export interface CreateWalkthroughContactSheetFileArgs {
  tenantDb: TenantDb;
  input: {
    dealId: string;
    walkthroughId: string;
    siteLabel: string;
    r2Key: string;
    r2Bucket: string;
    bytes: number;
    mimeType: "image/jpeg" | "application/pdf";
    userId: string;
  };
}

/** Keyed off the args' own mime union, so adding a third accepted mime type is a compile error here
 *  rather than an `undefined` extension at runtime. */
type ContactSheetMimeType = CreateWalkthroughContactSheetFileArgs["input"]["mimeType"];

const EXTENSION_BY_MIME: Record<ContactSheetMimeType, string> = {
  "image/jpeg": "jpg",
  "application/pdf": "pdf",
};

export async function createWalkthroughContactSheetFile({
  tenantDb,
  input,
}: CreateWalkthroughContactSheetFileArgs): Promise<string> {
  const extension = EXTENSION_BY_MIME[input.mimeType];
  const systemFilename = `walkthrough-${input.walkthroughId}.${extension}`;

  const [row] = await tenantDb
    .insert(files)
    .values({
      dealId: input.dealId,
      // FILE_CATEGORIES has no "estimating" member; "estimate" is the estimating-path category and
      // adding an enum value would require a migration. See shared/src/types/enums.ts.
      category: "estimate",
      displayName: `Walkthrough evidence — ${input.siteLabel}`,
      systemFilename,
      originalFilename: systemFilename,
      mimeType: input.mimeType,
      fileSizeBytes: input.bytes,
      fileExtension: extension,
      r2Key: input.r2Key,
      r2Bucket: input.r2Bucket,
      uploadedBy: input.userId,
      isActive: true,
    })
    .returning({ id: files.id });

  return row.id;
}

/** Second link of the chain. Narrow input as above; the `WalkthroughIngressPayload` mapping lives in
 *  `ingestWalkthrough`. */
export interface CreateWalkthroughSourceDocumentArgs {
  tenantDb: TenantDb;
  input: {
    dealId: string;
    projectId: string | null;
    fileId: string;
    walkthroughId: string;
    siteLabel: string;
    capturedAt: string;
    mimeType: ContactSheetMimeType;
    storageKey: string;
    bytes: number;
    userId: string;
  };
}

/**
 * Create the source document a walkthrough's extractions hang off — already parsed.
 *
 * `createEstimateSourceDocument` (document-service.ts:99) cannot be reused: it hardcodes
 * `parseStatus: "queued"` / `activeParseRunId: null` and enqueues an OCR job that would re-derive
 * filename stubs over an image whose real content is a transcript we already have. A walkthrough
 * arrives with its parse ALREADY DONE upstream in trock-scope, so the document is born `completed`
 * with a completed parse run made active — which is the state workbench-service.ts:153-172 requires
 * before it will show any of the walkthrough's rows.
 */
export async function createWalkthroughSourceDocument({
  tenantDb,
  input,
}: CreateWalkthroughSourceDocumentArgs): Promise<{ documentId: string; parseRunId: string }> {
  const [document] = await tenantDb
    .insert(estimateSourceDocuments)
    .values({
      dealId: input.dealId,
      projectId: input.projectId,
      fileId: input.fileId,
      rootFileId: input.fileId,
      documentType: "walkthrough",
      filename: `Walkthrough ${input.siteLabel} ${input.capturedAt}`,
      storageKey: input.storageKey,
      mimeType: input.mimeType,
      fileSize: input.bytes,
      // Deliberate: the walkthrough id IS the content hash. document-service.ts:104-130 dedupes on
      // (dealId, projectId, contentHash), so re-ingesting the same walkthrough becomes detectable
      // rather than silently producing a second document and a duplicate set of extractions.
      contentHash: input.walkthroughId,
      parseStatus: "completed",
      ocrStatus: "completed",
      parseProvider: "trock-scope",
      parseProfile: "walkthrough",
      parseMeasurementsEnabled: false,
      parsedAt: new Date(),
      uploadedByUserId: input.userId,
    })
    .returning({ id: estimateSourceDocuments.id });

  const [parseRun] = await tenantDb
    .insert(estimateDocumentParseRuns)
    .values({
      documentId: document.id,
      status: "completed",
      parseProvider: "trock-scope",
      parseProfile: "walkthrough",
      parseMeasurementsEnabled: false,
      completedAt: new Date(),
    })
    .returning({ id: estimateDocumentParseRuns.id });

  // The run can only be pointed at after it exists (the FK runs document -> run), so activation is a
  // second statement rather than part of the insert above.
  await tenantDb
    .update(estimateSourceDocuments)
    .set({ activeParseRunId: parseRun.id })
    .where(eq(estimateSourceDocuments.id, document.id));

  return { documentId: document.id, parseRunId: parseRun.id };
}

/** Third link of the chain. Narrow input as above; the `WalkthroughIngressPayload` mapping lives in
 *  `ingestWalkthrough`. */
export interface InsertWalkthroughExtractionsArgs {
  tenantDb: TenantDb;
  input: {
    dealId: string;
    projectId: string | null;
    documentId: string;
    parseRunId: string;
    walkthroughId: string;
    rows: WalkthroughScopeRow[];
  };
}

/**
 * Write a walkthrough's scope rows as `estimate_extractions`.
 *
 * A row is only USEFUL if it clears four independent gates, none of which the schema enforces — miss
 * any one and the row lands in the table but is invisible to everything downstream:
 *   1. `status = 'pending'` — estimate-generation.ts:256-261 filters candidates on it.
 *   2. `metadataJson.activeArtifact = "true"` as a STRING — estimate-generation.ts:262 compares with
 *      `->>`, which yields text.
 *   3. `metadataJson.sourceParseRunId` equal to the document's `activeParseRunId` —
 *      workbench-service.ts:153-172 hides the row otherwise.
 *   4. a resolved pricing scope, via the SAME resolver extraction-service.ts uses, so walkthrough rows
 *      price on an identical basis to parsed-document ones.
 */
export async function insertWalkthroughExtractions({
  tenantDb,
  input,
}: InsertWalkthroughExtractionsArgs): Promise<string[]> {
  if (input.rows.length === 0) return [];

  const inserted = await tenantDb
    .insert(estimateExtractions)
    .values(
      input.rows.map((row) => ({
        dealId: input.dealId,
        projectId: input.projectId,
        documentId: input.documentId,
        // A contact sheet is not paginated the way a plan set is; there is no page to point at.
        pageId: null,
        extractionType: "scope_utterance",
        rawLabel: row.rawLabel,
        normalizedLabel: row.rawLabel.toLowerCase(),
        // numeric columns take strings — the same convention extraction-service.ts writes with. `null`
        // stays null: "no quantity was spoken" must not collapse into "zero of it".
        quantity: row.quantity === null ? null : String(row.quantity),
        unit: row.unit,
        divisionHint: row.divisionHint,
        confidence: row.confidence.toFixed(2),
        evidenceText: row.evidenceText,
        // Temporal evidence occupies the bbox column wholesale: a spoken utterance has a clip and a
        // timeline offset, not a rectangle on a page.
        evidenceBboxJson: {
          clipId: row.evidence.clipId,
          timelineMs: row.evidence.timelineMs,
          frameKey: row.evidence.frameKey,
        },
        status: "pending",
        metadataJson: {
          activeArtifact: "true",
          sourceParseRunId: input.parseRunId,
          sourceWalkthroughId: input.walkthroughId,
          sourceScopeItemId: row.sourceScopeItemId,
          locationLabel: row.locationLabel,
          extractionProvider: "trock-scope",
          extractionMethod: "walkthrough_grounding",
          ...resolvePricingScopeFromExtraction({
            divisionHint: row.divisionHint,
            metadataJson: {},
            normalizedIntent: row.rawLabel,
            rawLabel: row.rawLabel,
          }),
        },
      }))
    )
    .returning({ id: estimateExtractions.id });

  return inserted.map((r) => r.id);
}
