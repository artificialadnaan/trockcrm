// Walkthrough ingress: turning a TROCK Scope job-site walkthrough into estimating rows.
//
// `estimate_extractions.document_id` is NOT NULL with an FK to `estimate_source_documents`, which in
// turn requires a `files` row — so a walkthrough has to synthesize a document chain before its scope
// rows can land. The synthetic "document" is a contact-sheet image of the walkthrough's evidence
// frames: a real artifact a human can open, and `image/*` is one of only two mime families the
// estimating path accepts. This module builds the first link of that chain, the `files` row.
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "@trock-crm/shared/schema";
import { files } from "@trock-crm/shared/schema";

/** Same alias document-service.ts:6 uses. */
type TenantDb = NodePgDatabase<typeof schema>;

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

const EXTENSION_BY_MIME: Record<string, string> = {
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
