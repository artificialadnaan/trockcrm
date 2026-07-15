import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import { fieldScorecardEditUploads, files } from "@trock-crm/shared/schema";
import { confirmUpload } from "../../../src/modules/files/service.js";
import { tenantSchemaSql } from "../../helpers/tenant-schema-from-drizzle.js";

const USER = "11111111-1111-1111-1111-111111111111";
const DEAL = "22222222-2222-2222-2222-222222222222";
const CARD_1 = "33333333-3333-3333-3333-333333333333";
const CARD_2 = "44444444-4444-4444-4444-444444444444";
const FILE = "55555555-5555-5555-5555-555555555555";
const CLIENT_UPLOAD = "scope-runtime-1";

let pg: PGlite;
let tdb: ReturnType<typeof drizzle>;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(tenantSchemaSql("public", [files, fieldScorecardEditUploads]));
  tdb = drizzle(pg);
});

afterAll(async () => {
  await pg?.close?.();
});

beforeEach(async () => {
  await tdb.delete(fieldScorecardEditUploads);
  await tdb.delete(files);
  await tdb.insert(files).values({
    id: FILE,
    category: "photo",
    displayName: "Existing evidence",
    systemFilename: "existing-evidence.jpg",
    originalFilename: "existing-evidence.jpg",
    mimeType: "image/jpeg",
    fileSizeBytes: 100,
    fileExtension: ".jpg",
    r2Key: "office_test/deals/existing-evidence.jpg",
    r2Bucket: "test",
    dealId: DEAL,
    clientUploadId: CLIENT_UPLOAD,
    uploadedBy: USER,
  });
});

async function confirmForCard(scorecardId: string) {
  return confirmUpload(tdb as never, USER, {
    uploadToken: "already-consumed",
    clientUploadId: CLIENT_UPLOAD,
    scorecardEditScope: { scorecardId, clientUploadId: CLIENT_UPLOAD },
    scorecardEditDealId: DEAL,
  });
}

describe("confirmUpload submitted-scorecard evidence scope (runtime)", () => {
  it("does not adopt an ordinary same-user file or make it eligible for edit cleanup", async () => {
    await tdb.insert(fieldScorecardEditUploads).values({
      scorecardId: CARD_1,
      dealId: DEAL,
      clientUploadId: CLIENT_UPLOAD,
      uploadedBy: USER,
      state: "authorized",
    });

    await expect(confirmForCard(CARD_1)).rejects.toMatchObject({
      statusCode: 409,
      code: "SCORECARD_EDIT_UPLOAD_SCOPE",
    });

    const [binding] = await tdb
      .select()
      .from(fieldScorecardEditUploads)
      .where(eq(fieldScorecardEditUploads.clientUploadId, CLIENT_UPLOAD));
    expect(binding).toMatchObject({ state: "authorized", fileId: null });
  });

  it("rejects an existing file recorded by a different card binding", async () => {
    await tdb.insert(fieldScorecardEditUploads).values({
      scorecardId: CARD_2,
      dealId: DEAL,
      clientUploadId: CLIENT_UPLOAD,
      uploadedBy: USER,
      fileId: FILE,
      state: "confirmed",
    });

    await expect(confirmForCard(CARD_1)).rejects.toMatchObject({
      statusCode: 409,
      code: "SCORECARD_EDIT_UPLOAD_SCOPE",
    });
  });

  it("returns the existing file for an exact confirmed binding retry", async () => {
    await tdb.insert(fieldScorecardEditUploads).values({
      scorecardId: CARD_1,
      dealId: DEAL,
      clientUploadId: CLIENT_UPLOAD,
      uploadedBy: USER,
      fileId: FILE,
      state: "confirmed",
    });

    await expect(confirmForCard(CARD_1)).resolves.toMatchObject({
      created: false,
      file: { id: FILE, clientUploadId: CLIENT_UPLOAD, uploadedBy: USER, dealId: DEAL },
    });
    const [binding] = await tdb
      .select()
      .from(fieldScorecardEditUploads)
      .where(eq(fieldScorecardEditUploads.clientUploadId, CLIENT_UPLOAD));
    expect(binding).toMatchObject({ state: "confirmed", fileId: FILE });
  });
});
